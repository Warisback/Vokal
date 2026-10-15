"""Voice and speak with a fake Piper loader. No voice files and no sound card needed."""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass

import pytest

from vokal.audio import read_wav
from vokal.tts import TtsError, Voice, available_voices, speak


@dataclass
class FakeChunk:
    sample_rate: int
    audio_int16_bytes: bytes


class FakePiper:
    def __init__(self, chunks):
        self.chunks = chunks
        self.texts: list[str] = []

    def synthesize(self, text):
        self.texts.append(text)
        yield from self.chunks


def voice_dir(tmp_path, *names, config=True):
    for name in names:
        (tmp_path / f"{name}.onnx").write_bytes(b"")
        if config:
            (tmp_path / f"{name}.onnx.json").write_text("{}", encoding="utf-8")
    return tmp_path


def fake_loader(piper, loaded=None):
    def load(path):
        if loaded is not None:
            loaded.append(path)
        return piper

    return load


def test_speak_to_a_file_writes_a_wav_at_the_chunk_rate(tmp_path):
    piper = FakePiper([FakeChunk(22050, b"\x01\x00" * 100), FakeChunk(22050, b"\x02\x00" * 50)])
    loaded = []
    voice = Voice("en_GB-test", voice_dir(tmp_path, "en_GB-test"), loader=fake_loader(piper, loaded))
    out = tmp_path / "speech.wav"
    result = speak(voice, "  Water, please.  ", out=out)
    assert piper.texts == ["Water, please."]
    assert loaded == [str(tmp_path / "en_GB-test.onnx")]
    assert read_wav(out) == (b"\x01\x00" * 100 + b"\x02\x00" * 50, 22050, 1)
    assert result["rate"] == 22050
    assert result["audio_s"] == pytest.approx(150 / 22050)
    assert result["out"] == str(out)
    assert {"tts_ms", "write_ms"} <= result.keys()


def test_speak_plays_when_there_is_no_out_file(tmp_path, monkeypatch):
    written = []

    class Stream:
        def __init__(self, **settings):
            self.settings = settings

        def start(self):
            pass

        def write(self, data):
            written.append((self.settings["samplerate"], bytes(data)))

        def stop(self):
            pass

        def close(self):
            pass

    module = types.ModuleType("sounddevice")
    module.RawOutputStream = Stream
    monkeypatch.setitem(sys.modules, "sounddevice", module)
    piper = FakePiper([FakeChunk(16000, b"\x05\x00" * 10)])
    voice = Voice("v", voice_dir(tmp_path, "v"), loader=fake_loader(piper))
    result = speak(voice, "Yes.")
    assert written == [(16000, b"\x05\x00" * 10)]
    assert "play_ms" in result and result["out"] is None


def test_missing_voice_lists_the_voices_that_exist(tmp_path):
    folder = voice_dir(tmp_path, "en_GB-alba-medium", "en_US-lessac-medium")
    message = Voice("en_GB-cori-high", folder, loader=fake_loader(FakePiper([]))).load()
    assert message.startswith("Piper voice not found")
    assert "en_GB-alba-medium, en_US-lessac-medium" in message


def test_missing_voice_in_an_empty_folder(tmp_path):
    message = Voice("en_GB-cori-high", tmp_path).load()
    assert message.endswith("none.")


def test_missing_config_is_reported_separately(tmp_path):
    folder = voice_dir(tmp_path, "en_GB-cori-high", config=False)
    message = Voice("en_GB-cori-high", folder, loader=fake_loader(FakePiper([]))).load()
    assert message.startswith("Piper voice config missing")
    assert "en_GB-cori-high.onnx.json" in message


def test_no_voice_folder_set():
    assert "VOKAL_PIPER_VOICE_DIR" in Voice("en_GB-cori-high", None).load()


def test_loader_errors_become_one_line(tmp_path):
    def broken(path):
        raise RuntimeError("bad onnx file\ntraceback")

    message = Voice("v", voice_dir(tmp_path, "v"), loader=broken).load()
    assert message == "could not load the voice v: bad onnx file"


def test_no_audio_back_raises(tmp_path):
    voice = Voice("v", voice_dir(tmp_path, "v"), loader=fake_loader(FakePiper([])))
    with pytest.raises(TtsError, match="no audio"):
        voice.synthesize("Hello.")


def test_speak_refuses_empty_text(tmp_path):
    voice = Voice("v", voice_dir(tmp_path, "v"), loader=fake_loader(FakePiper([])))
    with pytest.raises(TtsError, match="nothing to speak"):
        speak(voice, "   ")


def test_synthesize_raises_the_load_message(tmp_path):
    with pytest.raises(TtsError, match="not found"):
        Voice("missing", tmp_path).synthesize("Hello.")


def test_available_voices(tmp_path):
    voice_dir(tmp_path, "b-voice", "a-voice")
    assert available_voices(tmp_path) == ["a-voice", "b-voice"]
    assert available_voices(tmp_path / "nowhere") == []
