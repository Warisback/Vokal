"""The guard against shared/guard_cases.json, plus the segment-level no-speech rule."""

from __future__ import annotations

import logging
from dataclasses import asdict

import pytest

from vokal import guard
from vokal.guard import clean_segments, guard_text, guard_utterance, level_dbfs, pre_check, tidy


def as_case(result: guard.GuardResult) -> tuple[str, list[dict]]:
    """A GuardResult in the shape the case file uses."""
    return result.text, [asdict(entry) for entry in result.removed]


def build_signal(case: dict) -> list[float]:
    """Zeros, with +amplitude at even and -amplitude at odd indices inside each burst."""
    samples = [0.0] * case["samples"]
    for burst in case["bursts"]:
        for index in range(burst["start"], burst["start"] + burst["length"]):
            samples[index] = burst["amplitude"] if index % 2 == 0 else -burst["amplitude"]
    return samples


# Shared cases


def test_text_case(text_case):
    assert as_case(guard_text(text_case["input"])) == (text_case["expected"], text_case["removed"])


def test_utterance_case(utterance_case):
    result = guard_utterance(utterance_case["text"], utterance_case["no_speech_prob"])
    assert as_case(result) == (utterance_case["expected"], utterance_case["removed"])


def test_utterance_case_as_one_segment(utterance_case, make_segment):
    segment = make_segment(utterance_case["text"], utterance_case["no_speech_prob"])
    assert as_case(clean_segments([segment])) == (utterance_case["expected"], utterance_case["removed"])


def test_level_case(level_case):
    level = level_dbfs(build_signal(level_case), level_case["rate"])
    assert level == pytest.approx(level_case["expected_dbfs"], abs=0.01)


def test_precheck_case(precheck_case):
    assert pre_check(precheck_case["duration_s"], precheck_case["level_dbfs"]) == precheck_case["expected"]


def test_constants_match_the_shared_file(guard_cases):
    constants = guard_cases["constants"]
    assert list(guard.FILLER_PHRASES) == constants["filler_phrases"]
    assert list(guard.CREDIT_SUBSTRINGS) == constants["credit_substrings"]
    assert guard.NO_SPEECH_PROB_MAX == constants["no_speech_prob_max"]
    assert guard.MIN_SECONDS == constants["min_seconds"]
    assert guard.MIN_LEVEL_DBFS == constants["min_level_dbfs"]
    assert guard.SILENCE_LEVEL_DBFS == constants["silence_level_dbfs"]
    assert guard.LEVEL_FRAME_MS == constants["level_frame_ms"]


# Segment-level no-speech rule


def test_segment_at_max_is_kept_and_above_max_is_dropped(make_segment):
    result = clean_segments([make_segment(" I want water.", 0.6), make_segment(" Open the window.", 0.6001)])
    assert as_case(result) == ("I want water.", [{"text": "Open the window.", "rule": "no_speech"}])


def test_segment_removals_come_before_text_removals(make_segment):
    result = clean_segments([make_segment(" I want water. Thank you.", 0.02), make_segment(" you", 0.9)])
    assert as_case(result) == (
        "I want water.",
        [{"text": "you", "rule": "no_speech"}, {"text": "Thank you.", "rule": "filler"}],
    )


def test_trailing_filler_segment_without_punctuation_is_removed(make_segment):
    result = clean_segments([make_segment(" I want water", 0.02), make_segment(" Thank you", 0.02)])
    assert as_case(result) == ("I want water", [{"text": "Thank you", "rule": "filler"}])
    # The line break between segments is what makes this work: as one run of
    # text, the same words are a single sentence and are kept.
    assert guard_text(" I want water Thank you").text == "I want water Thank you"


def test_empty_segment_texts_are_skipped_silently(make_segment):
    result = clean_segments([make_segment("", 0.95), make_segment("  ", 0.95), make_segment(" Yes.", 0.05)])
    assert as_case(result) == ("Yes.", [])


def test_missing_segment_score_skips_the_score_rule(make_segment):
    assert as_case(clean_segments([make_segment(" Help.", None)])) == ("Help.", [])


def test_custom_no_speech_max(make_segment):
    segments = [make_segment(" Stop.", 0.5)]
    assert clean_segments(segments, no_speech_max=0.4).text == ""
    assert guard_utterance(" Stop.", 0.5, no_speech_max=0.4).text == ""


def test_no_segments(make_segment):
    assert as_case(clean_segments([])) == ("", [])


# Logging


def test_removals_are_logged_at_debug(caplog, make_segment):
    caplog.set_level(logging.DEBUG, logger="vokal.guard")
    clean_segments([make_segment(" I want water. Thank you.", 0.02), make_segment(" you", 0.9)])
    records = [record for record in caplog.records if record.name == "vokal.guard"]
    assert len(records) == 2
    assert all(record.levelno == logging.DEBUG for record in records)
    assert "no_speech" in records[0].getMessage() and "0.900" in records[0].getMessage()


def test_nothing_is_logged_at_info(caplog, make_segment):
    caplog.set_level(logging.INFO, logger="vokal.guard")
    clean_segments([make_segment(" [Music] Thank you.", 0.02), make_segment(" you", 0.9)])
    guard_utterance(" you", 0.95)
    assert [record for record in caplog.records if record.name == "vokal.guard"] == []


# Helpers


def test_tidy_line_breaks_and_nbsp():
    assert tidy("  I want\r\n\u00a0water.\n ") == "I want water."


def test_tidy_does_not_treat_next_line_as_whitespace():
    # Python's \s matches U+0085; JavaScript's does not, and the guards must agree.
    assert tidy("a\u0085b") == "a\u0085b"


def test_level_of_a_numpy_like_array():
    class ArrayLike:
        def __init__(self, values):
            self.values = values

        def tolist(self):
            return list(self.values)

    assert level_dbfs(ArrayLike([0.1, -0.1] * 240), 16000) == pytest.approx(-20.0, abs=0.01)
