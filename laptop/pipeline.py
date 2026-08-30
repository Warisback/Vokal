"""Vokal laptop server -- the pipeline: STT -> TTS -> speakers.

Threading model (read this before changing anything):

  * The board is BLOCKED and its UI is FROZEN for the whole duration of any POST
    it makes, so every endpoint hands a Job to this module and returns 202. No
    slow work ever happens on a request thread.
  * Exactly ONE worker thread. One voice at a time; a new job supersedes the
    queued one and cuts off the running one's playback -- the pad was pressed
    again, the presenter means "say this instead".
  * Shared /state lives behind a lock that is only ever held for microseconds.

Everything runs locally. STT is faster-whisper, TTS is Piper. No API key, no
network call, no voice cloning: nothing a user says leaves this laptop.

Import rule: this module must import with only the standard library present.
numpy, faster_whisper, piper and sounddevice are all imported lazily.
"""

import io
import os
import re
import threading
import time
import wave

import config as cfg


# --------------------------------------------------------------------------
# errors
# --------------------------------------------------------------------------

class UnknownClip(Exception):
    pass


class NothingToReplay(Exception):
    pass


class VoiceEthicsError(Exception):
    """Kept so server.py's import stays valid, and as a tripwire.

    Vokal clones nobody: TTS is a general-purpose local Piper voice, so the
    consent question this used to guard cannot arise. If cloning is ever added
    back, this is where the clip beat refuses it.
    """


class TtsError(Exception):
    pass


class _Cancelled(Exception):
    """Internal: a newer job superseded this one mid-flight."""


FAKE_DELAY_S = 1.0
FAKE_CAPTION = "This is Vokal speaking in fake mode."
NO_SPEECH = "(didn't catch that)"


def _ms(t0_ns, t1_ns=None):
    if t1_ns is None:
        t1_ns = time.perf_counter_ns()
    return int((t1_ns - t0_ns) / 1_000_000)


def _log(msg):
    print("[vokal] " + msg, flush=True)


