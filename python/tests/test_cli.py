"""The command line with a fake speech model and a fake voice."""

from __future__ import annotations

import io
import json
import math
import subprocess
import sys
from array import array
from pathlib import Path

import pytest

from vokal import cli
from vokal.audio import read_wav, write_wav
from vokal.stt import Segment, Stt, Transcript

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
HEAVY_MODULES = ("faster_whisper", "ctranslate2", "av", "piper", "onnxruntime", "sounddevice", "numpy")


class FakeStt:
    """Reads 16 kHz WAVs with the standard library and returns fixed segments."""

    def __init__(self, segments, settings):
        self.segments = tuple(segments)
        self.settings = settings
        self.loaded = False
        self.transcribed = 0

    def decode(self, path):
        pcm, rate, channels = read_wav(path)
        assert (rate, channels) == (16000, 1)
        return [value / 32768 for value in array("h", pcm)]

    def load(self):
        self.loaded = True
        return None

    def transcribe(self, samples):
        self.transcribed += 1
        return Transcript(self.segments, len(samples) / 16000, 12, self.settings["model"])


def stt_factory(*segments):
    created = []

    def factory(**settings):
        engine = FakeStt(segments, settings)
        created.append(engine)
        return engine

    factory.created = created
    return factory


class FakeVoice:
    def __init__(self, name, voice_dir):
        self.name = name
        self.voice_dir = voice_dir
        self.spoken: list[str] = []

    def load(self):
        return None

    def synthesize(self, text):
        self.spoken.append(text)
        return b"\x00\x00" * 2205, 22050


def voice_factory():
    created = []

    def factory(**settings):
        voice = FakeVoice(**settings)
        created.append(voice)
        return voice

    factory.created = created
    return factory


def segment(text, no_speech_prob=0.01, start=0.0, end=1.0, avg_logprob=-0.2):
    return Segment(text, start, end, no_speech_prob, avg_logprob)


def tone_wav(path: Path, seconds: float = 1.0) -> Path:
    count = int(16000 * seconds)
    pcm = array("h", (int(8000 * math.sin(2 * math.pi * 220 * i / 16000)) for i in range(count))).tobytes()
    write_wav(path, pcm, 16000)
    return path


def silent_wav(path: Path, seconds: float = 1.0) -> Path:
    write_wav(path, b"\x00\x00" * int(16000 * seconds), 16000)
    return path


