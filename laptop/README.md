# laptop/ — the Vokal server

The board captures and triggers. This does speech-to-text → text-to-speech →
speakers, and answers the six endpoints in [`../PROTOCOL.md`](../PROTOCOL.md).

**Everything runs on this laptop.** Speech-to-text is `faster-whisper small.en`
(int8, CPU). Text-to-speech is **Piper**, local, voice `en_GB-cori-high`. There
is no API key, no account, no network call, and no voice cloning — a user's
voice never leaves the machine, so there is no consent question to answer. Voice
banking is on the roadmap, not in this build.

---

## The python you must use

`C:\vokal-venv\Scripts\python.exe`

Not `python`, not a venv inside the repo. The repo path is long enough to hit
the Windows `MAX_PATH` limit and OneDrive corrupts `site-packages`, so the
environment lives outside the repo at `C:\vokal-venv`. Piper voices are in
`C:\vokal-venv\voices\`.

---

## Run it

```powershell
cd "C:\Users\yussu\OneDrive\Documents\comp sci projects\vokal\Vokal\laptop"
C:\vokal-venv\Scripts\python.exe server.py
```

Binds `0.0.0.0:8000`. Put the laptop's LAN IP in `firmware/secrets.h` as
`VOKAL_HOST` — right now that is **192.168.4.211**:

```powershell
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' }).IPAddress
```

### Flags

| flag | what it does |
|---|---|
| `--fake` | canned captions, **no models loaded at all**. For firmware integration. |
| `--port <n>` | default 8000 |
| `--host <addr>` | default `0.0.0.0` |
| `--no-hotkey` | do not read the keyboard fallback from stdin |
| `--access-log` | log every request (noisy — the board polls `/state` at 3 Hz) |

### No board, no models, no AI stack

```powershell
C:\vokal-venv\Scripts\python.exe server.py --fake
```

`--fake` does not import `pipeline.py` at all, so it boots in under a second on
a machine with nothing but `fastapi` and `uvicorn`. Every endpoint answers with
the same status codes and the same JSON shape as the real thing.

---

## Smoke test

With a server already running, in a second window:

```powershell
cd "C:\Users\yussu\OneDrive\Documents\comp sci projects\vokal\Vokal\laptop"
C:\vokal-venv\Scripts\python.exe smoke.py
```

Hits every endpoint, prints PASS/FAIL and a measured latency per call, and exits
non-zero if anything failed — so it can gate a rehearsal. Stdlib only; no board
required. Point it anywhere:

```powershell
C:\vokal-venv\Scripts\python.exe smoke.py --base http://192.168.4.211:8000
```

It checks the things that actually kill a demo: `/state` answering inside its
50 ms budget, `/state` still answering *while* the pipeline is busy, every POST
returning 202 in single-digit milliseconds, the capture WAV landing on disk,
`404` on an unknown clip, `409` on a cold `/replay`, and a second `/speak`
superseding the first instead of queueing behind it.

---

## On stage: the one line that saves you

`POST /replay` re-plays the **cached audio of the last success**. No
speech-to-text, no text-to-speech, no model, no network. It is the beat that
works when everything else has stopped.

Paste this once into a PowerShell window before you go on, then just press
**`r` + Enter** whenever you need it:

```powershell
function r { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/replay | Out-Null }
```

The bare one-liner, if you would rather not define anything:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/replay
```

Speak any sentence out loud:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/speak -ContentType 'application/json' -Body '{"text":"Hello. This is Vokal."}'
```

Run the clip beat:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/demo/trigger -ContentType 'application/json' -Body '{"clip_id":"clip1"}'
```