def wav_bytes(pcm, rate):
    """Wrap raw 16-bit mono PCM in a real WAV container (stdlib, no ffmpeg)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def read_wav(path):
    """-> (pcm bytes, rate). 16-bit mono only; that is all we ever write."""
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("%s is not 16-bit mono PCM" % path)
        return w.readframes(w.getnframes()), w.getframerate()


def _resample_16k(pcm, src_rate):
    """Linear-interpolate 16-bit mono PCM to 16 kHz.

    The board always sends 16 kHz (PROTOCOL.md); this only exists so a
    mislabelled X-Sample-Rate degrades into slightly-wrong audio instead of
    chipmunk gibberish that wastes ten minutes on the day.
    """
    if src_rate == cfg.BOARD_RATE or src_rate <= 0:
        return pcm
    import numpy as np
    if len(pcm) % 2:
        pcm = pcm[:-1]
    src = np.frombuffer(pcm, dtype="<i2")
    if src.size == 0:
        return pcm
    n_out = int(src.size * cfg.BOARD_RATE / float(src_rate))
    if n_out <= 0:
        return pcm
    xs = np.linspace(0.0, src.size - 1.0, n_out)
    out = np.interp(xs, np.arange(src.size), src.astype("float32"))
    return out.astype("<i2").tobytes()


# --------------------------------------------------------------------------
# playback -- sounddevice, raw PCM straight to the card, no subprocess
# --------------------------------------------------------------------------

def _resolve_device():
    want = cfg.OUTPUT_DEVICE
    if not want:
        return None
    try:
        return int(want)
    except ValueError:
        return want


class _Player:
    """Streaming player. Synthesis feeds it; PortAudio pulls from it."""

    def __init__(self, rate):
        import sounddevice as sd
        self._sd = sd
        self.rate = rate
        self._buf = bytearray()
        self._lock = threading.Lock()
        self._eof = False
        self._cancel = False
        self._started = False
        self.first_audio_ns = 0
        self._first = threading.Event()
        self._finished = threading.Event()
        self._prebuffer = max(0, int(rate * 2 * cfg.PREBUFFER_MS / 1000))
        self._stream = None

    def _callback(self, outdata, frames, time_info, status):
        nbytes = frames * 2
        if self._cancel:
            outdata[:] = b"\x00" * nbytes
            raise self._sd.CallbackStop
        with self._lock:
            have, eof = len(self._buf), self._eof
            if not self._started:
                if have >= self._prebuffer or eof:
                    self._started = True
                else:
                    outdata[:] = b"\x00" * nbytes
                    return
            n = min(nbytes, have)
            chunk = bytes(self._buf[:n]) if n else b""
            if n:
                del self._buf[:n]
        if n:
            outdata[:n] = chunk
            if n < nbytes:
                outdata[n:] = b"\x00" * (nbytes - n)
            if not self._first.is_set():
                # THIS is the honest definition of "speaking": the driver has
                # just taken real audio from us. Anything earlier would make
                # latency_ms a lie.
                self.first_audio_ns = time.perf_counter_ns()
                self._first.set()
            if eof and n < nbytes:
                raise self._sd.CallbackStop
            return
        outdata[:] = b"\x00" * nbytes
        if eof:
            raise self._sd.CallbackStop

    def start(self):
        self._stream = self._sd.RawOutputStream(
            samplerate=self.rate, channels=1, dtype="int16",
            blocksize=max(120, self.rate // 50), device=_resolve_device(),
            latency="low", callback=self._callback,
            finished_callback=self._finished.set)
        self._stream.start()

    def feed(self, data):
        with self._lock:
            self._buf.extend(data)

    def eof(self):
        with self._lock:
            self._eof = True

    def cancel(self):
        self._cancel = True

    def wait_first_audio(self, timeout):
        return self._first.wait(timeout)

    def wait_done(self, timeout):
        return self._finished.wait(timeout)

    def close(self):
        s, self._stream = self._stream, None
        if s is None:
            return
        for fn in (s.stop, s.close):
            try:
                fn()
            except Exception:
                pass


def make_player(rate):
    p = _Player(rate)
    p.start()
    return p


# --------------------------------------------------------------------------
# text to speech -- Piper, loaded ONCE (~2.3 s), never per request
# --------------------------------------------------------------------------

_voice = None
_voice_lock = threading.Lock()
_voice_error = ""


def load_voice():
    """Load the Piper voice. Idempotent. Returns (ok, detail)."""
    global _voice, _voice_error
    with _voice_lock:
        if _voice is not None:
            return True, cfg.PIPER_VOICE
        path = cfg.PIPER_MODEL_PATH
        if not os.path.exists(path):
            have = cfg.available_voices()
            _voice_error = (
                "Piper voice not found: %s -- available in %s: %s"
                % (path, cfg.PIPER_VOICE_DIR,
                   ", ".join(have) if have else "(none)"))
            return False, _voice_error
        t0 = time.perf_counter_ns()
        try:
            from piper import PiperVoice
            _voice = PiperVoice.load(path)
        except Exception as exc:
            _voice_error = "could not load %s: %s" % (path, exc)
            return False, _voice_error
        _voice_error = ""
        _log("piper: loaded %s in %d ms" % (cfg.PIPER_VOICE, _ms(t0)))
        return True, cfg.PIPER_VOICE


def synthesize(text, on_chunk):
    """Stream `text` through Piper. Calls on_chunk(pcm_bytes, sample_rate) for
    every chunk as it is produced, so the speaker starts before the sentence has
    finished synthesising. Returns (full pcm bytes, sample rate)."""
    ok, detail = load_voice()
    if not ok:
        raise TtsError(detail)
    total = bytearray()
    rate = 22050
    for chunk in _voice.synthesize(text):
        rate = chunk.sample_rate
        data = chunk.audio_int16_bytes
        total += data
        on_chunk(data, rate)
    if not total:
        raise TtsError("piper produced no audio for %r" % text[:60])
    return bytes(total), rate


# --------------------------------------------------------------------------
# speech to text -- faster-whisper, with the hallucination guard
# --------------------------------------------------------------------------
#
# Every rule below was measured on the real demo audio today. Do not relax them
# without re-measuring on a whisper-quiet recording:
#
#  * NO initial_prompt. It made Whisper emit the prompt text itself as a fake
#    transcript segment AND lose thirty seconds of real speech.
#  * vad_filter=False. The finger does the segmentation (hold the pad, speak,
#    release). VAD trims quiet speech, and quiet speech is the whole product.
#  * condition_on_previous_text=False. Stops hallucination cascades.

# Whisper invented "Thank you." out of the trailing silence in our real clip
# today. This product SPEAKS FOR SOMEONE WHO CANNOT CORRECT IT, so a fabricated
# sentence is the worst failure it has. Anything that normalises to one of these
# is dropped rather than spoken.
_JUNK_EXACT = {
    "thank you", "thanks for watching", "please subscribe", "you", "bye",
    "thanks", "thank you for watching", "subscribe", "goodbye",
}
_JUNK_SUBSTR = ("subtitles by", "amara.org", "www.")


def _norm(s):
    """Lower-case, drop punctuation, collapse spaces -- for blocklisting."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s.lower())).strip()


