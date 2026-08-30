# Vokal — frozen interface contract

**Do not change anything in this file without telling both sides.** Firmware and
laptop are built independently against it.

Vokal is a handheld voice device for people who have lost the power of their
voice — MND/ALS voice degradation, laryngectomy, vocal-cord paralysis, anyone
reduced to a whisper. Their words are intact; their voice cannot carry them.
The board captures and triggers; a laptop does speech-to-text -> text-to-speech
and speaks the sentence out loud through its own speakers.

Both halves of that pipeline run **locally on the laptop**. Speech-to-text is
faster-whisper `small.en` int8. Text-to-speech is **Piper**, voice
`en_GB-cori-high`. No API key, no account, no request leaves the machine.

## Hardware / build reality

Waveshare **ESP32-S3-Touch-AMOLED-1.8 V2**, built with **arduino-cli**, NOT
ESP-IDF. The existing firmware (`firmware/`) already provides the display,
touch, ES8311 capture, IMU and Wi-Fi layers. Vokal is a new UI head on top of
them, not a rewrite.

FQBN (single source of truth, keep identical in every script):

    esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app

## Network

Both devices join the same 2.4 GHz network (phone hotspot on the day; iPhone
must have "Maximise Compatibility" on — the ESP32-S3 has no 5 GHz radio). The
LAN carries audio between two devices in the same room. Nothing in this system
talks to the internet.

Laptop runs the server on **port 8000, bound 0.0.0.0**. The laptop's LAN IP goes
in `firmware/secrets.h` as `VOKAL_HOST`. Plain HTTP, no TLS — a `WiFiClientSecure`
handshake costs latency we do not have and there is nothing secret on the wire.

## Endpoints

### `POST /utterance`
The live beat. Body is **raw PCM: 16 kHz, 16-bit signed little-endian, mono** —
exactly the format already sitting in `audBuf` after `audioStop()`. No WAV
header, no multipart, no base64.

    Content-Type: application/octet-stream
    X-Sample-Rate: 16000
    X-Utterance-Id: <uint32, monotonic per boot>

Returns **202** immediately with `{"ok":true,"utterance_id":<n>}`. The server
must accept the body and return before running the pipeline — the board is
blocked on this call and the UI is frozen while it waits.

### `POST /demo/trigger`
The clip beat. `Content-Type: application/json`, body `{"clip_id": "clip1"}`.

Returns **202** `{"ok":true,"clip_id":"clip1"}`. Unknown clip_id -> **404**.

`clip1` is **pre-rendered**: the server plays `laptop/demo_clips/clip1_rendered.wav`
straight to the speakers. No STT and no TTS run at trigger time. See "The clip
beat is pre-rendered" below — that changes the timing behind the endpoint, not
the endpoint.

### `GET /state`
Polled by the board at ~3 Hz. Must answer in <50 ms and never block on the
pipeline.

    {
      "status":     "idle" | "listening" | "processing" | "speaking" | "error",
      "caption":    "<what was said, or an error message>",
      "latency_ms": <int, first-audio latency of the last utterance>,
      "seq":        <int, increments on every caption change>,
      "source":     "live" | "clip" | ""
    }

`seq` exists so the board can tell "same caption again" from "new caption with
the same text" without diffing strings on an ESP32.

### `POST /speak`
Debug and fallback path. `{"text": "..."}` -> 202. Speaks the text through the
current voice. This is what gets used if the mic path dies on stage.

### `POST /replay`
Re-runs the last successful result — audio and caption — without re-doing STT or
TTS. The deterministic rehearsal/demo fallback. Empty body -> 202, or **409** if
nothing has been spoken yet.

### `GET /health`
`{"ok":true,"whisper":<bool>,"tts":<bool>,"voice_id_set":<bool>}` — lets the
board and the human check the laptop is actually ready before the demo.

**`voice_id_set` is a frozen field name with a new meaning.** It used to mean "a
cloned voice id is configured". There are no cloned voices any more; it now means
**the configured Piper voice model is on disk and loaded**. The name stays
because `firmware/ui_vokal.h:661` parses that exact key and the firmware is built
against it. Fix the meaning in the docs, not on the wire.

## Status meanings (board renders these)

| status | ring colour | means |
|---|---|---|
| `idle` | dim white | ready, nothing happening |
| `listening` | red | mic is open, capturing |
| `processing` | amber | audio sent, pipeline running |
| `speaking` | green | audio is coming out of the laptop speakers |
| `error` | red flashing | something failed; `caption` holds the reason |

