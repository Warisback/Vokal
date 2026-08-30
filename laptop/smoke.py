"""Vokal smoke test -- hits every endpoint in PROTOCOL.md against a running
server and prints pass/fail plus the measured latency of each call.

No board required, no models required, nothing installed required: this is
stdlib only, so it runs against a --fake server on a machine with nothing but
fastapi and uvicorn.

    C:\\vokal-venv\\Scripts\\python.exe smoke.py
    C:\\vokal-venv\\Scripts\\python.exe smoke.py --port 8000
    C:\\vokal-venv\\Scripts\\python.exe smoke.py --base http://192.168.4.211:8000

Exit code is 0 only if every check passed, so it can gate a rehearsal.
"""

import json
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CAPTURES_DIR = os.path.join(BASE_DIR, "captures")

# The board polls /state at 3 Hz and PROTOCOL.md gives it a 50 ms budget.
STATE_BUDGET_MS = 50.0
# A POST must return long before the board's UI feels stuck.
POST_BUDGET_MS = 250.0

RESULTS = []


# --------------------------------------------------------------------------
# tiny HTTP client
# --------------------------------------------------------------------------

def http(method, base, path, body=None, headers=None, timeout=10.0):
    """-> (status, parsed_body_or_text, elapsed_ms). Never raises for 4xx/5xx."""
    url = base.rstrip("/") + path
    hdrs = dict(headers or {})
    data = body
    if isinstance(body, (dict, list)):
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.getcode()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    except Exception as exc:
        return 0, str(exc), (time.perf_counter() - t0) * 1000.0
    ms = (time.perf_counter() - t0) * 1000.0
    text = raw.decode("utf-8", "replace")
    try:
        return status, json.loads(text), ms
    except ValueError:
        return status, text, ms


def record(name, ok, ms, detail=""):
    RESULTS.append((name, bool(ok), ms, detail))
    print("%-4s %-34s %8.1f ms  %s"
          % ("PASS" if ok else "FAIL", name, ms, detail), flush=True)
    return ok


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def sine_pcm(seconds=1.5, rate=16000, freq=220.0, amp=8000):
    """16 kHz / 16-bit signed LE / mono -- exactly the board's wire format."""
    n = int(seconds * rate)
    out = bytearray()
    for i in range(n):
        out += struct.pack("<h", int(amp * math.sin(2.0 * math.pi * freq * i / rate)))
    return bytes(out)


def get_state(base):
    status, body, ms = http("GET", base, "/state")
    return (body if isinstance(body, dict) else {}), ms


def wait_for_seq(base, seq_before, timeout=30.0):
    """Poll /state the way the board does, until the caption counter moves."""
    t0 = time.perf_counter()
    seen = []
    while time.perf_counter() - t0 < timeout:
        st, _ms = get_state(base)
        if st.get("seq", 0) != seq_before:
            seen.append(st)
            return st
        time.sleep(0.05)
    return None


def wait_for_idle(base, timeout=30.0):
    t0 = time.perf_counter()
    while time.perf_counter() - t0 < timeout:
        st, _ms = get_state(base)
        if st.get("status") in ("idle", "error"):
            return st
        time.sleep(0.05)
    return {}


def count_captures():
    try:
        return len([f for f in os.listdir(CAPTURES_DIR)
                    if f.lower().endswith(".wav") and f != "last_spoken.wav"])
    except OSError:
        return -1


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------

def check_health(base):
    status, body, ms = http("GET", base, "/health")
    ok = status == 200 and isinstance(body, dict)
    missing = []
    if ok:
        # PROTOCOL.md froze these four keys; the board reads only these.
        for k in ("ok", "whisper", "tts", "voice_id_set"):
            if k not in body:
                missing.append(k)
        ok = not missing
    detail = ("missing keys %s" % missing) if missing else (
        "mode=%s whisper=%s tts=%s voice=%s%s"
        % (body.get("mode", "?"), body.get("whisper"), body.get("tts"),
           body.get("voice_id_set"),
           (" problems=%s" % body.get("problems")) if body.get("problems") else "")
        if isinstance(body, dict) else str(body)[:80])
    record("GET  /health", ok, ms, detail)
    return body if isinstance(body, dict) else {}


