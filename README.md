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