def clean_transcript(segments):
    """segments -> spoken text. Drops fabrications; never invents filler.

    `segments` is an iterable of objects with .text and .no_speech_prob.
    Returns "" when nothing survives -- the caller must then say so honestly.
    """
    kept = []
    for seg in segments:
        text = (getattr(seg, "text", "") or "").strip()
        if not text:
            continue
        prob = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
        if prob > 0.6:
            _log("stt: dropped %r (no_speech_prob %.2f)" % (text[:60], prob))
            continue
        n = _norm(text)
        if not n or n in _JUNK_EXACT or any(j in n for j in _JUNK_SUBSTR):
            _log("stt: dropped hallucination %r" % text[:60])
            continue
        kept.append(text)

    # A trailing stock phrase glued onto real speech is the same fabrication as
    # a standalone one. Strip from the end.
    while kept and _norm(kept[-1]) in _JUNK_EXACT:
        _log("stt: dropped trailing %r" % kept[-1][:60])
        kept.pop()

    out = " ".join(kept).strip()
    return "" if _norm(out) in _JUNK_EXACT else out


def _run_whisper(model, audio):
    """audio: float32 numpy array at 16 kHz. -> cleaned text."""
    segments, _info = model.transcribe(
        audio,
        language="en",
        beam_size=cfg.WHISPER_BEAM,
        vad_filter=False,                  # the finger does the segmentation
        condition_on_previous_text=False,  # no hallucination cascades
        # initial_prompt is deliberately absent -- see the note above.
    )
    return clean_transcript(segments)


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------

class Job(object):
    def __init__(self, kind, source, utterance_id=0, pcm=None, sample_rate=0,
                 text=None, clip_id=""):
        self.kind = kind                # live | clip | speak | replay
        self.source = source            # live | clip   (PROTOCOL.md /state)
        self.utterance_id = utterance_id
        self.pcm = pcm
        self.sample_rate = sample_rate or cfg.BOARD_RATE
        self.text = text
        self.clip_id = clip_id
        self.cancelled = threading.Event()
        self.t0 = time.perf_counter_ns()

    def label(self):
        if self.kind == "live":
            return "live#%d" % self.utterance_id
        if self.kind == "clip":
            return "clip:%s" % self.clip_id
        return self.kind


