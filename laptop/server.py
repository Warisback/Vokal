"""Vokal laptop server -- FastAPI app implementing PROTOCOL.md, exactly.

Run it:
    C:\\vokal-venv\\Scripts\\python.exe server.py            # live (whisper + Piper)
    C:\\vokal-venv\\Scripts\\python.exe server.py --fake     # canned, no models at all

Two rules shape every line of this file.

1. THE BOARD IS BLOCKED. The ESP32 sits inside HTTPClient::POST() with its UI
   frozen for the whole duration of any request it makes. So every POST here
   validates, queues, and returns 202 in single-digit milliseconds. All real
   work happens on ONE background worker thread.

2. IT MUST BOOT. A server that will not start 20 minutes before a demo is fatal,
   so config and pipeline are imported defensively: if either is broken or
   half-written, /state and /health still answer and /health says what is wrong.

pipeline.py and config.py are owned by another agent. This file touches neither;
it talks to them through the thin shim below, which probes for the documented
names (transcribe / speak / play_clip) plus a few plausible aliases. All
protocol state -- status, caption, seq, latency, the job queue, the capture files
and the replay cache -- lives HERE, so the contract in PROTOCOL.md holds
whatever shape the pipeline ends up having.

TTS is local Piper. No API key, no account, no network, no cloning: nothing
about a user's voice ever leaves this laptop.
"""

import json
import os
import struct
import sys
import threading
import time

from collections import deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

STARTED_AT = time.time()


# ==========================================================================
# config shim
# ==========================================================================
# config.py is being rewritten for Piper while this file is being written, so
# nothing here may assume a particular attribute exists. Every read goes through
# _c() with a working default.

_CONFIG_ERROR = ""
try:
    import config as cfg
except Exception as exc:                       # pragma: no cover - defensive
    cfg = None
    _CONFIG_ERROR = "config.py failed to import: %s" % exc


def _c(name, default):
    if cfg is None:
        return default
    v = getattr(cfg, name, None)
    return default if v is None else v


def _argv_flag(flag):
    return flag in sys.argv


def _argv_val(flag, default):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


FAKE = (_argv_flag("--fake")
        or str(os.environ.get("VOKAL_FAKE", "")).lower() in ("1", "true", "yes", "on")
        or bool(_c("FAKE", False)))

HOST = _argv_val("--host", str(_c("HOST", "0.0.0.0")))
try:
    PORT = int(_argv_val("--port", _c("PORT", 8000)))
except ValueError:
    PORT = 8000

BOARD_RATE = int(_c("BOARD_RATE", 16000))       # PROTOCOL.md: 16 kHz s16le mono
CAPTURES_DIR = str(_c("CAPTURES_DIR", os.path.join(BASE_DIR, "captures")))
DEMO_CLIPS_DIR = str(_c("DEMO_CLIPS_DIR", os.path.join(BASE_DIR, "demo_clips")))
SAVE_CAPTURES = bool(_c("SAVE_CAPTURES", True))

# A body larger than this is refused rather than buffered: 16 kHz s16le mono is
# 32 KB/s, so 16 MB is over eight minutes of audio. Nothing real gets near it.
MAX_UTTERANCE_BYTES = int(_c("MAX_UTTERANCE_BYTES", 16 * 1024 * 1024))

FAKE_CAPTION = "This is Vokal, speaking for me."
FAKE_STT_S = 0.35
FAKE_TTS_S = 0.45


def _log(msg):
    print("[vokal] %s" % msg, flush=True)


# ==========================================================================
# pipeline shim
# ==========================================================================
# Documented contract (from the brief):
#     pipeline.transcribe(pcm_bytes, sample_rate) -> str
#     pipeline.speak(text)                        -> plays audio, latency dict
#     pipeline.play_clip(clip_id)                 -> plays the cached clip WAV
# The aliases below are a seatbelt in case the rewrite lands slightly different
# names. If nothing matches we degrade loudly on /health instead of crashing.

class _Pipe(object):
    def __init__(self):
        self.mod = None
        self.error = ""
        self.transcribe = None
        self.speak = None
        self.play_clip = None
        self.play_wav = None
        self.stop = None
        self.warmup = None
        self.health = None
        self.list_clips = None
        self.voice_name = ""


PIPE = _Pipe()


def _first_callable(mod, names):
    for n in names:
        fn = getattr(mod, n, None)
        if callable(fn):
            return fn
    return None


