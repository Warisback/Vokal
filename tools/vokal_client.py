#!/usr/bin/env python3
r"""
Vokal host client -- the full input/output loop.

    board mic  ->  wifi  ->  laptop STT  ->  laptop TTS  ->  LAPTOP SPEAKERS
                                                         ->  caption back on the puck

This is tools/puck_client.py with the two halves the demo needs filled in:
transcribe() runs faster-whisper locally, and the transcript is then SPOKEN
OUT LOUD through the laptop's speakers with Piper before being posted back to
the device screen.

    C:\vokal-venv\Scripts\python.exe tools\vokal_client.py

ORDER MATTERS -- read this before the demo:
  1. Run this FIRST, on normal internet, and let it finish warming up. It
     loads whisper and the Piper voice into memory (~5 s) and neither can be
     downloaded later.
  2. THEN join wifi "vokal-puck" / "vokal1234". That network has NO INTERNET.
     Nothing here reaches the network once warm, which is exactly why this
     runs on local models instead of a cloud API -- a cloud TTS would be
     unreachable at the moment we need it.
  3. Press RECORD, speak, press STOP on the puck.

The board serves 16 kHz mono 16-bit PCM WAV, which is already the format
whisper wants -- no resampling anywhere in this path.
"""
import json, os, sys, time, wave, datetime, urllib.request, urllib.error

# Line-buffer stdout. Redirected output otherwise buffers 8 KB and the
# operator sees nothing while the loop is plainly working.
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "laptop"))
import pipeline

PUCK   = os.environ.get("VOKAL_PUCK", "http://192.168.4.1")
OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "laptop", "captures")
POLL_S = 1.0


def get(path, timeout=10):
    with urllib.request.urlopen(f"{PUCK}{path}", timeout=timeout) as r:
        return r.read()


def post(path, body, timeout=10):
    req = urllib.request.Request(f"{PUCK}{path}", data=body.encode("utf-8"), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def handle_take(st):
    """Download one take, transcribe it, speak it, put the caption on the puck."""
    t0 = time.perf_counter()
    stamp = (st.get("started") or "").replace(":", "-") or f"take{st['take']}"
    path = os.path.join(OUTDIR, f"take{st['take']}_{stamp}.wav")

    print(f"\ntake {st['take']}: {st['bytes']/1024:.0f} KB, {st['ms']/1000:.1f}s, "
          f"{st.get('marks', 0)} marks")

    wav = get("/audio.wav", timeout=60)
    with open(path, "wb") as f:
        f.write(wav)
    t_dl = time.perf_counter()
    print(f"  download   {t_dl-t0:6.2f}s  -> {os.path.basename(path)}")

    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        pcm = w.readframes(w.getnframes())

    # transcribe() applies the hallucination guard: segments with a high
    # no_speech_prob are dropped, and Whisper's stock inventions ("Thank you.",
    # "Please subscribe") are stripped. This device speaks for someone who
    # cannot correct it, so it must stay silent rather than invent words.
    text = pipeline.transcribe(pcm, rate)
    t_stt = time.perf_counter()
    print(f"  transcribe {t_stt-t_dl:6.2f}s  \"{text}\"")

    if not text:
        print("  nothing intelligible -- not speaking, not inventing filler")
        post("/transcript", "(didn't catch that)")
        return

    # THE OUTPUT HALF: say it out loud on the laptop speakers.
    lat = pipeline.speak(text)
    t_tts = time.perf_counter()
    first = (lat or {}).get("first_audio_ms")
    print(f"  SPOKE      {t_tts-t_stt:6.2f}s  first audio {first if first is not None else '?'} ms")

    post("/transcript", text)
    print(f"  caption back on puck")
    print(f"  TOTAL      {t_tts-t0:6.2f}s  stop-press to voice-in-the-room")


def main():
    os.makedirs(OUTDIR, exist_ok=True)

    print("warming up local models (do this BEFORE joining the puck's wifi)...")
    t = time.perf_counter()
    pipeline.warmup()
    print(f"ready in {time.perf_counter()-t:.1f}s -- voice: {pipeline.VOICE_NAME}\n")

    try:
        post("/time", datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), timeout=3)
        print("set puck clock")
    except Exception as e:
        print(f"could not set clock ({e}) -- harmless, carrying on")

    last = -1
    print(f"watching {PUCK} -- press RECORD then STOP on the puck")
    while True:
        try:
            st = json.loads(get("/status", timeout=3))
        except Exception:
            print("puck unreachable -- still joined to the vokal-puck wifi?")
            time.sleep(2)
            continue

        # The take id is what distinguishes a fresh recording from one already
        # handled; bytes>0 and not recording means it has finished.
        if st["take"] != last and not st["recording"] and st["bytes"] > 0:
            last = st["take"]
            try:
                handle_take(st)
            except Exception as e:
                print(f"  FAILED: {e}")
                try:
                    post("/transcript", f"[error: {e}]")
                except Exception:
                    pass

        time.sleep(POLL_S)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
