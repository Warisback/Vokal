"""Hallucination guard: removes text that Whisper invents. It never adds words.

Whisper turns silence and noise into text such as " you" or "Thank you.". Vokal
speaks for someone who cannot correct it out loud, so an invented sentence is
the worst failure it has. The guard runs before anything is shown or spoken,
and every removal is reported with its rule.

The rules match app/js/guard.js. Both are tested against shared/guard_cases.json.
Standard library only, so evaluation code can import it without the speech extras.
"""

from __future__ import annotations

import logging
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

log = logging.getLogger("vokal.guard")

FILLER_PHRASES: tuple[str, ...] = (
    "thank you",
    "thanks for watching",
    "please subscribe",
    "you",
    "bye",
    "thanks",
    "thank you for watching",
    "subscribe",
    "goodbye",
)
CREDIT_SUBSTRINGS: tuple[str, ...] = ("subtitles by", "amara.org", "www.")
NO_SPEECH_PROB_MAX = 0.6  # drop when strictly greater
MIN_SECONDS = 0.3
MIN_LEVEL_DBFS = -60.0  # loudest 30 ms frame
SILENCE_LEVEL_DBFS = -120.0  # every sample exactly zero
LEVEL_FRAME_MS = 30

_FILLER = frozenset(FILLER_PHRASES)

# JavaScript's \s, written out so both guards split text the same way.
# Python's own \s also matches U+001C to U+001F and U+0085.
_WS = "\t\n\x0b\x0c\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS_RUN = re.compile(f"[{_WS}]+")
_LINE_BREAKS = re.compile(r"[\r\n]+")
_SENTENCE_END = re.compile(f"([.!?\u2026])[{_WS}]+")

# Whisper writes non-speech as tags: [Music], (laughs) and runs of music notes.
_TAG = r"\[[^\[\]]*\]|\([^()]*\)|[\u266a\u266b\u266c]+"
_TAG_RE = re.compile(_TAG)
# The space before a tag goes with it.
_TAG_WITH_SPACE = re.compile(f"[{_WS}]*(?:{_TAG})")


@dataclass(frozen=True)
class Removed:
    text: str
    rule: str  # no_words | annotation | credit_line | filler | no_speech


@dataclass(frozen=True)
class GuardResult:
    text: str
    removed: tuple[Removed, ...] = ()


def _collapse(text: str) -> str:
    return _WS_RUN.sub(" ", text).strip(" ")


def tidy(text: str) -> str:
    """NFC, every run of whitespace becomes one space, then trimmed."""
    return _collapse(unicodedata.normalize("NFC", text))


def normalise(text: str) -> str:
    """Lower-case letters and digits separated by single spaces."""
    letters = "".join(ch if ch.isalnum() else " " for ch in text.lower())
    return re.sub(" +", " ", letters).strip(" ")


def _pieces(text: str) -> list[str]:
    """Split into sentences at line breaks, and after . ! ? or an ellipsis."""
    pieces = []
    for line in _LINE_BREAKS.split(text):
        # Replacement rather than lookbehind, to match the JavaScript guard.
        for piece in _SENTENCE_END.sub("\\1\n", line).split("\n"):
            piece = _collapse(piece)
            if piece:
                pieces.append(piece)
    return pieces


def guard_text(text: str) -> GuardResult:
    """Apply the text rules: no_words, annotation, credit_line, then trailing filler."""
    kept: list[tuple[int, str]] = []
    removed: list[tuple[int, Removed]] = []

    for index, piece in enumerate(_pieces(unicodedata.normalize("NFC", text))):
        if not normalise(piece):
            removed.append((index, Removed(piece, "no_words")))
            continue
        tags = _TAG_RE.findall(piece)
        rest = _collapse(_TAG_WITH_SPACE.sub("", piece)) if tags else piece
        if not normalise(rest):
            removed.append((index, Removed(piece, "annotation")))
            continue
        removed.extend((index, Removed(tag, "annotation")) for tag in tags)
        if any(credit in rest.lower() for credit in CREDIT_SUBSTRINGS):
            removed.append((index, Removed(rest, "credit_line")))
            continue
        kept.append((index, rest))

    # Filler is removed only at the end. "Thank you" at the start or in the
    # middle is real speech far more often than it is an invention.
    while kept and normalise(kept[-1][1]) in _FILLER:
        index, piece = kept.pop()
        removed.append((index, Removed(piece, "filler")))

    removed.sort(key=lambda entry: entry[0])  # stable, so order within a piece holds
    for _, entry in removed:
        log.debug("removed %r (%s)", entry.text, entry.rule)
    return GuardResult(" ".join(piece for _, piece in kept), tuple(entry for _, entry in removed))


def guard_utterance(
    text: str, no_speech_prob: float | None, no_speech_max: float = NO_SPEECH_PROB_MAX
) -> GuardResult:
    """Drop everything when the model's no-speech score is too high, else apply the text rules.

    A missing score (None) skips the score rule.
    """
    if no_speech_prob is not None and no_speech_prob > no_speech_max:
        heard = tidy(text)
        if not heard:
            return GuardResult("")
        log.debug("removed %r (no_speech, score %.3f)", heard, no_speech_prob)
        return GuardResult("", (Removed(heard, "no_speech"),))
    return guard_text(text)


def clean_segments(segments: Iterable[Any], no_speech_max: float = NO_SPEECH_PROB_MAX) -> GuardResult:
    """Guard faster-whisper segments (anything with .text and .no_speech_prob).

    The score belongs to the 30 s decoding window, so a trailing window decoded
    from silence can be dropped on its own. Kept texts are joined with line
    breaks, so each segment ends a sentence and a trailing "Thank you" segment
    without punctuation is still caught as filler.
    """
    kept: list[str] = []
    dropped: list[Removed] = []
    for segment in segments:
        heard = tidy(segment.text)
        if not heard:
            continue
        score = segment.no_speech_prob
        if score is not None and score > no_speech_max:
            log.debug("removed %r (no_speech, score %.3f)", heard, score)
            dropped.append(Removed(heard, "no_speech"))
            continue
        kept.append(segment.text)
    result = guard_text("\n".join(kept))
    return GuardResult(result.text, tuple(dropped) + result.removed)


def level_dbfs(samples: Sequence[float], rate: int) -> float:
    """Level of the loudest 30 ms frame, in dBFS. Samples are floats in [-1, 1].

    The loudest frame, not whole-clip RMS: one quiet word in a long hold would
    otherwise average out below the floor and never reach the model.
    """
    if hasattr(samples, "tolist"):
        samples = samples.tolist()  # a numpy array: plain floats loop far faster
    count = len(samples)
    if count == 0:
        return SILENCE_LEVEL_DBFS
    frame = max(1, int(rate) * LEVEL_FRAME_MS // 1000)
    loudest = 0.0
    for start in range(0, count, frame):  # fixed frames from sample 0, the last may be short
        chunk = samples[start : start + frame]
        loudest = max(loudest, math.fsum(x * x for x in chunk) / len(chunk))
    return 10 * math.log10(loudest + 1e-12)


def pre_check(duration_s: float, level_dbfs: float) -> str | None:
    """Reasons to skip the model call: "too_short", "no_signal", "too_quiet", or None.

    This is not voice activity detection. Room noise passes and is left to the
    model's no-speech score, because any floor high enough to reject noise would
    also reject quiet speech.
    """
    if duration_s < MIN_SECONDS:
        return "too_short"
    if level_dbfs <= SILENCE_LEVEL_DBFS:
        return "no_signal"
    if level_dbfs < MIN_LEVEL_DBFS:
        return "too_quiet"
    return None