def load_pipeline():
    """Import pipeline and bind its functions. Never raises.

    In --fake mode the module is not imported at all: the whole point of --fake
    is that the firmware can be integrated with NO models, no onnxruntime, and
    no half-finished pipeline.py in the way.
    """
    if FAKE:
        PIPE.error = ""
        return PIPE
    try:
        import pipeline as _mod
    except Exception as exc:
        PIPE.error = "pipeline.py failed to import: %s" % exc
        _log("!! " + PIPE.error)
        return PIPE
    PIPE.mod = _mod
    PIPE.transcribe = _first_callable(_mod, ("transcribe", "transcribe_pcm", "stt"))
    PIPE.speak = _first_callable(_mod, ("speak", "say", "speak_text", "tts"))
    PIPE.play_clip = _first_callable(_mod, ("play_clip", "run_clip", "play_demo_clip", "clip"))
    PIPE.play_wav = _first_callable(_mod, ("play_wav", "play_wav_file", "play_file", "play_audio"))
    PIPE.stop = _first_callable(_mod, ("stop", "cancel", "stop_playback", "abort"))
    PIPE.warmup = _first_callable(_mod, ("warmup", "preload", "load_models", "ensure_loaded"))
    PIPE.health = _first_callable(_mod, ("health", "status", "readiness"))
    PIPE.list_clips = _first_callable(_mod, ("list_clips", "clips"))
    PIPE.voice_name = str(getattr(_mod, "VOICE_NAME", "") or _c("PIPER_VOICE", "") or "")
    missing = []
    if PIPE.transcribe is None:
        missing.append("transcribe(pcm, rate)")
    if PIPE.speak is None:
        missing.append("speak(text)")
    if missing:
        PIPE.error = ("pipeline.py imported but is missing: %s -- the affected "
                      "beats report an error instead of speaking" % ", ".join(missing))
        _log("!! " + PIPE.error)
    return PIPE


def _call_transcribe(pcm, rate):
    """pipeline.transcribe(pcm, sample_rate). Tolerates a one-argument signature."""
    try:
        return PIPE.transcribe(pcm, rate)
    except TypeError:
        return PIPE.transcribe(pcm)


def _harvest_latency(result, fallback_ms):
    """Pull a first-audio latency out of whatever pipeline.speak() returned."""
    if isinstance(result, dict):
        for k in ("first_audio_ms", "ttfa_ms", "latency_ms", "first_ms", "total_ms"):
            v = result.get(k)
            if isinstance(v, (int, float)) and v >= 0:
                return int(v)
        for k in ("first_audio_s", "first_audio", "latency_s"):
            v = result.get(k)
            if isinstance(v, (int, float)) and v >= 0:
                return int(v * 1000.0)
    elif isinstance(result, (int, float)) and result >= 0:
        return int(result if result > 50 else result * 1000.0)
    return int(fallback_ms)


def _harvest_audio(result):
    """Find replayable audio in whatever speak()/play_clip() returned.

    Returns (wav_path, pcm_bytes, rate); at most one of the first two is set.
    A pipeline that returns only a latency dict is fine -- see _ReplayCache.
    """
    if not isinstance(result, dict):
        return "", None, 0
    for k in ("wav_path", "wav", "path", "file", "audio_path"):
        v = result.get(k)
        if isinstance(v, str) and v and os.path.exists(v):
            return v, None, 0
    rate = 0
    for k in ("rate", "sample_rate", "sr"):
        v = result.get(k)
        if isinstance(v, int) and v > 0:
            rate = v
            break
    for k in ("pcm", "audio", "samples", "pcm_bytes"):
        v = result.get(k)
        if isinstance(v, (bytes, bytearray)) and len(v) > 0:
            return "", bytes(v), (rate or 22050)
    return "", None, 0


# ==========================================================================
# WAV helpers -- no soundfile dependency, --fake must run on fastapi alone
# ==========================================================================

def wav_bytes(pcm, rate, channels=1, width=2):
    """A real 44-byte RIFF header around 16-bit PCM."""
    n = len(pcm)
    return b"".join([
        b"RIFF", struct.pack("<I", 36 + n), b"WAVEfmt ",
        struct.pack("<IHHIIHH", 16, 1, channels, rate,
                    rate * channels * width, channels * width, width * 8),
        b"data", struct.pack("<I", n), bytes(pcm),
    ])


def write_wav(path, pcm, rate):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(wav_bytes(pcm, rate))
    return path


# ==========================================================================
# playing a cached WAV -- the on-stage fallback path
# ==========================================================================
# /replay must work when everything else has stopped, so it never touches
# whisper or Piper. It plays bytes we already have, through the first of these
# that exists on the machine.