Check the laptop is ready:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health | ConvertTo-Json
```

### Keyboard fallback in the server window

The terminal running `server.py` is itself a control surface — it calls the
engine directly, so it still works when the *network* is what broke:

```
[Enter] or r   replay the last thing that was spoken
s <text>       speak that text now
c clip1        run the clip beat
h              health
?              help
```

---

## Endpoints

Frozen in [`../PROTOCOL.md`](../PROTOCOL.md). Do not "improve" the shapes.

| method | path | body | returns |
|---|---|---|---|
| POST | `/utterance` | raw PCM, 16 kHz s16le mono, headers `X-Sample-Rate`, `X-Utterance-Id` | `202 {"ok":true,"utterance_id":n}` |
| POST | `/demo/trigger` | `{"clip_id":"clip1"}` | `202` / `404` unknown clip |
| GET | `/state` | — | `{status, caption, latency_ms, seq, source}` |
| POST | `/speak` | `{"text":"..."}` | `202` / `400` empty |
| POST | `/replay` | empty | `202` / `409` nothing spoken yet |
| GET | `/health` | — | `{ok, whisper, tts, voice_id_set, …}` |

**Every POST returns 202 immediately** and hands the work to a single background
worker thread. The ESP32 is blocked inside `HTTPClient::POST()` with its UI
frozen for the whole duration of any request it makes, so a slow endpoint is a
frozen device. `/state` never touches the pipeline: it copies five fields from
behind a lock held for microseconds.

`seq` increments on **every caption set**, not only when the text changes, so
the board can tell "a new caption that happens to read the same" from "the same
caption again" without diffing strings on an ESP32.

**One voice at a time.** A new job supersedes anything still queued behind it
and asks the running job to stand down. Two voices talking over each other on
stage is worse than a dropped sentence, and the newest press is always the one
the presenter meant.

`voice_id_set` in `/health` is kept for wire compatibility with the frozen
protocol. There is no cloning any more; it now means *a local Piper voice is
loaded and ready*.

---

## Captures — how you debug a failed demo

Every utterance the board sends is written to
`laptop/captures/<timestamp>-<utterance_id>.wav` with a real WAV header, before
anything else happens to it. When a demo goes wrong the first question is always
"what did the microphone actually hear?", and this is the only way to answer it
afterwards. Play the newest one:

```powershell
ffplay -nodisp -autoexit (Get-ChildItem "$PWD\captures\*.wav" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
```

The directory is gitignored. Delete it freely.

---

## The hallucination guard — do not remove it

Whisper invents words on silence. On the real demo clip today it produced a
confident **"Thank you."** out of trailing room tone.

This product speaks aloud for someone who cannot correct it. A fabricated
sentence is the worst failure it has. So:

- segments with `no_speech_prob > 0.6` are dropped;
- a standalone result matching the known-filler blocklist (`thank you`,
  `thanks for watching`, `please subscribe`, `you`, `bye`, `thanks`,
  `subtitles by`, `amara.org`, `www.`) is discarded;
- if nothing survives, the caption is **`(didn't catch that)`** and the speakers
  stay silent. It never invents filler to cover a gap.

The filter runs in `pipeline.transcribe()` and again in `server.guard_transcript()`
immediately before the words would be spoken. It can only ever remove, never add.

Related, and equally load-bearing: **never pass `initial_prompt` to Whisper.**
`"A person speaking softly in a quiet voice."` made it emit the prompt itself as
a transcript segment *and* lose thirty seconds of real speech. `vad_filter` stays
off — the finger does the segmentation, and VAD eats quiet speech, which is the
entire point of this product. `condition_on_previous_text` stays off, or one
hallucination cascades into the next.

---

## Degraded start

If `pipeline.py` or `config.py` is broken, or a model refuses to load, the
server **still boots**: it binds the port, keeps answering `/state` and
`/health`, and names the problem in `health.problems`. A server that will not
start twenty minutes before a demo is fatal; a server that starts and tells you
what is missing is recoverable. Models load on a background thread, so the port
is listening immediately and `/health` reports `whisper`/`tts` as they come up.

---

## Measured on this machine

| stage | number |
|---|---|
| Piper `en_GB-cori-high` first audio | 0.83 s (RTF 0.197) |
| Piper `*-medium` first audio | 0.13 s (RTF 0.038) |
| whisper `small.en` int8, real speech | RTF 0.103 (6.2 s for a 60 s clip) |
| POST upload, 480 KB over 2.4 GHz | ~600 ms |
| **live beat, press-release to first audio** | **~2 s** |

The clip beat is **pre-rendered**: `/demo/trigger` plays
`demo_clips/clip1_rendered.wav` from disk. No STT, no TTS at run time. It cannot
fail.

---

## Troubleshooting

| symptom | fix |
|---|---|
| `Cannot reach http://127.0.0.1:8000` from smoke.py | the server is not running, or another process holds 8000: `Get-NetTCPConnection -LocalPort 8000` |
| board shows nothing, laptop is fine | `VOKAL_HOST` in `firmware/secrets.h` is the wrong IP, or the phone hotspot is on 5 GHz — the ESP32-S3 has no 5 GHz radio, turn on "Maximise Compatibility" |
| `/health` says `whisper: false` | models still loading (first call warms them), or `problems` names the real reason |
| caption reads `(didn't catch that)` | that is the guard working. Nothing was said, or it was too quiet to be sure. It refuses to invent. |
| no sound | check the Windows default output device; `/replay` falls back through pipeline → sounddevice → ffplay → winsound |
| everything is broken, you are on stage | `r` + Enter in the server window, or the `r` function above. It plays cached bytes. |

## Files

| file | owner |
|---|---|
| `server.py` | endpoints, job queue, state + `seq`, captures, replay cache |
| `pipeline.py` | whisper, Piper, playback |
| `config.py` | environment and paths |
| `smoke.py` | end-to-end endpoint check |
| `demo_clips/` | `clip1_rendered.wav` — the pre-rendered clip beat |
| `captures/` | every utterance the board ever sent (gitignored) |