class Engine(object):

    def __init__(self):
        self._cv = threading.Condition()
        self._pending = None
        self._current = None
        self._player = None
        self._stop = False

        self._slock = threading.Lock()
        self._status = "idle"
        self._caption = ""
        self._latency_ms = 0
        self._seq = 0
        self._source = ""

        self._last = None       # replay cache: real audio bytes, not a promise
        self._whisper = None
        self._whisper_error = ""
        self._tts_ok = bool(cfg.FAKE)
        self._tts_detail = "fake mode" if cfg.FAKE else "not loaded yet"
        self._utt_fallback_id = 0

    # -- lifecycle ------------------------------------------------------
    def start(self):
        threading.Thread(target=self._run_worker, name="vokal-worker",
                         daemon=True).start()
        if not cfg.FAKE:
            # Both models load off the request path, so the first press is not
            # the one that pays for them.
            threading.Thread(target=self._load_whisper, name="vokal-whisper",
                             daemon=True).start()
            threading.Thread(target=self._load_tts, name="vokal-piper",
                             daemon=True).start()

    def shutdown(self):
        with self._cv:
            self._stop = True
            if self._current is not None:
                self._current.cancelled.set()
            p = self._player
            self._cv.notify_all()
        if p is not None:
            try:
                p.cancel()
            except Exception:
                pass

    def _load_whisper(self):
        self._whisper, self._whisper_error = load_whisper()

    def _load_tts(self):
        self._tts_ok, self._tts_detail = load_voice()
        if not self._tts_ok:
            _log("piper: " + self._tts_detail)

    # -- state ----------------------------------------------------------
    def snapshot(self):
        with self._slock:
            return {"status": self._status, "caption": self._caption,
                    "latency_ms": self._latency_ms, "seq": self._seq,
                    "source": self._source}

    def _set_status(self, status, source=None):
        with self._slock:
            self._status = status
            if source is not None:
                self._source = source

    def _set_caption(self, caption, status=None, source=None, latency_ms=None):
        """Set the caption and ALWAYS bump seq -- PROTOCOL.md: seq lets the
        board tell "same caption again" from "a new caption that happens to have
        the same text", without diffing strings on an ESP32."""
        with self._slock:
            self._caption = caption
            self._seq += 1
            if status is not None:
                self._status = status
            if source is not None:
                self._source = source
            if latency_ms is not None:
                self._latency_ms = latency_ms

    def health(self):
        problems = list(cfg.PROBLEMS)
        if self._whisper_error:
            problems.append("whisper: " + self._whisper_error)
        if not cfg.FAKE and not self._tts_ok:
            problems.append("tts: " + self._tts_detail)
        whisper_ok = cfg.FAKE or self._whisper is not None
        tts_ok = bool(cfg.FAKE or self._tts_ok)
        return {
            "ok": bool(whisper_ok and tts_ok),
            "whisper": bool(whisper_ok),
            "tts": tts_ok,
            # No cloning exists any more, so this contract key now answers "is a
            # voice loaded and ready" -- which is what the board actually needs.
            "voice_id_set": tts_ok,
            "fake": cfg.FAKE,
            "voice": cfg.PIPER_VOICE,
            "engine": "piper (local, offline)",
            "audio": "sounddevice",
            "audio_detail": cfg.OUTPUT_DEVICE or "system default output",
            "clips": sorted(self.list_clips().keys()),
            "can_replay": self._last is not None,
            "problems": problems,
        }

    # -- clips ----------------------------------------------------------
    def list_clips(self):
        """Pre-rendered clips only: <id>_rendered.wav plus <id>.txt.

        The clip beat is a cached WAV and a cached caption. There is no model in
        this path at all -- that is deliberate, and it is why it cannot fail.
        """
        out = {}
        d = cfg.DEMO_CLIPS_DIR
        try:
            names = sorted(os.listdir(d))
        except OSError:
            return out
        for name in names:
            if not name.endswith("_rendered.wav"):
                continue
            clip_id = name[:-len("_rendered.wav")]
            caption = ""
            try:
                with open(os.path.join(d, clip_id + ".txt"), "r",
                          encoding="utf-8") as fh:
                    caption = " ".join(fh.read().split())
            except OSError:
                pass
            out[clip_id] = {"path": os.path.join(d, name), "caption": caption}
        return out

    # -- submission -----------------------------------------------------
    def _submit(self, job):
        """Queue a job. One voice at a time; the newest press wins."""
        with self._cv:
            if self._pending is not None:
                self._pending.cancelled.set()
            self._pending = job
            if self._current is not None:
                self._current.cancelled.set()
            player = self._player
            self._cv.notify()
        if player is not None:
            try:
                player.cancel()      # cheap flag; never blocks
            except Exception:
                pass
        return job

    def submit_live(self, pcm, sample_rate, utterance_id):
        if not utterance_id:
            self._utt_fallback_id += 1
            utterance_id = self._utt_fallback_id
        return self._submit(Job("live", "live", utterance_id=utterance_id,
                                pcm=pcm, sample_rate=sample_rate))

    def submit_clip(self, clip_id):
        if clip_id not in self.list_clips():
            raise UnknownClip(clip_id)
        return self._submit(Job("clip", "clip", clip_id=clip_id))

    def submit_speak(self, text):
        return self._submit(Job("speak", "live", text=text))

    def submit_replay(self):
        if self._last is None:
            raise NothingToReplay()
        return self._submit(Job("replay", self._last.get("source") or "live"))

    # -- worker ---------------------------------------------------------
    def _run_worker(self):
        while True:
            with self._cv:
                while self._pending is None and not self._stop:
                    self._cv.wait(0.25)
                if self._stop:
                    return
                job = self._pending
                self._pending = None
                self._current = job
                self._player = None
            try:
                self._run_job(job)
            except _Cancelled:
                _log("%s: superseded" % job.label())
            except Exception as exc:
                _log("%s: FAILED: %s" % (job.label(), exc))
                self._set_caption(str(exc) or exc.__class__.__name__,
                                  status="error", source=job.source)
            finally:
                with self._cv:
                    self._current = None
                    p, self._player = self._player, None
                    idle = self._pending is None and not self._stop
                if p is not None:
                    p.close()
                if idle:
                    self._set_status("idle")

    def _check(self, job):
        if job.cancelled.is_set():
            raise _Cancelled()

    def _run_job(self, job):
        if cfg.FAKE:
            return self._run_fake(job)
        if job.kind == "clip":
            self._run_clip(job)
        elif job.kind == "replay":
            self._run_replay(job)
        elif job.kind == "speak":
            self._set_status("processing", source="live")
            self._speak(job, job.text or "")
        else:
            self._run_live(job)

    def _run_fake(self, job):
        """--fake: canned caption, canned delay, no models, no sound card. The
        firmware has to be integrable before any of the AI stack is running."""
        self._set_status("processing", source=job.source)
        time.sleep(FAKE_DELAY_S)
        if job.kind == "clip":
            caption = (self.list_clips().get(job.clip_id) or {}).get("caption")
            caption = caption or job.clip_id
        elif job.kind == "replay":
            if self._last is None:
                raise NothingToReplay()
            caption = self._last["caption"]
        else:
            caption = (job.text or "").strip() or FAKE_CAPTION
        self._set_caption(caption, status="speaking", source=job.source,
                          latency_ms=_ms(job.t0))
        self._last = {"pcm": b"", "rate": 22050, "caption": caption,
                      "source": job.source}
        time.sleep(0.5)

    # -- the live beat: STT -> Piper -> speakers --------------------------
    def _run_live(self, job):
        self._set_status("processing", source="live")
        pcm = job.pcm or b""
        if len(pcm) < 2:
            raise ValueError("no audio received (%d bytes)" % len(pcm))
        if len(pcm) % 2:
            pcm = pcm[:-1]        # truncated upload; drop the half sample
        if cfg.SAVE_CAPTURES:
            self._save_capture(job, pcm)
        if job.sample_rate != cfg.BOARD_RATE:
            _log("%s: X-Sample-Rate is %d, resampling"
                 % (job.label(), job.sample_rate))
            pcm = _resample_16k(pcm, job.sample_rate)
        self._check(job)

        text = transcribe(pcm, cfg.BOARD_RATE)
        self._check(job)
        if not text:
            # Everything was silence or fabrication. Say so honestly -- never
            # invent filler for someone who cannot correct it.
            self._set_caption(NO_SPEECH, status="error", source="live")
            return
        self._speak(job, text)

    # -- the clip beat: a cached WAV. No STT, no TTS, no model. -----------
    def _run_clip(self, job):
        """Structurally incapable of touching a model: it reads a pre-rendered
        WAV and a text file and plays the bytes. Rendered this morning; the one
        beat in the demo that cannot fail."""
        meta = self.list_clips().get(job.clip_id)
        if meta is None:
            raise UnknownClip(job.clip_id)
        self._set_status("processing", source="clip")
        pcm, rate = read_wav(meta["path"])
        caption = meta["caption"] or os.path.basename(meta["path"])
        self._check(job)
        self._play(job, pcm, rate, caption, "clip")

    # -- replay: the cached audio of the last success ---------------------
    def _run_replay(self, job):
        """No STT, no TTS. This is the on-stage fallback for when the mic or
        the Wi-Fi dies, so the cache holds decoded PCM, not a text prompt."""
        last = self._last
        if last is None:
            raise NothingToReplay()
        self._set_status("processing", source=last["source"])
        self._play(job, last["pcm"], last["rate"], last["caption"],
                   last["source"], remember=False)

    # -- synthesis + playback ---------------------------------------------
    def _speak(self, job, text):
        text = (text or "").strip()
        if not text:
            raise ValueError("nothing to speak")
        state = {"player": None}
        t0 = time.perf_counter_ns()

        def on_chunk(data, rate):
            self._check(job)
            p = state["player"]
            if p is None:
                # Opened on the first chunk, so the stream is created at Piper's
                # own sample rate whatever voice is configured.
                p = make_player(rate)
                state["player"] = p
                with self._cv:
                    self._player = p
            p.feed(data)

        pcm, rate = synthesize(text, on_chunk)
        player = state["player"]
        if player is None:
            raise TtsError("piper produced no audio")
        player.eof()
        _log("%s: piper %d ms for %.1f s of audio"
             % (job.label(), _ms(t0), len(pcm) / float(rate * 2)))
        self._finish(job, player, pcm, rate, text, job.source)

    def _play(self, job, pcm, rate, caption, source, remember=True):
        """Play PCM we already have. Used by the clip beat and by replay."""
        player = make_player(rate)
        with self._cv:
            self._player = player
        player.feed(pcm)
        player.eof()
        self._finish(job, player, pcm, rate, caption, source, remember=remember)

    def _finish(self, job, player, pcm, rate, caption, source, remember=True):
        """Wait for the first frame to actually reach the device, and only then
        report `speaking` -- not when the call was made."""
        if not player.wait_first_audio(5.0):
            raise TtsError("the sound card never took the audio")
        latency = _ms(job.t0, player.first_audio_ns)
        self._set_caption(caption, status="speaking", source=source,
                          latency_ms=latency)
        _log("%s: FIRST AUDIO at %d ms -- %r"
             % (job.label(), latency, caption[:70]))
        if remember:
            self._last = {"pcm": pcm, "rate": rate, "caption": caption,
                          "source": source}
        player.wait_done(len(pcm) / float(rate * 2) + 5.0)
        self._check(job)

    def _save_capture(self, job, pcm):
        """Keep every utterance on disk. Costs nothing and has already saved us
        one debugging session -- you cannot re-press a moment on stage."""
        try:
            os.makedirs(cfg.CAPTURES_DIR, exist_ok=True)
            path = os.path.join(cfg.CAPTURES_DIR, "utt_%s_%04d.wav"
                                % (time.strftime("%H%M%S"), job.utterance_id))
            with open(path, "wb") as fh:
                fh.write(wav_bytes(pcm, cfg.BOARD_RATE))
            return path
        except Exception as exc:
            _log("capture not saved: %s" % exc)
            return ""