def play_wav_file(path):
    if FAKE:
        time.sleep(0.2)
        return "fake"
    if PIPE.play_wav is not None:
        PIPE.play_wav(path)
        return "pipeline"
    try:
        import soundfile as sf
        import sounddevice as sd
        data, rate = sf.read(path, dtype="int16")
        sd.play(data, rate)
        sd.wait()
        return "sounddevice"
    except Exception:
        pass
    try:
        import subprocess
        subprocess.run(["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path],
                       check=True)
        return "ffplay"
    except Exception:
        pass
    try:
        import winsound
        winsound.PlaySound(path, winsound.SND_FILENAME)
        return "winsound"
    except Exception as exc:
        raise RuntimeError("no way to play audio on this machine (%s)" % exc)


# ==========================================================================
# hallucination guard (second pass)
# ==========================================================================
# pipeline.transcribe() owns the primary guard. This is belt and braces at the
# last point before words are SPOKEN ALOUD FOR SOMEONE WHO CANNOT CORRECT THEM.
# We observed Whisper invent "Thank you." on trailing silence in the real demo
# clip today, so the filter runs twice; it can only ever remove, never add.

_BLOCKLIST = ("thank you", "thanks for watching", "please subscribe", "you",
              "bye", "thanks", "subtitles by", "amara.org", "www.")

_SUBSTRING_BLOCK = ("subtitles by", "amara.org", "www.")


def _norm(s):
    keep = [ch.lower() for ch in s if ch.isalnum() or ch.isspace()]
    return " ".join("".join(keep).split()).strip()


def guard_transcript(text):
    """Return the text, or "" when the whole thing is known Whisper filler."""
    t = (text or "").strip()
    if not t:
        return ""
    n = _norm(t)
    if not n:
        return ""
    for bad in _BLOCKLIST:
        if n == _norm(bad):
            return ""
    low = t.lower()
    for bad in _SUBSTRING_BLOCK:
        if bad in low:
            return ""
    return t


NOTHING_HEARD = "(didn't catch that)"


# ==========================================================================
# state
# ==========================================================================

class State(object):
    """The five fields of GET /state, behind a lock held for microseconds.

    seq increments on every caption SET, not only when the text changes, so the
    board can tell "new caption that happens to read the same" from "same
    caption again" without diffing strings on an ESP32 (PROTOCOL.md).
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.status = "idle"
        self.caption = ""
        self.latency_ms = 0
        self.seq = 0
        self.source = ""

    def snapshot(self):
        with self._lock:
            return {"status": self.status, "caption": self.caption,
                    "latency_ms": self.latency_ms, "seq": self.seq,
                    "source": self.source}

    def set_status(self, status, source=None):
        with self._lock:
            self.status = status
            if source is not None:
                self.source = source

    def set_latency(self, ms):
        with self._lock:
            self.latency_ms = int(ms)

    def set_caption(self, caption, status=None, source=None, latency_ms=None):
        with self._lock:
            self.caption = caption
            self.seq += 1
            if status is not None:
                self.status = status
            if source is not None:
                self.source = source
            if latency_ms is not None:
                self.latency_ms = int(latency_ms)
            snap = (self.seq, self.status, caption)
        _log("state seq=%d %s %r" % snap)


STATE = State()


# ==========================================================================
# replay cache
# ==========================================================================

class _ReplayCache(object):
    """The last thing that came out of the speakers, ready to come out again.

    Preference order, best first:
      1. a WAV file on disk -- the clip beat's pre-rendered WAV, or bytes the
         pipeline handed back. Replay is then pure file playback: no STT, no
         TTS, no model, no network. This is the on-stage fallback.
      2. text only -- if the pipeline plays internally and hands back nothing we
         can keep, replay re-speaks the text. Still deterministic, still no STT.
    /health reports which of the two you have, as "replay_cached_audio".
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.caption = ""
        self.text = ""
        self.source = ""
        self.wav_path = ""
        self.latency_ms = 0

    def store(self, caption, text, source, wav_path="", latency_ms=0):
        with self.lock:
            self.caption = caption
            self.text = text
            self.source = source
            self.wav_path = wav_path or ""
            self.latency_ms = int(latency_ms or 0)

    def get(self):
        with self.lock:
            return dict(caption=self.caption, text=self.text, source=self.source,
                        wav_path=self.wav_path, latency_ms=self.latency_ms)

    def ready(self):
        with self.lock:
            return bool(self.caption or self.text or self.wav_path)

    def cached_audio(self):
        with self.lock:
            return bool(self.wav_path and os.path.exists(self.wav_path))


REPLAY = _ReplayCache()

LAST_SPOKEN_WAV = os.path.join(CAPTURES_DIR, "last_spoken.wav")


# ==========================================================================
# clips
# ==========================================================================

def clip_paths(clip_id):
    """(rendered_wav, source_wav, transcript_txt) for a clip id; any may be ""."""
    base = os.path.join(DEMO_CLIPS_DIR, clip_id)
    rendered = base + "_rendered.wav"
    source = base + "_source.wav"
    if not os.path.exists(source) and os.path.exists(base + ".wav"):
        source = base + ".wav"
    txt = base + ".txt"
    return (rendered if os.path.exists(rendered) else "",
            source if os.path.exists(source) else "",
            txt if os.path.exists(txt) else "")


def known_clips():
    """Clip ids this server can serve.

    Owned here, not in the pipeline, so /demo/trigger can answer 404
    synchronously before anything is queued -- and so the clip beat still
    answers correctly in --fake mode with no pipeline imported at all.
    """
    ids = set()
    try:
        for name in os.listdir(DEMO_CLIPS_DIR):
            low = name.lower()
            if low.endswith("_rendered.wav"):
                ids.add(name[:-len("_rendered.wav")])
            elif low.endswith("_source.wav"):
                ids.add(name[:-len("_source.wav")])
            elif low.endswith(".txt") and low != "readme.txt":
                ids.add(name[:-4])
    except OSError:
        pass
    if PIPE.list_clips is not None:
        try:
            extra = PIPE.list_clips()
            if isinstance(extra, dict):
                ids.update(str(k) for k in extra.keys())
            elif isinstance(extra, (list, tuple, set)):
                ids.update(str(k) for k in extra)
        except Exception:
            pass
    return sorted(ids)


def clip_caption(clip_id):
    _rendered, _source, txt = clip_paths(clip_id)
    if txt:
        try:
            with open(txt, "r", encoding="utf-8") as fh:
                text = " ".join(fh.read().split())
            if text:
                return text
        except OSError:
            pass
    return "clip: %s" % clip_id


# ==========================================================================
# jobs + the single worker thread
# ==========================================================================

class Job(object):
    __slots__ = ("kind", "source", "text", "pcm", "rate", "utterance_id",
                 "clip_id", "queued_ns", "cancelled")

    def __init__(self, kind, source, text="", pcm=None, rate=BOARD_RATE,
                 utterance_id=0, clip_id=""):
        self.kind = kind                  # live | clip | speak | replay
        self.source = source              # live | clip | ""  (PROTOCOL.md)
        self.text = text
        self.pcm = pcm
        self.rate = rate
        self.utterance_id = utterance_id
        self.clip_id = clip_id
        self.queued_ns = time.perf_counter_ns()
        self.cancelled = False


class Engine(object):
    """One voice at a time.

    A new job supersedes everything still queued behind it and asks the running
    job to stand down: two voices talking over each other on stage is worse than
    a dropped sentence, and the newest press is always the one the presenter
    meant.
    """

    def __init__(self):
        self.cv = threading.Condition()
        self.queue = deque()
        self.current = None
        self.thread = None
        self.running = False
        self.jobs_done = 0
        self.next_uid = 1
        self.ready_whisper = FAKE
        self.ready_tts = FAKE
        self.problems = []

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._worker, name="vokal-worker",
                                       daemon=True)
        self.thread.start()
        threading.Thread(target=self._warmup, name="vokal-warmup",
                         daemon=True).start()

    def shutdown(self):
        with self.cv:
            self.running = False
            self.queue.clear()
            self.cv.notify_all()
        t = self.thread
        if t is not None:
            t.join(timeout=2.0)

    def _warmup(self):
        """Loads models OFF the request path, so the port binds instantly.

        If a model will not load we stay up and say so on /health. A degraded
        server beats a server that never came back 20 minutes before a demo.
        """
        if FAKE:
            _log("FAKE mode: no models loaded, canned everything")
            return
        load_pipeline()
        if PIPE.error:
            self.problems.append(PIPE.error)
        if _CONFIG_ERROR:
            self.problems.append(_CONFIG_ERROR)
        for p in list(_c("PROBLEMS", []) or []):
            self.problems.append(str(p))
        info = {}
        if PIPE.warmup is not None:
            t0 = time.perf_counter()
            try:
                got = PIPE.warmup()
                if isinstance(got, dict):
                    info = got
                _log("models warm in %.2f s" % (time.perf_counter() - t0))
            except Exception as exc:
                self.problems.append("model warmup failed: %s" % exc)
                _log("!! model warmup failed: %s" % exc)
        if PIPE.health is not None and not info:
            try:
                got = PIPE.health()
                if isinstance(got, dict):
                    info = got
            except Exception:
                pass
        self.ready_whisper = bool(info.get("whisper", PIPE.transcribe is not None))
        self.ready_tts = bool(info.get("tts", PIPE.speak is not None))
        if info.get("voice"):
            PIPE.voice_name = str(info["voice"])
        for p in list(info.get("problems", []) or []):
            self.problems.append(str(p))

    # -- submission --------------------------------------------------------

    def _submit(self, job):
        with self.cv:
            dropped = len(self.queue)
            self.queue.clear()                  # supersede whatever was waiting
            cur = self.current
            if cur is not None:
                cur.cancelled = True
            self.queue.append(job)
            self.cv.notify()
        if cur is not None and PIPE.stop is not None:
            try:
                PIPE.stop()                     # cut playback already in flight
            except Exception:
                pass
        if dropped:
            _log("superseded %d queued job(s)" % dropped)
        return job

    def submit_live(self, pcm, rate, utterance_id):
        if not utterance_id:
            utterance_id = self.next_uid
        self.next_uid = max(self.next_uid, utterance_id) + 1
        STATE.set_status("processing", "live")
        return self._submit(Job("live", "live", pcm=pcm, rate=rate,
                                utterance_id=utterance_id))

    def submit_clip(self, clip_id):
        STATE.set_status("processing", "clip")
        return self._submit(Job("clip", "clip", clip_id=clip_id))

    def submit_speak(self, text):
        STATE.set_status("processing", "live")
        return self._submit(Job("speak", "live", text=text))

    def submit_replay(self):
        cached = REPLAY.get()
        STATE.set_status("processing", cached["source"] or "")
        return self._submit(Job("replay", cached["source"] or "",
                                text=cached["text"]))

    def depth(self):
        with self.cv:
            return len(self.queue) + (1 if self.current is not None else 0)

    # -- the worker --------------------------------------------------------

    def _worker(self):
        while True:
            with self.cv:
                while self.running and not self.queue:
                    self.cv.wait(0.25)
                if not self.running:
                    return
                job = self.queue.popleft()
                self.current = job
            try:
                self._run(job)
            except Exception as exc:            # never let the worker die
                _log("!! job %s failed: %s" % (job.kind, exc))
                STATE.set_caption(_human_error(exc), status="error",
                                  source=job.source)
            finally:
                with self.cv:
                    self.current = None
                    self.jobs_done += 1
                    idle = not self.queue
                if idle and STATE.snapshot()["status"] not in ("error",):
                    STATE.set_status("idle")

    def _run(self, job):
        if job.kind == "live":
            self._run_live(job)
        elif job.kind == "clip":
            self._run_clip(job)
        elif job.kind == "speak":
            self._run_speak(job)
        elif job.kind == "replay":
            self._run_replay(job)

    # -- beats -------------------------------------------------------------

    def _run_live(self, job):
        t0 = time.perf_counter()
        pcm = job.pcm or b""
        if SAVE_CAPTURES and pcm:
            path = save_capture(pcm, job.rate, job.utterance_id)
            if path:
                _log("capture %s (%.1f s)"
                     % (os.path.basename(path),
                        len(pcm) / float(2 * max(job.rate, 1))))
        if len(pcm) < job.rate:                 # under 0.5 s of 16-bit audio
            STATE.set_caption(NOTHING_HEARD, status="idle", source="live")
            return
        if FAKE:
            time.sleep(FAKE_STT_S)
            text = FAKE_CAPTION
        else:
            if PIPE.transcribe is None:
                raise RuntimeError("speech-to-text is not available (see /health)")
            text = guard_transcript(_call_transcribe(pcm, job.rate) or "")
        stt_ms = (time.perf_counter() - t0) * 1000.0
        if job.cancelled:
            return
        if not text:
            # Honest, never invented. See guard_transcript().
            STATE.set_caption(NOTHING_HEARD, status="idle", source="live")
            _log("stt %.0f ms -> nothing usable" % stt_ms)
            return
        _log("stt %.0f ms -> %r" % (stt_ms, text))
        self._speak(job, text, text, t0)

    def _run_clip(self, job):
        """PRE-RENDERED. No STT and no TTS at run time: this beat cannot fail."""
        t0 = time.perf_counter()
        caption = clip_caption(job.clip_id)
        rendered, _source, _txt = clip_paths(job.clip_id)
        STATE.set_caption(caption, status="speaking", source="clip")
        result = None
        if FAKE:
            time.sleep(FAKE_TTS_S)
        elif PIPE.play_clip is not None:
            result = PIPE.play_clip(job.clip_id)
        elif rendered:
            play_wav_file(rendered)
        else:
            raise RuntimeError("clip %s has no rendered audio" % job.clip_id)
        if isinstance(result, dict):
            for k in ("caption", "text", "transcript"):
                v = result.get(k)
                if isinstance(v, str) and v.strip():
                    caption = v.strip()
                    break
        wav, pcm, rate = _harvest_audio(result)
        if not wav:
            wav = rendered
        if not wav and pcm:
            try:
                wav = write_wav(LAST_SPOKEN_WAV, pcm, rate)
            except OSError:
                wav = ""
        ms = _harvest_latency(result, (time.perf_counter() - t0) * 1000.0)
        REPLAY.store(caption, caption, "clip", wav, ms)
        STATE.set_latency(ms)
        _log("clip %s done in %d ms" % (job.clip_id, ms))

    def _run_speak(self, job):
        self._speak(job, job.text, job.text, time.perf_counter())

    def _run_replay(self, job):
        """Cached bytes only. This is the fallback that has to work on stage
        precisely when whisper, Piper, the mic and the Wi-Fi have all failed."""
        cached = REPLAY.get()
        if not (cached["caption"] or cached["text"] or cached["wav_path"]):
            return
        t0 = time.perf_counter()
        STATE.set_caption(cached["caption"] or cached["text"], status="speaking",
                          source=cached["source"] or "")
        if cached["wav_path"] and os.path.exists(cached["wav_path"]):
            how = play_wav_file(cached["wav_path"])
            _log("replay from cached audio (%s)" % how)
        elif FAKE:
            time.sleep(FAKE_TTS_S)
        elif cached["text"] and PIPE.speak is not None:
            # Degraded replay: this pipeline handed back no audio bytes to keep,
            # so we re-speak the same text. Deterministic, and still no STT.
            PIPE.speak(cached["text"])
            _log("replay re-spoke text (pipeline returned no cacheable audio)")
        else:
            raise RuntimeError("nothing cached to replay")
        STATE.set_latency((time.perf_counter() - t0) * 1000.0)

    # -- shared speaking path ---------------------------------------------

    def _speak(self, job, text, caption, t0):
        if job.cancelled:       # a newer press already won; stay quiet
            return
        STATE.set_caption(caption, status="speaking", source=job.source)
        if FAKE:
            time.sleep(FAKE_TTS_S)
            if job.cancelled:
                return
            ms = int((time.perf_counter() - t0) * 1000)
            REPLAY.store(caption, text, job.source or "live", "", ms)
            STATE.set_latency(ms)
            return
        if PIPE.speak is None:
            raise RuntimeError("text-to-speech is not available (see /health)")
        result = PIPE.speak(text)
        ms = _harvest_latency(result, (time.perf_counter() - t0) * 1000.0)
        wav, pcm, rate = _harvest_audio(result)
        if not wav and pcm:
            try:
                wav = write_wav(LAST_SPOKEN_WAV, pcm, rate)
            except OSError:
                wav = ""
        REPLAY.store(caption, text, job.source or "live", wav, ms)
        STATE.set_latency(ms)
        _log("spoke in %d ms%s" % (ms, "" if wav else " (no cacheable audio)"))

    # -- health ------------------------------------------------------------

    def health(self):
        problems = list(self.problems)
        if not FAKE and PIPE.mod is None and not problems:
            problems.append("models still loading")
        whisper_ok = bool(self.ready_whisper)
        tts_ok = bool(self.ready_tts)
        return {
            # -- the four keys PROTOCOL.md froze; the board reads only these --
            "ok": bool(whisper_ok and tts_ok and not problems),
            "whisper": whisper_ok,
            "tts": tts_ok,
            # No cloning any more: TTS is local Piper and nothing leaves this
            # laptop. The key stays for wire compatibility and now means
            # "a voice is loaded and ready to speak".
            "voice_id_set": tts_ok,
            # -- additive diagnostics for the human; ArduinoJson ignores them --
            "mode": "fake" if FAKE else "live",
            "voice": PIPE.voice_name or ("fake" if FAKE else ""),
            "tts_engine": "piper (local, offline)",
            "queue": self.depth(),
            "jobs_done": self.jobs_done,
            "replay_ready": REPLAY.ready(),
            "replay_cached_audio": REPLAY.cached_audio(),
            "clips": known_clips(),
            "captures_dir": CAPTURES_DIR if SAVE_CAPTURES else "",
            "uptime_s": round(time.time() - STARTED_AT, 1),
            "problems": problems,
        }


