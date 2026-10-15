"""Speech to text with faster-whisper.

The model is a faster-whisper size name such as "tiny.en" or "small.en", or a
local CTranslate2 folder. A fine-tuned Whisper (LoRA merged, then converted with
ct2-transformers-converter) drops in through the same setting.

faster-whisper is imported only when a model is loaded or a file is decoded,
so the guard and the command line help run on the standard library alone.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    import numpy

SAMPLE_RATE = 16000
STT_EXTRA_HINT = 'Install the speech to text extra: pip install "vokal[stt]".'


class SttError(RuntimeError):
    """Speech to text could not run. The message is one line."""


@dataclass(frozen=True)
class Segment:
    text: str
    start: float
    end: float
    no_speech_prob: float  # belongs to the 30 s decoding window, not to this segment alone
    avg_logprob: float


@dataclass(frozen=True)
class Transcript:
    segments: tuple[Segment, ...]
    duration_s: float
    infer_ms: int
    model: str

    @property
    def raw_text(self) -> str:
        return "\n".join(segment.text for segment in self.segments)


def _first_line(exc: BaseException) -> str:
    lines = str(exc).strip().splitlines()
    return lines[0] if lines else type(exc).__name__


def _local_model_problem(model: str) -> str | None:
    """A clear message for a local model folder that is missing or incomplete.

    Anything that does not look like a path is left to faster-whisper, which
    takes size names and Hugging Face repo ids.
    """
    path = Path(model).expanduser()
    if path.is_dir():
        if not (path / "model.bin").is_file():
            return f"{path} is not a CTranslate2 model folder (no model.bin)."
        return None
    if path.is_absolute() or model.startswith((".", "~")) or "\\" in model:
        return f"model folder not found: {path}"
    return None


class Stt:
    def __init__(
        self,
        model: str = "small.en",
        device: str = "cpu",
        compute_type: str = "int8",
        beam_size: int = 1,
        language: str | None = "en",
        model_factory: Callable[..., Any] | None = None,
        decoder: Callable[..., Any] | None = None,
    ) -> None:
        self.model = model
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.language = language
        self._model_factory = model_factory  # default: faster_whisper.WhisperModel
        self._decoder = decoder  # default: faster_whisper.decode_audio
        self._whisper: Any = None
        self._lock = threading.Lock()

    def load(self) -> str | None:
        """Load the model once. Returns an error message instead of raising."""
        with self._lock:
            if self._whisper is not None:
                return None
            problem = _local_model_problem(self.model)
            if problem:
                return problem
            factory = self._model_factory
            if factory is None:
                try:
                    from faster_whisper import WhisperModel
                except ImportError as exc:
                    return f"faster-whisper could not be imported ({_first_line(exc)}). {STT_EXTRA_HINT}"
                factory = WhisperModel
            model = self.model
            local = Path(model).expanduser()
            if local.is_dir():
                model = str(local)
            try:
                self._whisper = factory(model, device=self.device, compute_type=self.compute_type)
            except Exception as exc:
                return f"could not load the speech model {self.model}: {_first_line(exc)}"
            return None

    def decode(self, path: str | os.PathLike) -> numpy.ndarray:
        """Read any file faster-whisper can open, as float32 mono samples at 16 kHz.

        faster-whisper decodes with PyAV, whose resampler filters before it
        downsamples. Measured 2026-10-14: a 10 kHz tone in a 48 kHz WAV came out
        111 dB down, where plain decimation left it at full level (folded to
        6 kHz). So this package never resamples by itself.
        """
        if not Path(path).is_file():
            raise SttError(f"no such file: {path}")
        decoder = self._decoder
        if decoder is None:
            try:
                from faster_whisper import decode_audio as decoder
            except ImportError as exc:
                raise SttError(f"faster-whisper could not be imported ({_first_line(exc)}). {STT_EXTRA_HINT}") from exc
        try:
            return decoder(os.fspath(path), sampling_rate=SAMPLE_RATE)
        except Exception as exc:
            raise SttError(f"could not read {path}: {_first_line(exc)}") from exc

    def transcribe(self, audio: Any) -> Transcript:
        """Transcribe float32 samples at 16 kHz, or a path (decoded first)."""
        if isinstance(audio, (str, os.PathLike)):
            audio = self.decode(audio)
        problem = self.load()
        if problem:
            raise SttError(problem)

        started = time.perf_counter()
        try:
            segments, _info = self._whisper.transcribe(
                audio,
                language=self.language,
                # Greedy by default. v1 found beam search bought little on short
                # utterances; that was not measured.
                beam_size=self.beam_size,
                # The press does the segmentation, and VAD trims quiet speech.
                vad_filter=False,
                # Stops one invented segment cascading into the next.
                condition_on_previous_text=False,
                # No initial_prompt, ever. In v1 a prompt came back as transcript
                # text and about 30 s of real speech was lost.
            )
            # The segments are a lazy generator: decoding happens while they are
            # read, so read them inside the timed region.
            kept = tuple(
                Segment(
                    text=segment.text,
                    start=float(segment.start),
                    end=float(segment.end),
                    no_speech_prob=float(segment.no_speech_prob),
                    avg_logprob=float(segment.avg_logprob),
                )
                for segment in segments
            )
        except Exception as exc:
            raise SttError(f"transcription failed: {_first_line(exc)}") from exc
        infer_ms = round((time.perf_counter() - started) * 1000)
        return Transcript(kept, len(audio) / SAMPLE_RATE, infer_ms, self.model)