def run(argv, **deps):
    out = io.StringIO()
    code = cli.main(argv, out=out, **deps)
    return code, out.getvalue().splitlines()


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch):
    for name in (
        "VOKAL_WHISPER_MODEL",
        "VOKAL_WHISPER_DEVICE",
        "VOKAL_WHISPER_COMPUTE_TYPE",
        "VOKAL_WHISPER_BEAM_SIZE",
        "VOKAL_PIPER_VOICE",
        "VOKAL_PIPER_VOICE_DIR",
        "VOKAL_OUTPUT_DEVICE",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize("args", [["--help"], ["transcribe", "--help"], ["speak", "--help"], ["say", "--help"]])
def test_help_imports_nothing_heavy(args):
    process = subprocess.run(
        [sys.executable, "-X", "importtime", "-m", "vokal", *args],
        cwd=PACKAGE_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    assert process.stdout.startswith("usage: vokal")
    imported = {
        line.rsplit("|", 1)[-1].strip() for line in process.stderr.splitlines() if line.startswith("import time:")
    }
    assert {name for name in imported if name.split(".")[0] in HEAVY_MODULES} == set()


def test_transcribe_prints_the_guarded_text_removals_and_timings(tmp_path):
    factory = stt_factory(segment(" I want water."), segment(" Thank you."))
    code, lines = run(["transcribe", str(tone_wav(tmp_path / "a.wav")), "--model", "tiny.en"], stt_factory=factory)
    assert code == 0
    assert lines[0] == "I want water."
    assert 'removed: "Thank you." (filler)' in lines
    assert "model: tiny.en (cpu, int8, beam 1)" in lines
    timing = lines[-1]
    assert timing.startswith("timing: decode ")
    assert "model load" in timing and "stt 12 ms" in timing and "guard" in timing and "total" in timing


def test_an_empty_result_prints_didnt_catch_that(tmp_path):
    factory = stt_factory(segment(" you", no_speech_prob=0.9))
    code, lines = run(["transcribe", str(tone_wav(tmp_path / "a.wav"))], stt_factory=factory)
    assert code == 0
    assert lines[0] == "(didn't catch that)"
    assert 'removed: "you" (no_speech)' in lines


def test_silence_prints_no_sound_and_never_runs_the_model(tmp_path):
    factory = stt_factory(segment(" you"))
    code, lines = run(["transcribe", str(silent_wav(tmp_path / "zeros.wav"))], stt_factory=factory)
    assert code == 0
    assert lines[0] == "(no sound in the recording)"
    assert "pre-check: no_signal, so the model was not run" in lines
    (engine,) = factory.created
    assert not engine.loaded and engine.transcribed == 0


def test_a_tap_too_short_is_not_transcribed(tmp_path):
    factory = stt_factory(segment(" you"))
    code, lines = run(["transcribe", str(tone_wav(tmp_path / "tap.wav", seconds=0.1))], stt_factory=factory)
    assert code == 0
    assert lines[0] == "(didn't catch that)"
    assert factory.created[0].transcribed == 0


def test_json_output(tmp_path):
    factory = stt_factory(segment(" I want water.", 0.02, 0.0, 1.0, -0.3), segment(" you", 0.8, 1.0, 1.0, -1.1))
    code, lines = run(["transcribe", str(tone_wav(tmp_path / "a.wav")), "--json"], stt_factory=factory)
    assert code == 0
    assert len(lines) == 1
    result = json.loads(lines[0])
    assert result["text"] == "I want water."
    assert result["raw"] == " I want water.\n you"
    assert result["removed"] == [{"text": "you", "rule": "no_speech"}]
    assert result["segments"][1] == {"text": " you", "start": 1.0, "end": 1.0, "no_speech_prob": 0.8, "avg_logprob": -1.1}
    # A sine peaking at 8000 / 32768 (-12.2 dBFS) has a mean square 3 dB lower.
    assert result["level_dbfs"] == pytest.approx(-15.2, abs=0.1)
    assert result["duration_s"] == 1.0
    assert result["pre_check"] is None
    assert result["model"] == "small.en"
    assert {"decode_ms", "load_ms", "stt_ms", "guard_ms", "total_ms"} <= result["timing_ms"].keys()


def test_segments_flag(tmp_path):
    factory = stt_factory(segment(" Hello.", 0.006, 0.0, 1.0, -0.21))
    _, lines = run(["transcribe", str(tone_wav(tmp_path / "a.wav")), "--segments"], stt_factory=factory)
    assert 'segment 0.00-1.00 s  no_speech_prob 0.006  avg_logprob -0.210  "Hello."' in lines


def test_no_speech_max_flag(tmp_path):
    factory = stt_factory(segment(" Stop.", 0.5))
    _, lines = run(["transcribe", str(tone_wav(tmp_path / "a.wav")), "--no-speech-max", "0.4"], stt_factory=factory)
    assert lines[0] == "(didn't catch that)"


def test_flags_override_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("VOKAL_WHISPER_MODEL", "base.en")
    monkeypatch.setenv("VOKAL_WHISPER_BEAM_SIZE", "3")
    factory = stt_factory(segment(" Yes."))
    run(["transcribe", str(tone_wav(tmp_path / "a.wav"))], stt_factory=factory)
    assert factory.created[0].settings["model"] == "base.en"
    assert factory.created[0].settings["beam_size"] == 3
    run(["transcribe", str(tone_wav(tmp_path / "a.wav")), "--model", "/models/vokal-ct2"], stt_factory=factory)
    assert factory.created[1].settings["model"] == "/models/vokal-ct2"


def test_say_speaks_the_guarded_text(tmp_path):
    voices = voice_factory()
    out = tmp_path / "said.wav"
    code, lines = run(
        ["say", str(tone_wav(tmp_path / "a.wav")), "--voice-dir", str(tmp_path), "--out", str(out)],
        stt_factory=stt_factory(segment(" I want water."), segment(" Thank you.")),
        voice_factory=voices,
    )
    assert code == 0
    assert voices.created[0].spoken == ["I want water."]
    assert read_wav(out)[1] == 22050
    assert any(line.startswith(f"wrote {out}") for line in lines)
    assert "voice load" in lines[-1] and "tts" in lines[-1] and "write" in lines[-1]


def test_say_speaks_nothing_when_nothing_is_left(tmp_path):
    voices = voice_factory()
    code, lines = run(
        ["say", str(tone_wav(tmp_path / "a.wav")), "--out", str(tmp_path / "said.wav")],
        stt_factory=stt_factory(segment(" Thank you.")),
        voice_factory=voices,
    )
    assert code == 0
    assert voices.created[0].spoken == []
    assert "nothing to speak" in lines
    assert not (tmp_path / "said.wav").exists()


def test_speak_writes_a_wav(tmp_path):
    voices = voice_factory()
    out = tmp_path / "hello.wav"
    code, lines = run(["speak", "Hello there.", "--voice", "en_GB-alba-medium", "--out", str(out)], voice_factory=voices)
    assert code == 0
    assert voices.created[0].name == "en_GB-alba-medium"
    assert voices.created[0].spoken == ["Hello there."]
    assert read_wav(out) == (b"\x00\x00" * 2205, 22050, 1)
    assert lines[-1].startswith("timing: voice load")


def test_a_missing_file_is_a_one_line_runtime_error(tmp_path, capsys):
    def real_stt(**settings):
        return Stt(**settings, decoder=lambda *a, **k: [])

    code, _ = run(["transcribe", str(tmp_path / "missing.wav")], stt_factory=real_stt)
    assert code == 1
    error = capsys.readouterr().err
    assert error.startswith("vokal: no such file") and error.count("\n") == 1


def test_a_missing_voice_is_a_runtime_error(tmp_path, capsys):
    code, _ = run(["speak", "Hello.", "--voice-dir", str(tmp_path)])
    assert code == 1
    assert "Piper voice not found" in capsys.readouterr().err


def test_usage_errors_exit_2(monkeypatch, capsys):
    with pytest.raises(SystemExit) as missing_file:
        cli.main(["transcribe"])
    assert missing_file.value.code == 2
    monkeypatch.setenv("VOKAL_WHISPER_BEAM_SIZE", "zero")
    with pytest.raises(SystemExit) as bad_env:
        cli.main(["transcribe", "a.wav"])
    assert bad_env.value.code == 2
    assert "not a whole number" in capsys.readouterr().err
