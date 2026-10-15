"""Text to speech with a local Piper voice. No network, no account, no voice cloning.

A voice is an .onnx file with its .onnx.json config beside it. Voices live
outside the repo, in the folder given by --voice-dir or VOKAL_PIPER_VOICE_DIR.
piper-tts is imported only when a voice is loaded.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .audio import play_pcm16, write_wav

TTS_EXTRA_HINT = 'Install the text to speech extra: pip install "vokal[tts]".'


class TtsError(RuntimeError):
    """Text to speech could not run. The message is one line."""


def available_voices(voice_dir: str | os.PathLike) -> list[str]:
    """Voice names (without .onnx) in a folder."""
    try:
        return sorted(entry.name[: -len(".onnx")] for entry in os.scandir(voice_dir) if entry.name.endswith(".onnx"))
    except OSError:
        return []


def _load_piper(model_path: str) -> Any:
    try:
        from piper import PiperVoice
    except ImportError as exc:
        raise TtsError(f"piper-tts could not be imported ({exc}). {TTS_EXTRA_HINT}") from exc
    return PiperVoice.load(model_path)


class Voice:
    def __init__(
        self,
        name: str = "en_GB-cori-high",
        voice_dir: str | os.PathLike | None = None,
        loader: Callable[[str], Any] | None = None,
    ) -> None:
        self.name = name
        self.voice_dir = Path(voice_dir).expanduser() if voice_dir else None
        self._loader = loader or _load_piper
        self._piper: Any = None
        self._lock = threading.Lock()

    def load(self) -> str | None:
        """Load the voice once. Returns an error message instead of raising."""
        with self._lock:
            if self._piper is not None:
                return None
            if self.voice_dir is None:
                return "no voice folder is set. Pass --voice-dir or set VOKAL_PIPER_VOICE_DIR."
            model = self.voice_dir / f"{self.name}.onnx"
            if not model.is_file():
                have = available_voices(self.voice_dir)
                listing = ", ".join(have) if have else "none"
                return f"Piper voice not found: {model}. Voices in {self.voice_dir}: {listing}."
            config = model.with_name(model.name + ".json")
            if not config.is_file():
                return f"Piper voice config missing: {config} must sit beside {model.name}."
            try:
                self._piper = self._loader(str(model))
            except TtsError as exc:
                return str(exc)
            except Exception as exc:
                lines = str(exc).strip().splitlines()
                return f"could not load the voice {self.name}: {lines[0] if lines else type(exc).__name__}"
            return None

    def synthesize(self, text: str) -> tuple[bytes, int]:
        """Return (16-bit mono PCM bytes, sample rate) for the text."""
        problem = self.load()
        if problem:
            raise TtsError(problem)
        pcm = bytearray()
        rate = 0
        for chunk in self._piper.synthesize(text):  # one chunk per sentence
            rate = chunk.sample_rate
            pcm += chunk.audio_int16_bytes
        if not pcm or not rate:
            raise TtsError("Piper produced no audio for this text.")
        return bytes(pcm), rate


def speak(
    voice: Voice,
    text: str,
    *,
    out: str | os.PathLike | None = None,
    output_device: int | str | None = None,
) -> dict:
    """Synthesise the text, then write it to a WAV file (out) or play it and wait.

    Returns the timings and the length of the audio.
    """
    text = text.strip()
    if not text:
        raise TtsError("there is nothing to speak.")
    started = time.perf_counter()
    pcm, rate = voice.synthesize(text)
    tts_done = time.perf_counter()
    result: dict[str, Any] = {
        "tts_ms": round((tts_done - started) * 1000),
        "audio_s": len(pcm) / (2 * rate),
        "rate": rate,
        "out": os.fspath(out) if out is not None else None,
    }
    if out is not None:
        write_wav(out, pcm, rate)
        result["write_ms"] = round((time.perf_counter() - tts_done) * 1000)
    else:
        play_pcm16(pcm, rate, device=output_device)
        result["play_ms"] = round((time.perf_counter() - tts_done) * 1000)
    return result
