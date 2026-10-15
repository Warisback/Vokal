"""Command line: vokal transcribe | speak | say.

Models are imported only when a command needs them, so --help and the guard
run on the standard library alone. Settings come from flags, then environment
variables, then defaults. There is no .env loading.

Exit codes: 0 success (including "didn't catch that"), 1 runtime error, 2 usage error.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from dataclasses import asdict
from typing import Any, Callable, TextIO

from . import __version__
from .audio import AudioError
from .guard import NO_SPEECH_PROB_MAX, GuardResult, clean_segments, level_dbfs, pre_check
from .stt import SAMPLE_RATE, Stt, SttError
from .tts import TtsError, Voice, speak

NOTHING_HEARD = "(didn't catch that)"
NO_SOUND = "(no sound in the recording)"

_TIMING_LABELS = {
    "decode_ms": "decode",
    "load_ms": "model load",
    "stt_ms": "stt",
    "guard_ms": "guard",
    "voice_load_ms": "voice load",
    "tts_ms": "tts",
    "play_ms": "play",
    "write_ms": "write",
    "total_ms": "total",
}


def _env(name: str, default: str | None) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or default


def _positive_int(text: str) -> int:
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a whole number: {text!r}") from None
    if value < 1:
        raise argparse.ArgumentTypeError(f"must be 1 or more: {value}")
    return value


def _probability(text: str) -> float:
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from None
    if not 0.0 <= value <= 1.0:
        raise argparse.ArgumentTypeError(f"must be between 0 and 1: {value}")
    return value


def _device(text: str) -> int | str | None:
    """An output device index, or part of its name. Empty means the system default."""
    text = text.strip()
    if not text:
        return None
    return int(text) if text.isdigit() else text


def _ms(since: float) -> int:
    return round((time.perf_counter() - since) * 1000)


def build_parser() -> argparse.ArgumentParser:
    stt_options = argparse.ArgumentParser(add_help=False)
    group = stt_options.add_argument_group("speech to text")
    group.add_argument(
        "--model",
        default=_env("VOKAL_WHISPER_MODEL", "small.en"),
        help="faster-whisper size name (tiny.en, base.en, small.en) or a local CTranslate2 model folder "
        "(env VOKAL_WHISPER_MODEL, default %(default)s)",
    )
    group.add_argument(
        "--device",
        default=_env("VOKAL_WHISPER_DEVICE", "cpu"),
        help="cpu or cuda (env VOKAL_WHISPER_DEVICE, default %(default)s)",
    )
    group.add_argument(
        "--compute-type",
        default=_env("VOKAL_WHISPER_COMPUTE_TYPE", "int8"),
        help="CTranslate2 compute type (env VOKAL_WHISPER_COMPUTE_TYPE, default %(default)s)",
    )
    group.add_argument(
        "--beam-size",
        type=_positive_int,
        default=_env("VOKAL_WHISPER_BEAM_SIZE", "1"),
        help="1 is greedy decoding (env VOKAL_WHISPER_BEAM_SIZE, default %(default)s)",
    )
    group.add_argument("--language", default="en", help="language code passed to Whisper (default %(default)s)")
    group.add_argument(
        "--no-speech-max",
        type=_probability,
        default=NO_SPEECH_PROB_MAX,
        help="drop a segment whose no-speech score is above this (default %(default)s)",
    )

    tts_options = argparse.ArgumentParser(add_help=False)
    group = tts_options.add_argument_group("text to speech")
    group.add_argument(
        "--voice",
        default=_env("VOKAL_PIPER_VOICE", "en_GB-cori-high"),
        help="Piper voice name, without .onnx (env VOKAL_PIPER_VOICE, default %(default)s)",
    )
    group.add_argument(
        "--voice-dir",
        default=_env("VOKAL_PIPER_VOICE_DIR", None),
        help="folder holding the voice .onnx and .onnx.json files (env VOKAL_PIPER_VOICE_DIR)",
    )
    group.add_argument(
        "--output-device",
        type=_device,
        default=_env("VOKAL_OUTPUT_DEVICE", ""),
        help="speaker device index or part of its name (env VOKAL_OUTPUT_DEVICE, default: system output)",
    )
    group.add_argument("--out", metavar="FILE.wav", help="write the speech to a WAV file instead of playing it")

    parser = argparse.ArgumentParser(
        prog="vokal",
        description="Speech to text with a hallucination guard, and local text to speech.",
    )
    parser.add_argument("--version", action="version", version=f"vokal {__version__}")
    commands = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    transcribe = commands.add_parser(
        "transcribe",
        parents=[stt_options],
        help="print the guarded transcript of an audio file",
        description="Transcribe an audio file, remove invented text, and print what is left with timings.",
    )
    transcribe.add_argument("file", metavar="FILE", help="any audio file faster-whisper can read")
    transcribe.add_argument("--json", action="store_true", help="print one JSON object instead of text")
    transcribe.add_argument(
        "--segments", action="store_true", help="also print each segment with its no-speech score and avg log-prob"
    )
    transcribe.set_defaults(run=_run_transcribe)

    speak_cmd = commands.add_parser(
        "speak",
        parents=[tts_options],
        help="speak text with a Piper voice",
        description="Speak the text with a local Piper voice, or write it to a WAV file.",
    )
    speak_cmd.add_argument("text", metavar="TEXT", help="the words to speak")
    speak_cmd.set_defaults(run=_run_speak)

    say = commands.add_parser(
        "say",
        parents=[stt_options, tts_options],
        help="transcribe an audio file, then speak the guarded text",
        description="Transcribe an audio file, remove invented text, then speak what is left. "
        "Nothing is spoken when nothing is left.",
    )
    say.add_argument("file", metavar="FILE", help="any audio file faster-whisper can read")
    say.add_argument(
        "--segments", action="store_true", help="also print each segment with its no-speech score and avg log-prob"
    )
    say.set_defaults(run=_run_say)
    return parser


class _Deps:
    """What the commands build. Tests pass fakes."""

    def __init__(self, stt_factory: Callable[..., Any], voice_factory: Callable[..., Any], out: TextIO) -> None:
        self.stt_factory = stt_factory
        self.voice_factory = voice_factory
        self.out = out

    def print(self, *parts: Any) -> None:
        print(*parts, file=self.out)


def _hear(args: argparse.Namespace, deps: _Deps, timings: dict[str, int]) -> dict[str, Any]:
    """Decode, pre-check, transcribe and guard one file."""
    stt = deps.stt_factory(
        model=args.model,
        device=args.device,
        compute_type=args.compute_type,
        beam_size=args.beam_size,
        language=args.language,
    )
    started = time.perf_counter()
    samples = stt.decode(args.file)
    timings["decode_ms"] = _ms(started)

    duration_s = len(samples) / SAMPLE_RATE
    level = level_dbfs(samples, SAMPLE_RATE)
    skipped = pre_check(duration_s, level)
    segments: tuple = ()
    result = GuardResult("")
    if skipped is None:
        started = time.perf_counter()
        problem = stt.load()
        timings["load_ms"] = _ms(started)
        if problem:
            raise SttError(problem)
        transcript = stt.transcribe(samples)
        timings["stt_ms"] = transcript.infer_ms
        segments = transcript.segments
        started = time.perf_counter()
        result = clean_segments(segments, args.no_speech_max)
        timings["guard_ms"] = _ms(started)

    return {
        "text": result.text,
        "raw": "\n".join(segment.text for segment in segments),
        "removed": [asdict(entry) for entry in result.removed],
        "segments": [asdict(segment) for segment in segments],
        "level_dbfs": round(level, 2),
        "duration_s": round(duration_s, 3),
        "pre_check": skipped,
        "model": args.model,
    }


def _print_heard(heard: dict[str, Any], args: argparse.Namespace, deps: _Deps) -> None:
    if heard["text"]:
        deps.print(heard["text"])
    elif heard["pre_check"] == "no_signal":
        deps.print(NO_SOUND)
    else:
        deps.print(NOTHING_HEARD)
    for entry in heard["removed"]:
        deps.print(f'removed: "{entry["text"]}" ({entry["rule"]})')
    if heard["pre_check"]:
        deps.print(f"pre-check: {heard['pre_check']}, so the model was not run")
    if args.segments:
        for segment in heard["segments"]:
            deps.print(
                f"segment {segment['start']:.2f}-{segment['end']:.2f} s  "
                f"no_speech_prob {segment['no_speech_prob']:.3f}  avg_logprob {segment['avg_logprob']:.3f}  "
                f'"{segment["text"].strip()}"'
            )
    deps.print(f"audio: {heard['duration_s']:.2f} s, loudest 30 ms frame {heard['level_dbfs']:.1f} dBFS")
    if heard["pre_check"] is None:
        deps.print(f"model: {args.model} ({args.device}, {args.compute_type}, beam {args.beam_size})")


def _print_timings(timings: dict[str, int], deps: _Deps) -> None:
    parts = [f"{_TIMING_LABELS[key]} {value} ms" for key, value in timings.items()]
    deps.print("timing: " + ", ".join(parts))


def _run_transcribe(args: argparse.Namespace, deps: _Deps) -> int:
    started = time.perf_counter()
    timings: dict[str, int] = {}
    heard = _hear(args, deps, timings)
    timings["total_ms"] = _ms(started)
    heard["timing_ms"] = timings
    if args.json:
        deps.print(json.dumps(heard, ensure_ascii=False))
        return 0
    _print_heard(heard, args, deps)
    _print_timings(timings, deps)
    return 0


def _load_voice(args: argparse.Namespace, deps: _Deps, timings: dict[str, int]) -> Voice:
    voice = deps.voice_factory(name=args.voice, voice_dir=args.voice_dir)
    started = time.perf_counter()
    problem = voice.load()
    timings["voice_load_ms"] = _ms(started)
    if problem:
        raise TtsError(problem)
    return voice


def _speak(voice: Voice, text: str, args: argparse.Namespace, deps: _Deps, timings: dict[str, int]) -> None:
    spoken = speak(voice, text, out=args.out, output_device=args.output_device)
    for key in ("tts_ms", "play_ms", "write_ms"):
        if key in spoken:
            timings[key] = spoken[key]
    if spoken["out"]:
        deps.print(f"wrote {spoken['out']} ({spoken['audio_s']:.2f} s at {spoken['rate']} Hz)")


def _run_speak(args: argparse.Namespace, deps: _Deps) -> int:
    started = time.perf_counter()
    timings: dict[str, int] = {}
    voice = _load_voice(args, deps, timings)
    _speak(voice, args.text, args, deps, timings)
    timings["total_ms"] = _ms(started)
    _print_timings(timings, deps)
    return 0


def _run_say(args: argparse.Namespace, deps: _Deps) -> int:
    started = time.perf_counter()
    timings: dict[str, int] = {}
    # Load the voice first, so a missing voice fails before the slow part.
    voice = _load_voice(args, deps, timings)
    heard = _hear(args, deps, timings)
    _print_heard(heard, args, deps)
    if heard["text"]:
        _speak(voice, heard["text"], args, deps, timings)
    else:
        deps.print("nothing to speak")
    timings["total_ms"] = _ms(started)
    _print_timings(timings, deps)
    return 0


def main(
    argv: list[str] | None = None,
    *,
    stt_factory: Callable[..., Any] = Stt,
    voice_factory: Callable[..., Any] = Voice,
    out: TextIO | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    if out is None:
        out = sys.stdout
        if isinstance(out, io.TextIOWrapper):
            # A Windows console pipe may not encode every character Whisper returns.
            out.reconfigure(errors="backslashreplace")
    deps = _Deps(stt_factory, voice_factory, out)
    try:
        return args.run(args, deps)
    except (SttError, TtsError, AudioError, OSError) as exc:
        print(f"vokal: {exc}", file=sys.stderr)
        return 1
