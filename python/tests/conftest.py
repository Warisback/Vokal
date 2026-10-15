"""Shared test helpers: the guard case file, fake segments and a fake faster-whisper model."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import pytest

CASES_PATH = Path(__file__).resolve().parents[2] / "shared" / "guard_cases.json"

# Test argument name -> section of shared/guard_cases.json.
_CASE_SECTIONS = {
    "text_case": "text_cases",
    "utterance_case": "utterance_cases",
    "level_case": "level_cases",
    "precheck_case": "precheck_cases",
}


@lru_cache(maxsize=1)
def load_cases() -> dict:
    with CASES_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    """Run a test once per shared case when it asks for text_case, level_case and so on."""
    for argument, section in _CASE_SECTIONS.items():
        if argument in metafunc.fixturenames:
            cases = load_cases()[section]
            metafunc.parametrize(argument, cases, ids=[case["id"] for case in cases])


@pytest.fixture
def guard_cases() -> dict:
    return load_cases()


@dataclass
class FakeSegment:
    """The parts of a faster-whisper Segment that Vokal reads."""

    text: str
    no_speech_prob: float | None = 0.01
    start: float = 0.0
    end: float = 1.0
    avg_logprob: float = -0.2


class FakeWhisperModel:
    """Stands in for faster_whisper.WhisperModel and records each transcribe call."""

    def __init__(self, segments: list) -> None:
        self.segments = segments
        self.calls: list[tuple] = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        # faster-whisper returns a lazy generator and an info object.
        return (segment for segment in self.segments), object()


class FakeModelFactory:
    """Stands in for the WhisperModel class: records how it was built, or raises."""

    def __init__(self, segments=(), error: Exception | None = None) -> None:
        self.segments = list(segments)
        self.error = error
        self.created: list[tuple] = []
        self.model: FakeWhisperModel | None = None

    def __call__(self, model, **kwargs):
        if self.error is not None:
            raise self.error
        self.created.append((model, kwargs))
        self.model = FakeWhisperModel(self.segments)
        return self.model


@pytest.fixture
def make_segment():
    return FakeSegment


@pytest.fixture
def fake_factory():
    return FakeModelFactory