`listening` is set by the **board** locally the instant the pad is pressed (do
not wait for a round trip); the server owns `processing`/`speaking`/`error`.

## The clip beat is pre-rendered

`clip1` does not run the pipeline on stage. It was run once, offline, and the
output was written to disk:

| | |
|---|---|
| source | `laptop/demo_clips/clip1_source.wav` — 21.20 s, 16 kHz mono, an excerpt taken at source offsets 8.0–29.2 s |
| transcript | `laptop/demo_clips/clip1.txt` — **hand-corrected by a human** |
| rendered output | `laptop/demo_clips/clip1_rendered.wav` — 14.61 s, 22050 Hz mono, Piper `en_GB-cori-high` |

The transcript was corrected because Whisper misheard "help" as "hell" and added
a sentence nobody said. That is the same class of failure the hallucination guard
below exists for, and on the one beat that must not fail we do not rely on a
guard — a human checks the words and we freeze them.

`POST /demo/trigger` therefore costs a file open and a playback start: **~50 ms**.
It cannot be beaten by a slow model, a loud room, or a laptop that decided to
index something.

## Recognition rules the server must keep

These are not preferences. Each one was measured on the real demo clip and each
one was a bug before it was a rule.

- **Never pass `initial_prompt` to faster-whisper.** With
  `initial_prompt="A person speaking softly in a quiet voice."` Whisper emitted
  the prompt itself as a transcript segment *and* dropped roughly 30 seconds of
  real speech from the same clip. Removing it fixed both.
- `vad_filter=False`. The finger does the segmentation. VAD eats quiet speech,
  and quiet speech is the entire point of this product.
- `condition_on_previous_text=False`. Stops hallucination cascades.
- **Hallucination guard, mandatory.** Whisper invented `"Thank you."` on trailing
  silence in our real clip. Drop any segment with `no_speech_prob > 0.6`; strip a
  trailing or standalone blocklist, case- and punctuation-insensitive
  (`thank you`, `thanks for watching`, `please subscribe`, `you`, `bye`,
  `thanks`, `subtitles by`, `amara.org`, `www.`); and if nothing survives, return
  empty and caption it honestly — `(didn't catch that)`. **Never invent filler.**
  This device speaks on behalf of someone who cannot correct it. A fabricated
  sentence is the worst failure it has.

## Voice ethics — non-negotiable

**Nothing is cloned and nothing leaves the laptop.** That is the whole position,
and it is stronger than the one it replaces.

- Text-to-speech is **Piper**, running locally, voice `en_GB-cori-high`. It is a
  general-purpose synthetic voice. It is nobody in this room and nobody in the
  clip.
- There is **no voice cloning anywhere in this repo**. No enrolment, no voice id,
  no consent checkbox. There is no consent question to answer, because we never
  ask anyone for their voice.
- **No audio and no text ever leaves the machine.** No API key, no account, no
  outbound request. The board posts PCM to a laptop on the same hotspot and that
  is the end of the network path. For a device aimed at a clinical population,
  "where did the recording of your voice go" is a question we do not have to
  answer.
- The clip beat still carries a **credit line on screen** (`VOKAL_CLIP_CREDIT` in
  `firmware/config.h`) naming where the source recording came from. Not cloning
  someone does not entitle you to use their recording uncredited.
- **Voice banking is roadmap, not shipped.** People with an MND diagnosis often
  record their own voice before they lose it; giving Vokal a voice built from
  that recording, with the person's own consent, is the obvious next step and it
  is deliberately not in this build. Offer it as the roadmap answer. Do not imply
  it runs today.

## Latency budget (live beat, press-release to first audio)

Measured on the build laptop, not estimated.

| stage | measured |
|---|---|
| POST upload (a 3 s utterance is ~96 KB over 2.4 GHz) | ~600 ms |
| faster-whisper `small.en` int8 | RTF **0.103** — 6.2 s of compute for a 60 s clip, so ~0.3 s for a 3 s utterance |
| Piper `en_GB-cori-high`, first audio | **0.83 s** (RTF 0.197 thereafter) |
| **total to first audio** | **~2 s** |

Model load is paid once at server startup, never on the request path:
`PiperVoice.load()` is ~2.3 s and the whisper `small.en` int8 weights are already
cached on disk. Loading either per request would blow the budget on its own.

If first audio ever matters more than voice quality, the Piper `*-medium` voices
reach first audio in **0.13 s** at RTF 0.038 — roughly 6x faster and audibly
flatter. `en_GB-cori-high` was chosen by ear; the trade is one line in
`laptop/.env`.

Log every stage. If the total drifts over 3 s the demo dies on stage.