ENGINE = Engine()


def _human_error(exc):
    msg = str(exc).strip() or exc.__class__.__name__
    return msg if len(msg) <= 120 else msg[:117] + "..."


def save_capture(pcm, rate, utterance_id):
    """laptop/captures/<ts>-<id>.wav, with a real WAV header.

    Every utterance the board ever sends lands here. When a demo goes wrong the
    first question is always "what did the mic actually hear?", and this is the
    only way to answer it afterwards.
    """
    try:
        os.makedirs(CAPTURES_DIR, exist_ok=True)
        name = "%s-%d.wav" % (time.strftime("%Y%m%d-%H%M%S"), utterance_id)
        return write_wav(os.path.join(CAPTURES_DIR, name), pcm, rate or BOARD_RATE)
    except Exception as exc:
        _log("!! could not save capture: %s" % exc)
        return ""


# ==========================================================================
# app
# ==========================================================================

async def _json_body(request):
    """Tolerant parse: a malformed body becomes {} so the endpoint's own
    validation writes the error message, which is the useful one."""
    try:
        raw = await request.body()
    except Exception:
        return {}
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _err(status, message, **extra):
    body = {"ok": False, "error": message}
    body.update(extra)
    return JSONResponse(body, status_code=status)


def _int_header(request, name, default):
    raw = request.headers.get(name)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def _banner():
    lines = [
        "Vokal laptop server",
        "  mode      : %s" % ("FAKE (canned, no models, no network)" if FAKE else "live"),
        "  bind      : http://%s:%d" % (HOST, PORT),
        "  tts       : Piper, local. Nothing leaves this laptop.",
        "  clips     : %s" % (", ".join(known_clips()) or "(none found)"),
        "  captures  : %s" % (CAPTURES_DIR if SAVE_CAPTURES else "(disabled)"),
    ]
    if _CONFIG_ERROR:
        lines.append("  !! " + _CONFIG_ERROR)
    lines.append("  put this laptop's LAN IP in firmware/secrets.h as VOKAL_HOST")
    return "\n".join(lines)