def check_state_shape(base):
    status, body, ms = http("GET", base, "/state")
    need = ("status", "caption", "latency_ms", "seq", "source")
    ok = status == 200 and isinstance(body, dict) and all(k in body for k in need)
    if ok:
        ok = body["status"] in ("idle", "listening", "processing", "speaking", "error")
    detail = ("status=%s seq=%s source=%r"
              % (body.get("status"), body.get("seq"), body.get("source"))
              if isinstance(body, dict) else str(body)[:80])
    record("GET  /state (shape)", ok, ms, detail)


def check_state_latency(base, n=20):
    """The board polls this at 3 Hz with a 50 ms budget. A slow /state is a
    device that feels dead in the hand."""
    times = []
    for _ in range(n):
        _st, ms = get_state(base)
        times.append(ms)
        time.sleep(0.01)
    times.sort()
    p50 = times[len(times) // 2]
    worst = times[-1]
    ok = worst < STATE_BUDGET_MS
    record("GET  /state x%d (<%dms)" % (n, int(STATE_BUDGET_MS)), ok, p50,
           "p50=%.1f worst=%.1f budget=%.0f" % (p50, worst, STATE_BUDGET_MS))


def check_root(base):
    status, body, ms = http("GET", base, "/")
    ok = status == 200 and "utterance" in str(body)
    record("GET  /", ok, ms, "%d bytes of help text" % len(str(body)))


def check_replay_empty(base):
    """Before anything has been spoken /replay must say 409, not pretend."""
    status, body, ms = http("POST", base, "/replay", body=b"")
    ok = status in (202, 409)
    note = ("409 nothing spoken yet (fresh server)" if status == 409
            else "202 (something was already cached)")
    record("POST /replay (cold)", ok, ms, note if ok else "status=%s %s" % (status, body))
    return status


def check_speak_validation(base):
    status, body, ms = http("POST", base, "/speak", body={})
    ok = status == 400
    record("POST /speak (no text -> 400)", ok, ms,
           "status=%s %s" % (status, (body or {}).get("error", "")
                             if isinstance(body, dict) else body))


def check_speak(base):
    text = "Vokal smoke test. My voice, out loud."
    st0, _ = get_state(base)
    seq0 = st0.get("seq", 0)
    status, body, ms = http("POST", base, "/speak", body={"text": text})
    ok = status == 202 and isinstance(body, dict) and body.get("ok") is True
    fast = ms < POST_BUDGET_MS
    record("POST /speak", ok and fast, ms,
           "202 in %.1f ms (budget %.0f)" % (ms, POST_BUDGET_MS) if ok
           else "status=%s %s" % (status, body))

    # /state must keep answering while the pipeline is working -- this is the
    # single most important property of the whole server.
    _st, sms = get_state(base)
    record("GET  /state while busy", sms < STATE_BUDGET_MS, sms,
           "answered in %.1f ms mid-job" % sms)

    st = wait_for_seq(base, seq0)
    got = (st or {}).get("caption", "")
    ok2 = st is not None and got == text
    record("     caption + seq updated", ok2, 0.0,
           "seq %s -> %s caption=%r" % (seq0, (st or {}).get("seq"), got[:40]))
    fin = wait_for_idle(base)
    record("     status returns to idle", fin.get("status") == "idle", 0.0,
           "status=%s latency_ms=%s" % (fin.get("status"), fin.get("latency_ms")))


def check_utterance(base):
    pcm = sine_pcm(1.5)
    before = count_captures()
    st0, _ = get_state(base)
    seq0 = st0.get("seq", 0)
    status, body, ms = http(
        "POST", base, "/utterance", body=pcm,
        headers={"Content-Type": "application/octet-stream",
                 "X-Sample-Rate": "16000", "X-Utterance-Id": "4242"},
        timeout=30.0)
    ok = (status == 202 and isinstance(body, dict) and body.get("ok") is True
          and body.get("utterance_id") == 4242)
    record("POST /utterance (%d KB PCM)" % (len(pcm) // 1024), ok, ms,
           "202, utterance_id echoed, %.1f ms" % ms if ok
           else "status=%s %s" % (status, body))

    _st, sms = get_state(base)
    record("GET  /state while transcribing", sms < STATE_BUDGET_MS, sms,
           "answered in %.1f ms mid-job" % sms)

    st = wait_for_seq(base, seq0, timeout=60.0)
    record("     caption produced", st is not None, 0.0,
           "caption=%r latency_ms=%s" % ((st or {}).get("caption", "")[:40],
                                         (st or {}).get("latency_ms")))
    wait_for_idle(base, timeout=60.0)

    after = count_captures()
    if before < 0:
        record("     capture WAV written", True, 0.0,
               "skipped (captures/ not on this machine)")
    else:
        record("     capture WAV written", after > before, 0.0,
               "%d -> %d files in laptop/captures" % (before, after))


def check_clip(base, clips):
    status, body, ms = http("POST", base, "/demo/trigger",
                            body={"clip_id": "no_such_clip"})
    record("POST /demo/trigger (unknown -> 404)", status == 404, ms,
           "status=%s clips=%s" % (status, (body or {}).get("clips")
                                   if isinstance(body, dict) else body))

    clip_id = "clip1" if "clip1" in clips else (clips[0] if clips else "")
    if not clip_id:
        record("POST /demo/trigger", False, 0.0,
               "no clips on the server -- the clip beat cannot run")
        return
    st0, _ = get_state(base)
    seq0 = st0.get("seq", 0)
    status, body, ms = http("POST", base, "/demo/trigger", body={"clip_id": clip_id})
    ok = status == 202 and isinstance(body, dict) and body.get("clip_id") == clip_id
    record("POST /demo/trigger (%s)" % clip_id, ok and ms < POST_BUDGET_MS, ms,
           "202 in %.1f ms" % ms if ok else "status=%s %s" % (status, body))
    st = wait_for_seq(base, seq0, timeout=60.0)
    ok2 = st is not None and st.get("source") == "clip"
    record("     clip caption + source=clip", ok2, 0.0,
           "source=%r caption=%r" % ((st or {}).get("source"),
                                     (st or {}).get("caption", "")[:40]))
    wait_for_idle(base, timeout=60.0)


def check_replay(base):
    """The on-stage fallback. After anything has been spoken this must work."""
    st0, _ = get_state(base)
    seq0 = st0.get("seq", 0)
    status, body, ms = http("POST", base, "/replay", body=b"")
    ok = status == 202 and isinstance(body, dict) and body.get("ok") is True
    record("POST /replay (warm)", ok and ms < POST_BUDGET_MS, ms,
           "202 in %.1f ms" % ms if ok else "status=%s %s" % (status, body))
    st = wait_for_seq(base, seq0, timeout=60.0)
    record("     replayed caption", st is not None, 0.0,
           "caption=%r" % ((st or {}).get("caption", "")[:40]))
    wait_for_idle(base, timeout=60.0)


def check_supersede(base):
    """One voice at a time: a second press must win, not queue up behind the
    first. Two voices over each other on stage is worse than a lost sentence."""
    http("POST", base, "/speak", body={"text": "First sentence, superseded."})
    time.sleep(0.05)
    status, _body, ms = http("POST", base, "/speak",
                             body={"text": "Second sentence wins."})
    ok = status == 202
    fin = wait_for_idle(base, timeout=60.0)
    ok = ok and fin.get("caption") == "Second sentence wins."
    record("POST /speak x2 (newest wins)", ok, ms,
           "final caption=%r" % fin.get("caption", "")[:40])


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def _argv(flag, default):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return 0
    base = _argv("--base", "http://%s:%s" % (_argv("--host", "127.0.0.1"),
                                             _argv("--port", "8000")))
    print("Vokal smoke test -> %s\n" % base, flush=True)

    status, _body, _ms = http("GET", base, "/health", timeout=3.0)
    if status == 0:
        print("Cannot reach %s -- is the server running?" % base)
        print("  C:\\vokal-venv\\Scripts\\python.exe server.py --fake")
        return 2

    health = check_health(base)
    check_state_shape(base)
    check_state_latency(base)
    check_root(base)
    check_replay_empty(base)
    check_speak_validation(base)
    check_speak(base)
    check_utterance(base)
    check_clip(base, list(health.get("clips", []) or []))
    check_replay(base)
    check_supersede(base)

    passed = sum(1 for _n, ok, _ms, _d in RESULTS if ok)
    total = len(RESULTS)
    print("\n%s  %d/%d checks passed" % ("ALL PASS" if passed == total else "FAILURES",
                                         passed, total), flush=True)
    if passed != total:
        for n, ok, _ms, d in RESULTS:
            if not ok:
                print("  FAIL %-34s %s" % (n, d), flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
