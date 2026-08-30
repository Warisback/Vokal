#!/usr/bin/env python3
"""
Host-side client for the Vokal puck.

Polls the puck, downloads each new recording, runs STT, and posts the
transcript back so it appears on the device screen.

    python3 tools/puck_client.py

Setup:
  1. Join wifi "vokal-puck", password "vokal1234".
     NOTE: this network has no internet. Install your STT model and any
     packages BEFORE joining, or you will not be able to pip install.
  2. Fill in transcribe() below.
  3. Run this. Press RECORD then STOP on the puck.

Audio format is 16 kHz mono 16-bit PCM WAV -- exactly what Whisper wants,
so no resampling is needed.

Standard library only, deliberately: you cannot pip install while joined
to the puck's access point.
"""
import json, os, sys, time, urllib.request, datetime

PUCK    = "http://192.168.4.1"
OUTDIR  = "recordings"
POLL_S  = 1.0


def get(path, timeout=10):
    with urllib.request.urlopen(f"{PUCK}{path}", timeout=timeout) as r:
        return r.read()


def post(path, body, timeout=10):
    req = urllib.request.Request(f"{PUCK}{path}", data=body.encode("utf-8"),
                                 method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------------
#  THE ONLY PART YOU NEED TO WRITE
# ---------------------------------------------------------------------
def transcribe(wav_path, marks):
    """Return the transcript as a string.

    `marks` is a list of {"ms": int, "type": "important"|"decision"|
    "action"|"question"} -- moments a human flagged while the
    conversation was happening. Feed them to your structuring step: they
    are the signal a plain transcript cannot recover.

    faster-whisper:
        from faster_whisper import WhisperModel
        model = WhisperModel("base.en", device="cpu", compute_type="int8")
        segments, _ = model.transcribe(wav_path)
        return " ".join(s.text for s in segments)

    whisper.cpp:
        import subprocess
        out = subprocess.run(
            ["./main", "-m", "models/ggml-base.en.bin", "-f", wav_path, "-nt"],
            capture_output=True, text=True)
        return out.stdout.strip()
    """
    raise NotImplementedError("fill me in")


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    try:
        post("/time", datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
        print("set puck clock")
    except Exception as e:
        print("could not set clock:", e)

    last = -1
    print(f"watching {PUCK} -- press RECORD then STOP on the puck")
    while True:
        try:
            st = json.loads(get("/status", timeout=3))
        except Exception:
            print("puck unreachable -- still on the vokal-puck wifi?")
            time.sleep(2); continue

        # Wait for a NEW take that has finished recording. Without the take
        # id you cannot tell a fresh recording from one already downloaded.
        if st["take"] != last and not st["recording"] and st["bytes"] > 0:
            last = st["take"]
            stamp = (st.get("started") or "").replace(":", "-") or f"take{st['take']}"
            path = os.path.join(OUTDIR, f"take{st['take']}_{stamp}.wav")

            print(f"\ntake {st['take']}: {st['bytes']/1024:.0f} KB, "
                  f"{st['ms']/1000:.1f}s, {st['marks']} marks")
            with open(path, "wb") as f:
                f.write(get("/audio.wav", timeout=60))
            marks = json.loads(get("/marks.json"))["marks"]
            print(f"  saved {path}")
            for m in marks:
                print(f"  mark {m['ms']/1000:6.1f}s  {m['type']}")

            try:
                text = transcribe(path, marks)
                print(f"  transcript: {text[:200]}")
                post("/transcript", text)
                print("  posted back to the puck")
            except NotImplementedError:
                post("/transcript", f"[{st['bytes']//1024} KB downloaded; "
                                    f"STT not wired up yet]")
                print("  transcribe() not implemented")
            except Exception as e:
                print("  STT failed:", e)
                post("/transcript", f"[STT error: {e}]")

        time.sleep(POLL_S)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
