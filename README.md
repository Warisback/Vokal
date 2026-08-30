# Vokal

One board, one codebase, two apps that share it.

**Vokal** (`APP_VOKAL 1`) — a handheld voice device for people who have lost the
power of their voice. This is the current focus.

**The meeting puck** (`APP_VOKAL 0`) — the original app: a table-top device that
captures a conversation and lets a human mark what mattered while it is
happening. Still builds, still works.

Both apps are the same firmware tree. They share the display, touch, audio, IMU
and network layers, and differ only in one header: `ui_vokal.h` or `ui_puck.h`,
selected by `APP_VOKAL` in `firmware/config.h`. `firmware.ino` changes by one
`#if` around one include; `setup()` and `loop()` do not know which one is
compiled in. Everything the puck taught this board about its own hardware is
still in the tree and still load-bearing — see **Notes for anyone picking this
up** at the bottom, which is the real value in this repo.

Hardware: **Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2)** — 368×448 AMOLED,
capacitive touch, ES8311 mic + speaker, QMI8658 IMU, 8 MB PSRAM. Built with
**arduino-cli**, not ESP-IDF.

---

# Vokal — the voice device

MND/ALS voice degradation, laryngectomy, vocal-cord paralysis, anyone reduced to
a whisper. Their words are intact; their voice cannot carry them.

You hold the board and press one pad. It captures 16 kHz mono PCM straight into
PSRAM and posts it to a laptop on the same 2.4 GHz network. The laptop runs
speech-to-text, then text-to-speech, and speaks it out of its speakers. Press to
first audio: about two seconds.

The board is what you hold and press. The laptop is what does the work. That
split is deliberate — see `docs/DECISIONS.md`.

## Everything runs locally

