"""WAV round trip and playback with a fake sounddevice module."""

from __future__ import annotations

import math
import struct
import sys
import types
import wave

import pytest

from vokal.audio import AudioError, play_pcm16, read_wav, write_wav


def sine_pcm(seconds: float = 0.5, rate: int = 16000, freq: float = 220.0, amp: int = 8000) -> bytes:
    """A 16-bit mono sine tone as little-endian PCM bytes."""
    count = int(seconds * rate)
    return b"".join(struct.pack("<h", int(amp * math.sin(2.0 * math.pi * freq * i / rate))) for i in range(count))


class FakeStream:
    def __init__(self, fail_on_write: bool = False, **settings) -> None:
        self.settings = settings
        self.fail_on_write = fail_on_write
        self.events: list[str] = []
        self.written = b""

    def start(self):
        self.events.append("start")

    def write(self, data):
        if self.fail_on_write:
            raise RuntimeError("device unplugged")
        self.written += bytes(data)
        self.events.append("write")

    def stop(self):
        self.events.append("stop")

    def close(self):
        self.events.append("close")


def install_fake_sounddevice(monkeypatch, fail_on_write: bool = False) -> list[FakeStream]:
    streams: list[FakeStream] = []

    def raw_output_stream(**settings):
        stream = FakeStream(fail_on_write=fail_on_write, **settings)
        streams.append(stream)
        return stream

    module = types.ModuleType("sounddevice")
    module.RawOutputStream = raw_output_stream
    monkeypatch.setitem(sys.modules, "sounddevice", module)
    return streams


def test_wav_round_trip(tmp_path):
    pcm = sine_pcm()
    path = tmp_path / "tone.wav"
    write_wav(path, pcm, 16000)
    assert read_wav(path) == (pcm, 16000, 1)


def test_wav_round_trip_stereo(tmp_path):
    pcm = sine_pcm(seconds=0.1, rate=48000) * 2
    path = tmp_path / "stereo.wav"
    write_wav(path, pcm, 48000, channels=2)
    assert read_wav(path) == (pcm, 48000, 2)


def test_read_wav_refuses_8_bit(tmp_path):
    path = tmp_path / "eight.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(1)
        wav.setframerate(8000)
        wav.writeframes(b"\x80" * 800)
    with pytest.raises(AudioError, match="16-bit"):
        read_wav(path)


def test_play_opens_a_mono_int16_stream_and_writes_every_byte(monkeypatch):
    streams = install_fake_sounddevice(monkeypatch)
    pcm = sine_pcm(rate=22050)
    play_pcm16(pcm, 22050, device=3)
    (stream,) = streams
    assert stream.settings == {"samplerate": 22050, "channels": 1, "dtype": "int16", "device": 3}
    assert stream.written == pcm
    assert stream.events == ["start", "write", "stop", "close"]


def test_play_drops_a_trailing_half_sample(monkeypatch):
    streams = install_fake_sounddevice(monkeypatch)
    play_pcm16(b"\x01\x00\x02", 16000)
    assert streams[0].written == b"\x01\x00"


def test_stream_is_closed_when_writing_raises(monkeypatch):
    streams = install_fake_sounddevice(monkeypatch, fail_on_write=True)
    with pytest.raises(RuntimeError, match="unplugged"):
        play_pcm16(sine_pcm(), 16000)
    assert streams[0].events == ["start", "close"]


def test_missing_sounddevice_names_the_extra(monkeypatch):
    monkeypatch.setitem(sys.modules, "sounddevice", None)  # makes the import fail
    with pytest.raises(AudioError, match=r"vokal\[audio\]"):
        play_pcm16(sine_pcm(), 16000)