@asynccontextmanager
async def lifespan(app):
    try:
        os.makedirs(CAPTURES_DIR, exist_ok=True)
    except OSError:
        pass
    if cfg is not None and callable(getattr(cfg, "ensure_dirs", None)):
        try:
            cfg.ensure_dirs()
        except Exception:
            pass
    if cfg is not None and callable(getattr(cfg, "validate", None)):
        try:
            cfg.validate()
        except Exception as exc:
            _log("!! config.validate() failed: %s" % exc)
    print(_banner(), flush=True)
    ENGINE.start()
    if not _argv_flag("--no-hotkey"):
        _start_hotkeys()
    try:
        yield
    finally:
        ENGINE.shutdown()


app = FastAPI(title="Vokal", version="1.0", lifespan=lifespan)


@app.post("/utterance")
async def post_utterance(request: Request):
    """The live beat. Raw PCM in, 202 straight back out.

    Body is 16 kHz / 16-bit signed LE / mono -- exactly what is sitting in
    audBuf after audioStop(). No WAV header, no multipart, no base64.

    A short or empty body still returns 202: the board cannot render an HTTP
    error, but it renders `caption` beautifully, so problems are reported there.
    """
    body = await request.body()
    if len(body) > MAX_UTTERANCE_BYTES:
        return _err(413, "body too large (%d bytes)" % len(body))
    rate = _int_header(request, "X-Sample-Rate", BOARD_RATE)
    if rate <= 0:
        rate = BOARD_RATE
    uid = _int_header(request, "X-Utterance-Id", 0)
    job = ENGINE.submit_live(body, rate, uid)
    return JSONResponse({"ok": True, "utterance_id": job.utterance_id},
                        status_code=202)