engine = Engine()


# --------------------------------------------------------------------------
# module-level API
# --------------------------------------------------------------------------
#
# server.py drives these directly: transcribe(pcm, rate) -> str,
# speak(text) -> latency dict, play_clip(id) -> latency dict, plus
# warmup/stop/health/list_clips. They are blocking and synchronous; server.py
# owns its own worker thread and its own /state, so this layer owns no status.
# Engine (above) is the same primitives behind a queue, kept for the endpoint
# style PROTOCOL.md was first written against. Both share ONE whisper and ONE
# Piper voice -- the models are module-level, so nothing is ever loaded twice.

VOICE_NAME = cfg.PIPER_VOICE

_whisper = None
_whisper_error = ""
_whisper_lock = threading.Lock()
_active_lock = threading.Lock()
_active = None          # the player currently making noise, for stop()


def load_whisper():
    """Load faster-whisper once. Returns (model_or_None, error_string)."""
    global _whisper, _whisper_error
    with _whisper_lock:
        if _whisper is not None:
            return _whisper, ""
        t0 = time.perf_counter_ns()
        try:
            from faster_whisper import WhisperModel
            _whisper = WhisperModel(cfg.WHISPER_MODEL, device=cfg.WHISPER_DEVICE,
                                    compute_type=cfg.WHISPER_COMPUTE)
            _whisper_error = ""
            _log("whisper: loaded %s in %d ms" % (cfg.WHISPER_MODEL, _ms(t0)))
        except Exception as exc:
            _whisper_error = str(exc)
            _log("whisper: FAILED to load: %s" % exc)
        return _whisper, _whisper_error


