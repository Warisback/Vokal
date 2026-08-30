# Vokal

A table-top meeting puck that captures a conversation, lets a human **mark what
mattered while it is happening**, and turns the result into structured notes.

Hardware: **Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2)** — 368×448 AMOLED,
capacitive touch, ES8311 mic + speaker, QMI8658 IMU, 8 MB PSRAM.

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

## Setup

```bash
./setup.sh                 # arduino-cli, esp32 core, vendor libs, secrets
$EDITOR firmware/secrets.h # wifi + API keys (gitignored)
./flash.sh                 # build, upload, monitor
```

`setup.sh` pulls **Arduino_GFX, Arduino_DriveBus and SensorLib from
Waveshare's repo**, not the Library Manager — the stock versions do not
drive this board's CO5300 QSPI panel or CST816 touch controller.

## Layout

```
firmware/
  config.h        board + app knobs; includes secrets.h
  secrets.h       wifi + API keys            (GITIGNORED)
  display.h       CO5300 QSPI + CST816 touch + PSRAM canvas
  audio.h         ES8311 capture, waveform RMS, chirps, WAV, marks
  imu.h           QMI8658: flip, double-tap, orientation
  ui_kit.h        touch, buttons, chrome
  ui_puck.h       Idle / Recording / Review screens
  net.h           wifi fallbacks + HTTPS        (not wired in yet)
  es8311.*        vendor codec driver
attic/            earlier BLE tracker prototype, kept for reference
```

## Hooking up speech-to-text

Everything the upload needs is ready after `audioStop()`:

| | |
|---|---|
| `audBuf` | PSRAM buffer, 16 kHz **mono 16-bit LE PCM** |
| `audLen` | bytes captured (`audioMs()` for duration) |
| `wavHeader(hdr, audLen)` | fills a 44-byte RIFF header to send in front of the PCM |
| `marks[] / markCount` | `{ms, type}`, ms measured from recording start |
| `net.h` | `netConnect()`, `httpGet()`, `httpPostJson()` — wifi with fallbacks, already written but not yet called |

Put credentials in `firmware/secrets.h` (`STT_URL`, `STT_AUTH_HDR`,
`STT_AUTH_VAL`) — never in tracked files.

**Prefer an STT API that accepts a raw body** (Deepgram: `POST` with
`Content-Type: audio/wav`) over one requiring `multipart/form-data`, which
has to be hand-rolled on the ESP32. Word-level timestamps in the response
are what let a mark be tied to an exact point in the transcript.

Two constraints worth knowing before you start:

- **`WiFi.mode(WIFI_OFF)` is called at boot** in `firmware.ino` — bring the
  radio up when you need it. Wifi TX and the AMOLED backlight together draw
  enough to brown out a weak supply.
- Capture runs on core 0; do network work on core 1 (the main loop) or the
  UI will stutter.

## Notes for anyone picking this up

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
- **`Serial.setTxTimeoutMs(0)` in `setup()` is load-bearing. Do not remove
  it.** USB CDC writes *block* when the host is not draining the port. With
  no serial monitor attached the TX buffer fills and every `printf` stalls
  the loop for the full timeout: the display updated every few seconds and
  touch felt dead. The device only behaved correctly *while a monitor was
  attached* — which is exactly the condition that hid the bug during
  development, and exactly the opposite of demo conditions. Timeout 0 drops
  debug output instead of blocking. Hot-path writes are additionally
  guarded with `availableForWrite()`.
- Leave `IMU_STREAM` and `TOUCH_DEBUG` at 0 unless actively debugging.
- **Touch is interrupt-driven.** Polling the CST816 blind competed with the
  IMU on the shared I2C bus and mostly returned "no finger".
- Tap detection keys off **high-passed az plus pulse width**, not `|a|` —
  amplitude alone cannot tell a finger strike from picking the puck up,
  because both reach similar peaks. Duration can.

## Debugging

`tools/imuplot.py` is a live 6-DoF scope for tuning the tap detector:

```bash
python3 tools/imuplot.py            # needs IMU_STREAM 1 in config.h
```

Raw `az` vs the high-passed signal the detector sees, gyro, and the
movement gate, with markers for accepted taps and rejected pulses.
Set `IMU_STREAM 0` when you are done — it costs serial bandwidth.