@app.post("/demo/trigger")
async def post_demo_trigger(request: Request):
    data = await _json_body(request)
    clip_id = str(data.get("clip_id") or "").strip()
    clips = known_clips()
    if not clip_id:
        return _err(400, 'body must be {"clip_id": "clip1"}', clips=clips)
    if clip_id not in clips:
        return _err(404, "unknown clip_id", clip_id=clip_id, clips=clips)
    ENGINE.submit_clip(clip_id)
    return JSONResponse({"ok": True, "clip_id": clip_id}, status_code=202)


@app.get("/state")
async def get_state():
    """Polled by the board at ~3 Hz. Copies five fields from behind a lock that
    is never held for more than a few microseconds, and can never block on the
    pipeline -- that is the entire reason the worker thread exists."""
    return JSONResponse(STATE.snapshot())


@app.post("/speak")
async def post_speak(request: Request):
    data = await _json_body(request)
    text = str(data.get("text") or "").strip()
    if not text:
        return _err(400, 'body must be {"text": "..."}')
    ENGINE.submit_speak(text)
    return JSONResponse({"ok": True}, status_code=202)


@app.post("/replay")
async def post_replay():
    """Re-plays the last success from cache. No STT, no TTS, no network."""
    if not REPLAY.ready():
        return _err(409, "nothing has been spoken yet")
    ENGINE.submit_replay()
    return JSONResponse({"ok": True}, status_code=202)


