"""Vokal laptop server -- configuration.

Everything the server needs comes from environment variables, loaded from
laptop/.env. See .env.example for the documented list.

Design rule: importing this module MUST NOT fail and MUST NOT require any
third-party package. A server that will not boot 20 minutes before a demo is a
disaster, so bad configuration is collected into PROBLEMS and the server keeps
serving /state and /health in a degraded mode instead of crashing.

TTS is local Piper. There is no API key, no account, no network call and no
voice cloning anywhere in this product -- nothing a user says ever leaves this
laptop.
"""

import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, ".env")


def _load_env_file(path):
    """Populate os.environ from a .env file. python-dotenv if present, else a
    small hand-rolled parser so `pip install fastapi uvicorn` really is enough
    to run --fake mode."""
    if not os.path.exists(path):
        return
    try:
        from dotenv import load_dotenv  # type: ignore
        load_dotenv(path, override=False)
        return
    except Exception:
        pass
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.lower().startswith("export "):
                    line = line[7:].strip()
                if "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                if key and key not in os.environ:
                    os.environ[key] = val
    except Exception as exc:          # never let a malformed .env stop the server
        print("[config] WARNING: could not read %s: %s" % (path, exc))


_load_env_file(ENV_PATH)


# --------------------------------------------------------------------------
# typed getters
# --------------------------------------------------------------------------

def _s(name, default=""):
    v = os.environ.get(name)
    return default if v is None else v.strip()


def _i(name, default):
    try:
        return int(_s(name, "") or default)
    except ValueError:
        return default


def _b(name, default=False):
    v = _s(name, "").lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return default


# --------------------------------------------------------------------------
# server
# --------------------------------------------------------------------------

HOST = _s("VOKAL_BIND_HOST", "0.0.0.0")
PORT = _i("VOKAL_PORT", 8000)

# --fake / VOKAL_FAKE=1: canned captions, canned delay, no models loaded.
FAKE = _b("VOKAL_FAKE", False) or ("--fake" in sys.argv)

# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------

CAPTURES_DIR = os.path.join(BASE_DIR, "captures")
DEMO_CLIPS_DIR = os.path.join(BASE_DIR, "demo_clips")

SAVE_CAPTURES = _b("VOKAL_SAVE_CAPTURES", True)

# --------------------------------------------------------------------------
# speech to text (faster-whisper)
# --------------------------------------------------------------------------

WHISPER_MODEL = _s("WHISPER_MODEL", "small.en")
WHISPER_DEVICE = _s("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = _s("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_BEAM = _i("WHISPER_BEAM_SIZE", 1)

# There is deliberately no WHISPER_INITIAL_PROMPT setting. We measured it on the
# real demo audio today: an initial_prompt made Whisper emit the prompt text
# itself as a fake transcript segment AND drop thirty seconds of real speech.
# See pipeline.py for the rest of the hard-won transcription rules.

# --------------------------------------------------------------------------
# text to speech (local Piper -- no key, no network, no cloning)
# --------------------------------------------------------------------------

# The voices live outside the repo: this repo's path is long enough to hit
# Windows MAX_PATH and OneDrive corrupts large binary trees it syncs.
PIPER_VOICE_DIR = _s("PIPER_VOICE_DIR", r"C:\vokal-venv\voices")
PIPER_VOICE = _s("PIPER_VOICE", "en_GB-cori-high")

# The .onnx model. Piper finds the matching .onnx.json beside it itself.
PIPER_MODEL_PATH = os.path.join(PIPER_VOICE_DIR, PIPER_VOICE + ".onnx")

# --------------------------------------------------------------------------
# playback
# --------------------------------------------------------------------------

# Milliseconds of audio to buffer before the speaker starts. Piper streams
# faster than real time (measured RTF 0.197 for cori-high) so this is small; it
# only covers the first synthesis chunk. Paid once, at the start of a phrase.
PREBUFFER_MS = _i("VOKAL_PREBUFFER_MS", 120)

# Optional: force an output device (integer index, or a device-name substring).
OUTPUT_DEVICE = _s("VOKAL_OUTPUT_DEVICE")

# --------------------------------------------------------------------------
# derived + validation
# --------------------------------------------------------------------------

# The board always sends this. PROTOCOL.md: 16 kHz, 16-bit signed LE, mono.
BOARD_RATE = 16000

PROBLEMS = []          # human-readable; printed at startup, exposed on /health


def available_voices():
    """Voice names (no extension) sitting in PIPER_VOICE_DIR."""
    try:
        return sorted(n[:-5] for n in os.listdir(PIPER_VOICE_DIR)
                      if n.endswith(".onnx"))
    except OSError:
        return []


def validate():
    """Collect configuration problems. Never raises."""
    PROBLEMS.clear()
    if FAKE:
        return PROBLEMS

    if not os.path.exists(PIPER_MODEL_PATH):
        have = available_voices()
        PROBLEMS.append(
            "Piper voice not found: %s\n     PIPER_VOICE_DIR=%s\n     "
            "available voices there: %s\n     Set PIPER_VOICE in laptop/.env "
            "to one of those names."
            % (PIPER_MODEL_PATH, PIPER_VOICE_DIR,
               ", ".join(have) if have else "(none -- is the directory right?)"))
    elif not os.path.exists(PIPER_MODEL_PATH + ".json"):
        PROBLEMS.append(
            "Piper voice config missing: %s.json must sit beside the .onnx."
            % PIPER_MODEL_PATH)

    return PROBLEMS


def summary():
    """One-screen startup banner."""
    return "\n".join([
        "Vokal laptop server",
        "  mode      : %s" % ("FAKE (no models)" if FAKE else "live"),
        "  bind      : http://%s:%d" % (HOST, PORT),
        "  whisper   : %s (%s, %s)" % (WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE),
        "  tts       : piper %s" % PIPER_VOICE,
        "  voice file: %s" % PIPER_MODEL_PATH,
        "  privacy   : local only -- no API key, no network, no voice cloning",
        "  captures  : %s" % (CAPTURES_DIR if SAVE_CAPTURES else "(disabled)"),
    ])


def ensure_dirs():
    for d in (CAPTURES_DIR, DEMO_CLIPS_DIR):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError as exc:
            print("[config] WARNING: could not create %s: %s" % (d, exc))