Speech-to-text is **faster-whisper `small.en` int8**. Text-to-speech is
**[Piper](https://github.com/OHF-Voice/piper1-gpl)**, voice `en_GB-cori-high`.
Both models run on the laptop, offline.

**No API key. No account. No cloud service. Nothing leaves the machine.** The
only network traffic in the system is the board posting audio to a laptop in the
same room. There is no voice cloning anywhere in this project.

For a device meant for a clinical population, that is not a footnote. "Where does
the recording of my voice go?" is a question we do not have to answer, because
the answer is nowhere.

## Measured, on the build laptop

| | |
|---|---|
| Piper `en_GB-cori-high` | 0.83 s to first audio, RTF 0.197 |
| Piper `*-medium` voices | 0.13 s to first audio, RTF 0.038 |
| faster-whisper `small.en` int8 | RTF 0.103 on real speech — 6.2 s for a 60 s clip |
| clip beat | ~50 ms — the audio is pre-rendered to disk, nothing is computed |
| live beat, press-release to first audio | ~2 s (~600 ms upload + ~0.3 s STT + 0.83 s Piper) |

Model load is paid once at server startup: `PiperVoice.load()` is ~2.3 s and the
whisper weights are cached on disk. Never load either on the request path.

## Why hardware and not a phone

A phone is not a voice. It is a lock screen, a passcode, a notification, and a
thing you have to hold flat and look at. Someone who cannot speak needs one
physical control they can find without looking, one-handed, in a pocket, while
they are looking at the person they are talking to. This boots into one function
and a phone call cannot interrupt it. The screen is also the consent surface —
the person being spoken to can see what it says.

## Interactions

| | |
|---|---|
| **Hold the pad, speak, release** | capture and send. The ring is red while the mic is open |
| **Tap the demo pad** | play the pre-rendered clip beat |
| Status ring | dim white idle, red listening, amber processing, green speaking |
| Caption | what the laptop heard, echoed on the board |

## The laptop side

`laptop/` is a small HTTP server on **port 8000, bound 0.0.0.0**: faster-whisper
for STT, Piper for TTS, and a player for the pre-rendered clip. Its LAN IP goes
in `firmware/secrets.h` as `VOKAL_HOST`.

**`PROTOCOL.md` is the frozen contract between the two halves.** Endpoints, body
formats, status meanings and the latency budget all live there, and both sides
are built independently against it. Read it before changing either side.

## Whisper will invent words if you let it

The single most important thing we learned building this. It is written up in
full in `CLAUDE.md`; the short version:

- Passing `initial_prompt="A person speaking softly in a quiet voice."` — which
  seemed like an obviously good idea — made Whisper **emit the prompt itself as a
  transcript segment** and **lose about 30 seconds of real speech** from our
  actual demo clip. Removing it fixed both. Never pass `initial_prompt`.
- Whisper also **invented "Thank you."** on trailing silence in that clip. It
  hallucinates confidently on near-silence, and near-silence is exactly what this
  product records.

This device speaks on behalf of someone who cannot correct it. A fabricated
sentence is the worst failure it has — worse than being slow, worse than saying
nothing. So the pipeline ships a guard: `vad_filter=False`,
`condition_on_previous_text=False`, drop any segment with `no_speech_prob > 0.6`,
strip a trailing blocklist ("thank you", "thanks for watching", "please
subscribe", "you", "bye", "subtitles by", "amara.org", …), and if nothing
survives, say so — the caption becomes `(didn't catch that)` and nothing is
spoken. It never substitutes filler.

## The clip beat is pre-rendered

Beat 1 of the demo does not run the pipeline on stage. It plays
`laptop/demo_clips/clip1_rendered.wav` — 14.61 s of Piper output at 22050 Hz,
rendered offline from a 21.20 s excerpt of the source (offsets 8.0–29.2 s).

The transcript in `clip1.txt` was **corrected by hand** before rendering, because
Whisper misheard "help" as "hell" and added a sentence nobody said. On the one
beat that must not fail, we do not trust a guard — a human checked the words and
we froze them to disk. What is left at demo time is a file open and a playback
start.

## Voice ethics

We clone nobody's voice. There is no enrolment, no voice id, no consent checkbox,
and therefore no consent question to answer — we never ask anyone for their
voice, so we cannot misuse it. Both models are local, so no recording of a
disabled person's speech is ever handed to a vendor.

The clip beat still carries a credit line on screen (`VOKAL_CLIP_CREDIT` in
`firmware/config.h`) naming where the source recording came from: not cloning
someone does not entitle you to use their recording uncredited.

**Voice banking is the roadmap, not a feature of this build.** People with an MND
diagnosis often record their own voice while they still can. Giving Vokal a voice
built from that recording — their voice, on their device, by their choice — is
the obvious next step and it is deliberately not shipped here. The full statement
is in `PROTOCOL.md`.

---

# The meeting puck

A table-top meeting puck that captures a conversation, lets a human **mark what
mattered while it is happening**, and turns the result into structured notes.
This was the first app on this board and it is what the display, touch, audio and
IMU layers were built and debugged for. Build it with `APP_VOKAL 0`.

## Why hardware and not an app

- **Visible consent.** A full-screen `RECORDING` banner everyone at the
  table can read, and a physical stop. A laptop cannot credibly claim that.
- **Flip it face-down to pause.** Unambiguous to every person present.
- **Marks capture human intent in the moment.** Nobody reaches for a laptop
  mid-conversation to flag something; tapping a puck on the table is free.
  Those marks are fed to the structuring model — signal a transcript alone
  cannot recover.

## Interactions

| | |
|---|---|
| Tap RECORD | start capture |
| 4-button grid | mark `important` / `decision` / `action` / `question` |
| **Double-tap the table** | mark, eyes-free — you are looking at people |
| **Flip face-down** | pause; face-up resumes |
| Chirps | distinct tones for start / stop / mark / error |

---

# Setup

```bash
./setup.sh                 # arduino-cli, esp32 core, vendor libs, secrets
$EDITOR firmware/secrets.h # wifi + laptop IP (gitignored)
./flash.sh                 # build, upload, monitor
```

On Windows, `setup.ps1` and `flash.ps1` do the same thing. PowerShell 5.1 has no
`&&` and no ternary, so scripts use `A; if ($?) { B }`.

Setup pulls **five vendor library forks from Waveshare's board repo**, not the
Library Manager — `GFX_Library_for_Arduino`, `Arduino_DriveBus`, `SensorLib`,
`Adafruit_BusIO`, `Adafruit_XCA9554`. The stock versions of the first three do
not drive this board's CO5300 QSPI panel, its CST816 touch controller or its
QMI8658 IMU.

Three things that trip up a fresh machine:

- **Resolve the libraries directory with `arduino-cli config get
  directories.user`.** Do not hardcode `$HOME/Documents/Arduino/libraries` —
  with OneDrive Documents redirection on, that path does not exist.
- **Find the port with `arduino-cli board list`**, which reports VID/PID and
  board identity. Taking the first serial port you find will try to flash a
  Bluetooth virtual COM port.
- **Put the Python venv outside the repo.** On the build machine it is
  `C:\vokal-venv` and the interpreter is invoked as
  `C:\vokal-venv\Scripts\python.exe`. A `.venv` inside this repo hits the Windows
  `MAX_PATH` limit on deep `site-packages` paths, and OneDrive sync corrupts
  packages while pip is still writing them.

Which app gets built is `APP_VOKAL` in `firmware/config.h`: `1` for Vokal, `0`
for the meeting puck. The FQBN is identical either way and lives in
`PROTOCOL.md`:

```
esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app
```

# Layout

```
firmware/
  config.h        board + app knobs; includes secrets.h; APP_VOKAL selects the app
  secrets.h       wifi + laptop IP             (GITIGNORED)
  display.h       CO5300 QSPI + CST816 touch + PSRAM canvas
  audio.h         ES8311 capture, waveform RMS, chirps, WAV, marks
  imu.h           QMI8658: flip, double-tap, orientation
  ui_kit.h        touch, buttons, chrome
  ui_vokal.h      Vokal: push-to-talk, status ring, caption
  ui_puck.h       meeting puck: Idle / Recording / Review screens
  net.h           wifi fallbacks + HTTP
  es8311.*        vendor codec driver
laptop/           STT -> TTS pipeline, HTTP server on :8000
  demo_clips/     clip1_source.wav, clip1.txt, clip1_rendered.wav (pre-rendered)
docs/DEMO.md      the 60-second stage runbook
docs/DECISIONS.md what was decided, and what was rejected
PROTOCOL.md       frozen firmware <-> laptop contract
CLAUDE.md         working notes: house style, traps, the Whisper finding
attic/            earlier BLE tracker prototype, kept for reference
```

# Talking to the laptop

Everything the upload needs is ready after `audioStop()`:

| | |
|---|---|
| `audBuf` | PSRAM buffer, 16 kHz **mono 16-bit LE PCM** |
| `audLen` | bytes captured (`audioMs()` for duration) |
| `wavHeader(hdr, audLen)` | fills a 44-byte RIFF header, if you ever need a file |
| `marks[] / markCount` | `{ms, type}`, ms measured from recording start (puck only) |
| `net.h` | `netConnect()`, `httpGet()`, `httpPostJson()` — wifi with fallbacks |

Vokal posts **raw PCM with no header at all** to `POST /utterance` on our own
server — `Content-Type: application/octet-stream`, `X-Sample-Rate: 16000`. What
is already in `audBuf` is byte-for-byte what the server wants, so there is
nothing to convert and nothing to allocate.

**Prefer an endpoint that accepts a raw body** over one requiring
`multipart/form-data`, which has to be hand-rolled on the ESP32. That insight
came from looking at commercial STT APIs (Deepgram takes `Content-Type:
audio/wav` directly) and it is the reason `PROTOCOL.md` is shaped the way it is:
we control the server, so we chose the body format the board can send for free.

`httpPostJson()` will not carry the audio — it hardcodes JSON and takes a
`const String&`, and a 480 KB Arduino String needs internal heap we do not have
(~300 KB total). `HTTPClient` already has `int POST(uint8_t*, size_t)`, so the
raw path passes `(uint8_t*)audBuf, audLen` straight out of PSRAM and lets
HTTPClient stream it.

Put the laptop's LAN IP in `firmware/secrets.h` as `VOKAL_HOST` — never in a
tracked file. The `STT_URL` / `STT_AUTH_HDR` / `STT_AUTH_VAL` / `LLM_API_KEY`
entries in `secrets.example.h` are vestigial: no compiled code references them,
and there is no API key anywhere in this project any more — both models run
locally on the laptop.

Three constraints worth knowing before you start:

- **The radio is never brought up on its own.** `firmware.ino` includes
  `<WiFi.h>` and never calls into it — nothing initialises the radio until
  `netConnect()` does. (An earlier version of this note claimed
  `WiFi.mode(WIFI_OFF)` is called at boot in `firmware.ino`. It is not, and never
  has been: that string appears nowhere in `firmware/`. It was carried over from
  the attic BLE-tracker prototype, where it was true.) The advice behind it still
  holds: bring the radio up deliberately, in `setup()`, because wifi TX and the
  AMOLED backlight together draw enough to brown out a weak supply.
- **`netConnect()` blocks** — a `delay(200)` poll loop, up to 12 s per network in
  `WIFI_NETWORKS`. Call it from `setup()`, never from a button handler.
- **Capture runs on core 0**; do network work on core 1 (the main loop) or the
  UI will stutter.

# Notes for anyone picking this up

These are the debugging scars. Every line is a bug that cost real hours on this
exact board. Read them before changing the code they describe.

- **Full-screen framebuffer in PSRAM.** Everything draws off-screen and
  blits on `tft.flush()`; drawing straight to the panel flickers badly.
- **Touch clicks are latched.** Touch samples at ~200 Hz, the UI repaints
  at 10 Hz, so a one-frame release flag gets dropped. `touchBeginFrame()` /
  `touchEndFrame()` hand the click to the paint pass.
- **Capture runs on core 0** in its own task so the UI cannot drop samples.
- **The IMU needs `getDataReady()`** before every read or it returns stale
  registers — that showed up as the flip detector oscillating.
- **Z is inverted on this board**: about −1.0 g resting face *up*.
- Audio is 16 kHz mono into 2 MB of PSRAM ≈ 65 seconds.
- **The IMU low-pass filter defaults to 2.66% of ODR.** At 125 Hz ODR that
  is a 3.3 Hz corner, which erases a tap transient completely. It is now
  `LPF_OFF` at 1000 Hz ODR.
- **Never `Serial.printf` unguarded in a hot loop.** Streaming at 500 Hz
  overran USB CDC and blocked the whole loop — the board went silent and
  the UI froze. Writes are guarded with `availableForWrite()`.
- **Touch is interrupt-driven.** Polling the CST816 blind competed with the
  IMU on the shared I2C bus and mostly returned "no finger".
- Tap detection keys off **high-passed az plus pulse width**, not `|a|` —
  amplitude alone cannot tell a finger strike from picking the puck up,
  because both reach similar peaks. Duration can.
- **`touchReleased` is a click, not a hold.** It is a one-frame event handed to
  the paint pass. Push-to-talk uses `touchDown`, the live held state,
  edge-detected against the previous frame.
- **`audLen` grows for up to ~64 ms after `audioStop()` returns.** The capture
  task only checks the flag at the top of its loop; if it is inside
  `readBytes()` it commits that chunk anyway. Wait for `audIdle` before
  snapshotting the length.
- **The I2S RX ring is never stopped**, so it holds audio from before the button
  press. `audioStart()` already drains it — and zeroes the waveform and
  `audPeak` — before arming. That is handled, not a to-do; do not drain twice.

# Debugging

`tools/imuplot.py` is a live 6-DoF scope for tuning the tap detector:

```bash
python3 tools/imuplot.py            # needs IMU_STREAM 1 in config.h
```

Raw `az` vs the high-passed signal the detector sees, gyro, and the
movement gate, with markers for accepted taps and rejected pulses.
Set `IMU_STREAM 0` when you are done — it costs serial bandwidth.
