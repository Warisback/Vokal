"""Stt with a fake model factory and decoder, plus one real decoder check when faster-whisper is installed."""

from __future__ import annotations

import math
import time
from array import array

import pytest

from vokal.audio import write_wav
from vokal.stt import SAMPLE_RATE, Stt, SttError


def one_second() -> list[float]:
    return [0.0] * SAMPLE_RATE


def test_transcribe_uses_the_v1_settings(fake_factory, make_segment):
    factory = fake_factory([make_segment(" Hello.")])
    Stt(model="tiny.en", model_factory=factory).transcribe(one_second())
    ((_audio, kwargs),) = factory.model.calls
    assert kwargs == {
        "language": "en",
        "beam_size": 1,
        "vad_filter": False,
        "condition_on_previous_text": False,
    }
    assert "initial_prompt" not in kwargs


def test_settings_reach_the_model(fake_factory, make_segment):
    factory = fake_factory([make_segment(" Hello.")])
    engine = Stt(model="base.en", device="cuda", compute_type="float16", beam_size=5, language="de", model_factory=factory)
    engine.transcribe(one_second())
    assert factory.created == [("base.en", {"device": "cuda", "compute_type": "float16"})]
    assert factory.model.calls[0][1]["beam_size"] == 5
    assert factory.model.calls[0][1]["language"] == "de"


def test_model_is_loaded_once(fake_factory, make_segment):
    factory = fake_factory([make_segment(" Hello.")])
    engine = Stt(model_factory=factory)
    assert engine.load() is None
    assert engine.load() is None
    engine.transcribe(one_second())
    assert len(factory.created) == 1


def test_load_returns_a_one_line_message_when_the_factory_raises(fake_factory):
    engine = Stt(model="small.en", model_factory=fake_factory(error=RuntimeError("out of memory\nstack details")))
    message = engine.load()
    assert message == "could not load the speech model small.en: out of memory"


def test_transcribe_raises_when_the_model_cannot_load(fake_factory):
    engine = Stt(model_factory=fake_factory(error=OSError("no such model")))
    with pytest.raises(SttError, match="no such model"):
        engine.transcribe(one_second())


def test_segments_carry_their_scores(fake_factory, make_segment):
    factory = fake_factory(
        [make_segment(" I want water.", 0.02, 0.0, 1.5, -0.25), make_segment(" Thank you.", 0.71, 1.5, 2.0, -0.9)]
    )
    transcript = Stt(model="tiny.en", model_factory=factory).transcribe([0.0] * 32000)
    assert [segment.no_speech_prob for segment in transcript.segments] == [0.02, 0.71]
    assert [segment.avg_logprob for segment in transcript.segments] == [-0.25, -0.9]
    assert transcript.segments[1].start == 1.5
    assert transcript.raw_text == " I want water.\n Thank you."
    assert transcript.duration_s == 2.0
    assert transcript.model == "tiny.en"


def test_segments_are_read_inside_the_timed_region(make_segment):
    class SlowModel:
        def transcribe(self, audio, **kwargs):
            def segments():
                for text in (" One.", " Two."):
                    time.sleep(0.03)
                    yield make_segment(text)

            return segments(), object()

    transcript = Stt(model_factory=lambda *a, **k: SlowModel()).transcribe(one_second())
    assert len(transcript.segments) == 2
    assert transcript.infer_ms >= 50


def test_a_path_goes_through_the_decoder(tmp_path, fake_factory, make_segment):
    path = tmp_path / "clip.wav"
    path.write_bytes(b"not read by the fake decoder")
    decoded = [0.0] * 8000
    calls = []

    def decoder(source, sampling_rate):
        calls.append((source, sampling_rate))
        return decoded

    factory = fake_factory([make_segment(" Yes.")])
    transcript = Stt(model_factory=factory, decoder=decoder).transcribe(path)
    assert calls == [(str(path), 16000)]
    assert factory.model.calls[0][0] is decoded
    assert transcript.duration_s == 0.5


def test_decode_of_a_missing_file(tmp_path):
    with pytest.raises(SttError, match="no such file"):
        Stt(decoder=lambda *a, **k: []).decode(tmp_path / "missing.wav")


def test_decoder_errors_become_one_line(tmp_path):
    path = tmp_path / "broken.m4a"
    path.write_bytes(b"\x00")

    def decoder(source, sampling_rate):
        raise ValueError("Invalid data found when processing input\nmore")

    with pytest.raises(SttError) as caught:
        Stt(decoder=decoder).decode(path)
    assert str(caught.value) == f"could not read {path}: Invalid data found when processing input"


def test_missing_local_model_folder(tmp_path, fake_factory):
    factory = fake_factory()
    message = Stt(model=str(tmp_path / "my-model"), model_factory=factory).load()
    assert message.startswith("model folder not found")
    assert factory.created == []


def test_folder_without_model_bin(tmp_path, fake_factory):
    message = Stt(model=str(tmp_path), model_factory=fake_factory()).load()
    assert "no model.bin" in message


def test_local_model_folder_is_passed_to_the_factory(tmp_path, fake_factory):
    (tmp_path / "model.bin").write_bytes(b"")
    factory = fake_factory()
    assert Stt(model=str(tmp_path), model_factory=factory).load() is None
    assert factory.created[0][0] == str(tmp_path)


def _tone_wav(path, freq: float, rate: int = 48000, seconds: float = 2.0, amp: float = 0.5) -> list[float]:
    samples = [amp * math.sin(2 * math.pi * freq * i / rate) for i in range(int(rate * seconds))]
    write_wav(path, array("h", (round(x * 32767) for x in samples)).tobytes(), rate)
    return samples


def _db(samples) -> float:
    return 10 * math.log10(math.fsum(float(x) * float(x) for x in samples) / len(samples) + 1e-12)


@pytest.mark.parametrize(("freq", "check"), [(10000, "removed"), (1000, "kept")])
def test_decoder_filters(tmp_path, freq, check):
    """faster-whisper's decoder must filter before it downsamples 48 kHz to 16 kHz."""
    pytest.importorskip("faster_whisper")
    path = tmp_path / f"tone-{freq}.wav"
    source = _tone_wav(path, freq)
    decoded = Stt().decode(path)
    middle = decoded[1600:-1600]  # skip the resampler's edges
    change = _db(middle) - _db(source)
    if check == "removed":
        assert change <= -30, f"{freq} Hz only {change:.1f} dB down"
    else:
        assert abs(change) <= 1, f"{freq} Hz changed by {change:.1f} dB"