def warmup():
    """Load both models up front so the first press does not pay for them."""
    model, werr = load_whisper()
    tts_ok, detail = load_voice()
    problems = []
    if model is None:
        problems.append("whisper: " + werr)
    if not tts_ok:
        problems.append("tts: " + detail)
    return {"whisper": model is not None, "tts": tts_ok,
            "voice": cfg.PIPER_VOICE, "engine": "piper (local, offline)",
            "problems": problems}


def health():
    return {"whisper": _whisper is not None, "tts": _voice is not None,
            "voice": cfg.PIPER_VOICE, "engine": "piper (local, offline)",
            "problems": list(cfg.PROBLEMS)}


def list_clips():
    return engine.list_clips()


def transcribe(pcm, sample_rate=None):
    """Raw 16-bit mono PCM from the board -> the words that were actually said.

    Returns "" when nothing survives the hallucination guard. The caller must
    say so honestly rather than invent filler -- this product speaks for someone
    who cannot correct it.
    """
    model, err = load_whisper()
    if model is None:
        raise TtsError("whisper is not loaded (%s)" % (err or "still starting up"))
    pcm = bytes(pcm or b"")
    if len(pcm) % 2:
        pcm = pcm[:-1]            # truncated upload; drop the half sample
    rate = int(sample_rate or cfg.BOARD_RATE)
    if rate != cfg.BOARD_RATE:
        _log("stt: X-Sample-Rate is %d, resampling to %d" % (rate, cfg.BOARD_RATE))
        pcm = _resample_16k(pcm, rate)
    if len(pcm) < 2:
        return ""
    import numpy as np
    audio = np.frombuffer(pcm, dtype="<i2").astype("float32") / 32768.0
    t0 = time.perf_counter_ns()
    text = _run_whisper(model, audio)
    _log("stt: %d ms for %.1f s of audio -> %r"
         % (_ms(t0), len(pcm) / float(cfg.BOARD_RATE * 2), text[:60]))
    return text


