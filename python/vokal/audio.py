"""WAV files (standard library) and blocking playback (sounddevice, imported lazily).

Playback takes 16-bit PCM bytes through a RawOutputStream, so it needs no numpy.
"""

from __future__ import annotations

import os
import wave

AUDIO_EXTRA_HINT = 'Install the audio extra: pip install "vokal[audio]", or write a file with --out.'


class AudioError(RuntimeError):
    """Audio could not be read or played. The message is one line."""


def read_wav(path: str | os.PathLike) -> tuple[bytes, int, int]:
    """Return (16-bit PCM bytes, sample rate, channels)."""
    with wave.open(os.fspath(path), "rb") as wav:
        if wav.getsampwidth() != 2:
            raise AudioError(f"{path} is not 16-bit PCM")
        return wav.readframes(wav.getnframes()), wav.getframerate(), wav.getnchannels()


def write_wav(path: str | os.PathLike, pcm16: bytes, rate: int, channels: int = 1) -> None:
    with wave.open(os.fspath(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm16)


def play_pcm16(pcm16: bytes, rate: int, *, device: int | str | None = None) -> None:
    """Play mono 16-bit PCM on the speakers and block until it has finished."""
    try:
        import sounddevice
    except ImportError as exc:
        raise AudioError(f"sounddevice is not installed. {AUDIO_EXTRA_HINT}") from exc
    if len(pcm16) % 2:
        pcm16 = pcm16[:-1]  # a half sample cannot be played
    stream = sounddevice.RawOutputStream(samplerate=rate, channels=1, dtype="int16", device=device)
    try:
        stream.start()
        stream.write(pcm16)
        stream.stop()  # returns once the buffered audio has played
    finally:
        stream.close()