@app.get("/health")
async def get_health():
    return JSONResponse(ENGINE.health())


@app.get("/", response_class=PlainTextResponse)
async def get_root():
    return (
        "Vokal laptop server\n"
        "  POST /utterance      raw 16k s16le mono PCM  -> 202\n"
        '  POST /demo/trigger   {"clip_id":"clip1"}     -> 202 / 404\n'
        "  GET  /state          board polls this at 3 Hz\n"
        '  POST /speak          {"text":"..."}          -> 202\n'
        "  POST /replay         empty body              -> 202 / 409\n"
        "  GET  /health         readiness + diagnostics\n"
    )


# ==========================================================================
# keyboard fallback
# ==========================================================================
# The presenter must be able to drive the demo with no board at all: if the
# ESP32 drops off the hotspot mid-pitch, this is the difference between a
# recovery and a dead stage. It calls the engine directly rather than looping
# back through HTTP, so it still works when the network is the thing that broke.

_HOTKEY_HELP = """
  keyboard fallback (type in this window, then Enter):
    [Enter] or r   replay the last thing that was spoken
    s <text>       speak that text now
    c <clip_id>    run the clip beat
    h              health
    ?              this help
"""


def _hotkey_loop():
    print(_HOTKEY_HELP, flush=True)
    while True:
        try:
            line = sys.stdin.readline()
        except Exception:
            return
        if line == "":                          # stdin closed
            return
        cmd = line.strip()
        try:
            if cmd == "" or cmd.lower() == "r":
                if REPLAY.ready():
                    ENGINE.submit_replay()
                    print("[key] replay", flush=True)
                else:
                    print("[key] nothing has been spoken yet", flush=True)
            elif cmd in ("?", "help"):
                print(_HOTKEY_HELP, flush=True)
            elif cmd.lower() in ("h", "health"):
                print(json.dumps(ENGINE.health(), indent=2), flush=True)
            elif cmd.lower().startswith("s "):
                text = cmd[2:].strip()
                if text:
                    ENGINE.submit_speak(text)
                    print("[key] speak %r" % text, flush=True)
            elif cmd.lower().startswith("c "):
                clip = cmd[2:].strip()
                if clip in known_clips():
                    ENGINE.submit_clip(clip)
                    print("[key] clip %s" % clip, flush=True)
                else:
                    print("[key] unknown clip %r (have: %s)"
                          % (clip, ", ".join(known_clips()) or "none"), flush=True)
            else:
                print("[key] unknown command %r -- press ? for help" % cmd, flush=True)
        except Exception as exc:
            print("[key] %s" % exc, flush=True)


def _start_hotkeys():
    try:
        if not sys.stdin or not sys.stdin.isatty():
            return          # piped or service-hosted: no console to listen to
    except Exception:
        return
    threading.Thread(target=_hotkey_loop, name="vokal-keys", daemon=True).start()


# ==========================================================================
# entry point
# ==========================================================================

def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        print("  --fake         canned pipeline, no models loaded at all")
        print("  --host <addr>  bind address (default %s)" % HOST)
        print("  --port <n>     port (default %d)" % PORT)
        print("  --no-hotkey    do not read the keyboard fallback from stdin")
        print("  --access-log   log every request (noisy: the board polls 3 Hz)")
        return 0

    import uvicorn

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        # The board polls /state three times a second. With the access log on,
        # the one line per utterance that says which stage blew the latency
        # budget scrolls away in about two seconds.
        access_log=_argv_flag("--access-log"),
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