def _play_blocking(player, pcm, rate, t0):
    """Wait for the first frame to actually reach the device, then for the end.
    first_audio_ms is measured when the driver TOOK audio, not when we asked."""
    global _active
    with _active_lock:
        _active = player
    try:
        if not player.wait_first_audio(5.0):
            raise TtsError("the sound card never took the audio")
        ms = _ms(t0, player.first_audio_ns)
        _log("FIRST AUDIO at %d ms" % ms)
        player.wait_done(len(pcm) / float(rate * 2) + 5.0)
        return {"first_audio_ms": ms, "pcm": pcm, "rate": rate}
    finally:
        with _active_lock:
            if _active is player:
                _active = None
        player.close()


def speak(text):
    """Synthesise `text` with Piper and play it. Blocks until it has finished.

    Playback starts on Piper's FIRST chunk, so the speaker is already talking
    while the rest of the sentence is still being synthesised.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("nothing to speak")
    t0 = time.perf_counter_ns()
    state = {"p": None}

    def on_chunk(data, rate):
        if state["p"] is None:
            # Opened on the first chunk so the stream is created at Piper's own
            # sample rate, whatever voice is configured.
            state["p"] = make_player(rate)
        state["p"].feed(data)

    pcm, rate = synthesize(text, on_chunk)
    player = state["p"]
    if player is None:
        raise TtsError("piper produced no audio")
    player.eof()
    _log("piper: %d ms for %.1f s of audio" % (_ms(t0), len(pcm) / float(rate * 2)))
    out = _play_blocking(player, pcm, rate, t0)
    out["text"] = text
    return out


def play_wav(path):
    """Play a WAV we already have. No model is touched."""
    t0 = time.perf_counter_ns()
    pcm, rate = read_wav(path)
    player = make_player(rate)
    player.feed(pcm)
    player.eof()
    out = _play_blocking(player, pcm, rate, t0)
    out["wav_path"] = path
    return out


def play_clip(clip_id):
    """The clip beat: play the PRE-RENDERED WAV and nothing else.

    There is deliberately no path from here into whisper or Piper. The clip was
    rendered ahead of time and sits on disk, so this beat cannot be broken by a
    model, a microphone, or a network -- it is the one that has to work.
    """
    meta = engine.list_clips().get(clip_id)
    if meta is None:
        raise UnknownClip(clip_id)
    out = play_wav(meta["path"])
    out["text"] = meta["caption"]
    return out


def stop():
    """Cut playback that is already in flight. Cheap; never blocks."""
    with _active_lock:
        p = _active
    if p is not None:
        try:
            p.cancel()
        except Exception:
            pass
