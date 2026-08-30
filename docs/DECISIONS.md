# Decisions

What this build locked in, why, and what was rejected. The rejections are the
useful part — they are the hours you do not have to spend again.

Ordered roughly by how much they constrain everything downstream.

---

## 1. arduino-cli, not ESP-IDF

**Decision.** Vokal is built with `arduino-cli` against `esp32:esp32` 3.3.11, as
a set of `.h` files and one `.ino`.

**Why.** A complete, working firmware for this exact board already exists in
`firmware/` and it is Arduino. It represents days of hardware debugging that is
recorded in the comments: the PSRAM framebuffer, the interrupt-driven touch read,
the IMU low-pass corner, the touch click latch, tap detection by pulse width.
None of that transfers to a different framework for free; all of it would have to
be re-found.

**Rejected.** ESP-IDF v5.5 with the Waveshare BSP component and LVGL. It is the
better long-term base and it is the wrong call for a build with a fixed deadline:
it throws away working code to buy an abstraction the demo does not need. There
is no `idf.py`, no `sdkconfig`, no managed components and no `lv_conf.h` in this
repo, and adding them means starting bring-up from zero.

**Cost.** Arduino-layer quirks stay ours to work around, and the five vendor
libraries have to be copied from Waveshare's repo by hand in `setup.*` because
the Library Manager versions do not drive this panel, this touch controller or
this IMU.

---

## 2. A new UI head, not a rewrite

**Decision.** Vokal is `firmware/ui_vokal.h`, selected by `APP_VOKAL` in
`config.h`. `ui_puck.h` is untouched and still builds with `APP_VOKAL 0`.
`firmware.ino` changes by one `#if` around one include.

**Why.** The two apps need the same display, touch, audio, IMU and network
layers, and differ only in what is on screen and what a press means. Both heads
expose the same three entry points — `uiSplash(const char*)`, `uiBegin()`,
`uiTick()` — so `setup()` and `loop()` do not know which one is compiled in.
Keeping the puck alive also keeps a known-good build available: if Vokal will not
come up on the board, flipping one flag proves the hardware is fine and isolates
the fault to the new code.

**Rejected.** Editing `ui_puck.h` in place, or deleting it. It is the
co-founder's working app, it is the reference implementation of the screen
contract, and a demo that breaks a teammate's work to save a header file is a bad
trade twice over.

---

## 3. Speech-to-text and text-to-speech on the laptop, not on-device

**Decision.** The board captures and triggers. All recognition and synthesis
happens on a laptop on the same network.

**Why.** The whole product is press-to-sound in a couple of seconds. An ESP32-S3
can do keyword spotting; it cannot do open-vocabulary recognition plus natural
synthesis, and it certainly cannot do both inside the budget. Putting the work on
the laptop makes the latency budget achievable — measured at ~2 s end to end —
and leaves the board doing the one job only hardware can do: being a button you
can find without looking.

**Rejected.** On-device inference, and posting straight to a commercial STT API
from the board. The second is tempting — it removes the laptop — but it puts an
API key in flash, forces TLS on the ESP32, and gives no place to hold the clip
beat or the `/replay` cache.

**Honest framing for judges.** The laptop is a stand-in for a phone over BLE or
an on-device model. It is a deployment decision, not an architectural one.

---

## 4. Piper, locally, instead of ElevenLabs

**Decision.** Text-to-speech is **Piper** (`piper-tts` 1.7.0), voice
`en_GB-cori-high`, running on the laptop. ElevenLabs is removed from the project
entirely, and with it voice cloning, `enroll_voice.py`'s reason to exist, the
API key, the account and the network dependency.

**Why — four separate wins, in order of how much they matter on the day:**

1. **It is faster.** Piper `en_GB-cori-high` reaches first audio in **0.83 s**
   (RTF 0.197), measured on this laptop. A hosted flash model's *best case* was
   budgeted at ~500 ms of first-byte latency and that was before the round trip,
   the TLS handshake and whatever the venue wifi does to it. The `*-medium`
   voices reach first audio in **0.13 s** (RTF 0.038) if we ever need the
   headroom.
2. **It cannot fail in ways we do not control.** No rate limit, no expired key,
   no 429, no captive portal, no outage during someone else's demo slot. The
   single largest category of demo-day failure is deleted, not mitigated.
3. **It is free**, so rehearsing costs nothing and nobody rations runs.
4. **The ethics problem disappears rather than being managed.** See decision 5.

**Rejected.** Keeping ElevenLabs "just for the live beat". A second TTS path
doubles the failure modes, keeps the key, keeps the account, and reintroduces
every argument we had just closed, in exchange for a voice difference the room
would not reliably notice through a hall PA.

**Cost.** Piper is audibly synthetic — good, natural-sounding, and not
indistinguishable from a person. `en_GB-cori-high` was picked by ear out of four
installed voices for exactly this reason. Model load is ~2.3 s, so the voice is
loaded **once at server startup** and held; loading per request would eat the
whole budget.

---

## 5. No voice cloning at all

**Decision.** Nothing in this project clones anybody's voice. There is no
enrolment, no voice id, no consent checkbox, no stock-versus-clone split.

**Why.** The previous design was defensible — presenter's own clone for the live
beat, a stock voice for the clip, a rule in code that the clip path could not
reach the clone. It was also a structure whose correctness had to be *argued*,
and it put a "did you have consent" question in front of a room, about a product
for disabled people, that we then had to answer well.

Removing cloning removes the question. **We clone nobody, so there is nothing to
consent to.** Both models are local, so **no recording of anybody's speech ever
leaves the laptop** — there is no vendor holding a disabled person's voice
sample. That is a stronger position than the one it replaces, not a weaker one,
and it takes one sentence to say instead of three.

**Rejected.** Cloning the presenter only, with consent. Genuinely fine on the
merits, and still not worth it: it drags the whole ElevenLabs dependency back in
(decision 4) to buy a nicety, and it re-opens the consent conversation for the
sake of a beat that works without it.

**Roadmap, explicitly not shipped.** **Voice banking** — people diagnosed with
MND recording their own voice while they still have it, and a device that later
speaks in that voice — is the obvious right answer for a real user, and it is the
answer to give when a judge asks. It is their voice, their device, their choice,
and it is not in this build. Say "roadmap". Do not imply it runs today.

**Kept.** The clip beat's on-screen credit line (`VOKAL_CLIP_CREDIT`). Not
cloning someone does not entitle you to use their recording uncredited.

---

## 6. The clip beat is pre-rendered

**Decision.** `POST /demo/trigger` plays `laptop/demo_clips/clip1_rendered.wav`.
No STT and no TTS run at demo time.

**Why.** Beat 1 is the beat that proves the idea, and it is the one thing in the
demo that has no reason to be live. Everything it could gain by running the
pipeline on stage, it already gained when we ran the pipeline offline; everything
it can lose — a slow model, a busy CPU, a mis-transcription in front of judges —
it loses for free. Rendered once, it is a file open and a playback start: **~50
ms**, and no code path that can be slow.

**Also — the transcript is hand-corrected.** Whisper misheard **"help" as
"hell"** on this clip and added a sentence nobody said. `clip1.txt` is the
corrected text and it is what was synthesised. On the beat that must not fail we
do not rely on the hallucination guard; a person checked the words against the
audio.

**The artefacts.** Source `clip1_source.wav`, 21.20 s at 16 kHz mono, an excerpt
taken at source offsets 8.0–29.2 s. Output `clip1_rendered.wav`, 14.61 s at
22050 Hz, Piper `en_GB-cori-high`.

**Rejected.** Running the clip through the live pipeline "because it is more
honest". It is not more honest — the pipeline it would run is the same pipeline
the audience watches run live in beat 2, thirty seconds later, on unscripted
speech. Beat 2 is the proof. Beat 1 is the argument, and an argument should not
be able to crash.

---

## 7. Never pass `initial_prompt` to Whisper

**Decision.** `initial_prompt` is not passed. Ever. Along with it:
`vad_filter=False` and `condition_on_previous_text=False`.

**Why.** `CLAUDE.md` used to *recommend*
`initial_prompt="A person speaking softly in a quiet voice."`, on the reasonable
theory that it would bias the model toward quiet speech. Measured on the real
demo clip today, it did two things:

1. Whisper **emitted the prompt itself as a transcript segment** — the device
   would have spoken the prompt out loud as though the user had said it.
2. Whisper **lost roughly 30 seconds of real speech** from the same clip.

Removing it fixed both, in the same run. It is not a tuning knob; it is a
foot-gun shaped like a tuning knob, and it was in our own documentation, which is
why it is written down here rather than fixed quietly.

`vad_filter=False` because the finger does the segmentation — the pad is held for
exactly the utterance — and VAD trims quiet speech, which is the entire point of
this product. `condition_on_previous_text=False` because conditioning turns one
hallucinated segment into a cascade of them.

**Rejected.** Tuning the prompt into something safer. Any prompt can be emitted
as output; the failure is structural, not a matter of wording.

---

## 8. The hallucination guard is mandatory

**Decision.** Every transcript passes a filter before anything is spoken:

- drop any segment with `no_speech_prob > 0.6`;
- strip a trailing or standalone blocklist, case- and punctuation-insensitive:
  `thank you`, `thanks for watching`, `please subscribe`, `you`, `bye`,
  `thanks`, `subtitles by`, `amara.org`, `www.`;
- if nothing survives, **return empty**, caption it `(didn't catch that)`, and
  speak nothing.

**Why.** Whisper invented **"Thank you."** on trailing silence in our real demo
clip today. Those phrases are subtitle-corpus artefacts — the model has seen
thousands of hours of video that ends with someone thanking you for watching —
and it emits them confidently on near-silence. Near-silence is precisely what
this product records: the premise is a person too quiet to be heard.

This matters more here than in any other Whisper application. **This device
speaks on behalf of someone who cannot correct it.** If it says a word they did
not say, they may not be able to interrupt, deny it, or explain. A fabricated
sentence is worse than a slow one and much worse than an empty one.

**Rejected.** Filling an empty result with something plausible — "sorry, could
you repeat that?" — in the user's stead. That is inventing speech for a person
who cannot object, which is the exact failure the guard exists to prevent. The
honest caption is `(didn't catch that)`, addressed to the *user*, and it speaks
nothing.

**Rejected.** Trusting the guard on the clip beat. See decision 6: that
transcript is checked by a human and frozen.

---

## 9. Raw PCM on the wire, not WAV, not multipart

**Decision.** `POST /utterance` takes raw 16 kHz 16-bit signed little-endian mono
PCM as the body, with `Content-Type: application/octet-stream` and the sample
rate in a header.

**Why.** That is byte-for-byte what is already sitting in `audBuf` after
`audioStop()`. Zero conversion, zero extra allocation, and nothing to get wrong
at 3 a.m. `audio.h` has a `wavHeader()` helper and we still do not use it: a
44-byte RIFF header would mean either a second buffer or a two-part send, to
satisfy a parser we also control.

**Rejected.** `multipart/form-data` — has to be hand-rolled on an ESP32 and every
boundary bug costs an hour. Base64 — 33% more bytes on the slowest link in the
system. A WAV header — real cost, no benefit, because we own the server.

**Note.** The original README recommended preferring an STT API that accepts a
raw body over one requiring multipart. That insight is why `PROTOCOL.md` looks
like this; we just took it further, because owning the server means we can pick
the body format the board can send for free.

---

## 10. Buffer the whole utterance, then POST — not chunked streaming

**Decision.** Capture into PSRAM while the pad is held; on release, send the
whole thing in one `POST`.

**Why.** `audBuf` is already a 2 MB PSRAM buffer that holds 65 seconds, allocated
once in `audioBegin()` and never freed, and `audioStart()` is a pure pointer
reset — so unlimited back-to-back captures are free with no leak and no realloc.
A 3-second utterance is ~96 KB and uploads in well under a second. `HTTPClient`
already has `int POST(uint8_t*, size_t)`, which streams the body out in chunks
from PSRAM without ever copying it into internal heap.

**Rejected.** Chunked or streaming upload during capture. It would shave a few
hundred milliseconds off a budget we already meet, in exchange for partial-send
failure states, a server that has to handle a truncated stream, and debugging on
the least proven code in the repo.

**Also rejected.** Sending via `httpPostJson()`. It hardcodes `Content-Type:
application/json` and takes a `const String&` — 480 KB in an Arduino String needs
internal heap we do not have (~300 KB total) and fails outright. The fix is a
sibling function that takes a raw pointer, not a change to the existing one:
`httpPostJson` has other callers and no reason to grow a mode switch.

---

## 11. Plain HTTP, no TLS

**Decision.** `http://<VOKAL_HOST>:8000`, no certificates, no
`WiFiClientSecure`.

**Why.** A TLS handshake on the S3 costs latency out of the budget, and there is
nothing secret on the wire: it is a laptop and a dev board on a phone hotspot,
exchanging a sentence the presenter is about to say out loud. `net.h` already
routes `https` URLs through `tls.setInsecure()`, which is unverified encryption —
the worst of both, the cost of a handshake with none of the guarantee. Plain
`http` takes the `WiFiClient` branch.

**Rejected.** HTTPS with `setInsecure()`. Rejected precisely because it looks
responsible and is not.

**Consequence, and it is now a stronger one.** No API key crosses this link
because **there is no API key anywhere in the project**. Both models are local.
The board only ever knows an IP, and the only thing on the wire is audio moving
between two devices in the same room.

---

## 12. `GET /state` polled at ~3 Hz, not a push channel

**Decision.** The board polls `/state` a few times a second and renders whatever
it says. `seq` increments on every caption change so the board can tell "same
caption again" from "new caption with the same text" without diffing strings.

**Why.** Polling a JSON endpoint is roughly fifteen lines against `httpGet()`,
which already exists. `/state` must answer in under 50 ms and never block on the
pipeline, which is a server-side rule that costs nothing to keep.

**Rejected.** WebSockets or SSE. Another library, another connection state
machine, another thing to reconnect after the hotspot hiccups — to save latency
on a status field that only drives a colour.

---

## 13. The board owns `listening`; the server owns everything else

**Decision.** The instant the pad goes down, the board sets its ring red locally.
It does not wait for a round trip. `processing`, `speaking` and `error` come from
the server.

**Why.** The one thing that must feel instant is the response to a press. A round
trip before the ring changes colour makes the device feel broken even when it is
working perfectly. It also means the board still does something in your hand with
the network completely dead — which is the last rung of the demo failure ladder.

---

## 14. Push-to-talk on the touch pad, not the IMU

**Decision.** Hold a large on-screen pad. `touchDown` is the held state,
edge-detected against the previous frame.

**Why.** IMU double-tap requires `imuQuiet` — slow |a| under 0.08 g and slow gyro
under 12 dps held for 250 ms — so it deliberately rejects taps while the device
is being held and moved. That is correct for a puck sitting on a table and
exactly wrong for something in your hand at your mouth.

**Rejected.** `touchReleased` as the trigger. It is a one-frame click event
latched for the paint pass, not a hold. And `touchPressed` must never be read
from a screen function: it is set at 200 Hz and cleared on the next sample, so a
10 Hz paint pass essentially never observes it. Both facts are recorded in
`ui_kit.h:12-31` and both were real bugs.

---

## 15. Drain the I2S ring and wait for an idle flag around every capture

**Decision.** `audioStart()` drains the I2S RX ring before arming, and the
capture task sets a `volatile bool` when it takes the idle branch; the sender
waits for that flag before snapshotting `audLen`.

**Why.** Two hazards that did not matter for a meeting recorder and are fatal for
push-to-talk. The RX channel is started once and never stopped, and nothing
drains it while `!audRecording`, so every capture begins with audio from *before*
the press — for a 60-second meeting that is invisible, for a 3-second whisper it
is a third of the clip. And `audLen` keeps growing for up to ~64 ms after
`audioStop()` returns, because the task only tests the flag at the top of its
loop and commits whatever chunk it is already inside.

**Rejected.** A fixed `delay(100)` after `audioStop()` as *the* mechanism. It
works, it is a guess, and it silently stops working if `AUD_CHUNK` changes. A
flag the task sets is four lines and is correct by construction.
`VOKAL_SETTLE_MS` (200 ms) still exists, but only as the ceiling on how long the
sender will wait for `audIdle` — a bound on a bug, not a substitute for the
signal.

**Also.** `audioStart()` (`audio.h:155`) zeroes `waveLvl`, `waveHead` and
`audPeak` alongside `audLen`, because the UI reads all of them and the meter
otherwise opens showing the previous utterance's bars. `markCount` is the one
thing it still leaves alone — that is puck state, and `ui_puck.h:57` clears it
by hand.

---

## 16. `POST /replay` as the deterministic fallback

**Decision.** An endpoint that re-runs the last successful result — audio and
caption — with no STT, no TTS and no network round trip. 409 if nothing has been
spoken yet.

**Why.** Venue wifi, a hotspot that reassigns addresses, a laptop that decides to
update, a room too loud for the mic: on the day, the pipeline is the least
reliable thing in the building. `/replay` turns a dead demo into a slightly
apologetic one, and it costs a cached buffer. It is also the fastest possible
rehearsal loop — it exercises the audio path end to end without spending a model
run.

**Consequence.** The full live beat must be run once in rehearsal so the cache is
warm. A 409 on stage is worse than no fallback at all, because you will have
promised it.

---

## 17. The Python venv lives outside the repo, at `C:\vokal-venv`

**Decision.** No `.venv` in the repository. The interpreter is
`C:\vokal-venv\Scripts\python.exe` and every script and document names it
explicitly. Piper voice models live in `C:\vokal-venv\voices`.

**Why.** Two independent Windows problems, both of which we hit:

1. **`MAX_PATH`.** The repo sits under
   `C:\Users\<user>\OneDrive\Documents\comp sci projects\vokal\Vokal`. Add
   `.venv\Lib\site-packages\` and a deeply nested dependency path on top of that
   and installs fail with truncated or unreadable paths.
2. **OneDrive sync corrupts `site-packages`.** The repo directory is
   OneDrive-synced. Sync touching thousands of small files while pip is writing
   them produced packages that imported and then failed at runtime — the worst
   kind, because they look installed.

A venv on `C:\` directly is short, and outside the sync root. `.gitignore` keeps
it moot for the repo either way, but the failure was real and cost time before we
moved it.

**Related.** The `esp32:esp32` Arduino core and the five vendor libraries have
the same problem in reverse — the libraries directory *is* under OneDrive
redirection, which is why every script resolves it with
`arduino-cli config get directories.user` instead of assuming
`$HOME/Documents/Arduino/libraries`.

---

## Rejected wholesale

Things considered and dropped, so nobody re-proposes them:

- **ElevenLabs, in any form.** See decisions 4 and 5. Faster, free, offline, and
  no cloning ethics problem. There is no "just for one beat" version of this.
- **Voice cloning of the presenter, of the person in the clip, of anyone.** The
  roadmap answer is voice banking, and it is a roadmap answer.
- **LVGL, and LovyanGFX.** The panel is driven by Waveshare's Arduino_GFX fork
  over QSPI; LovyanGFX's QSPI path is not proven on this board and the shim in
  `display.h` already gives the UI the handful of calls it uses. Dead LVGL knobs
  survive in `config.h` from the attic prototype — they are misleading, not live.
- **An on-device wake word.** More impressive, and it removes the one thing that
  makes the device honest: a physical control that only listens when held.
- **A second board as a receiver.** Doubles the hardware that can fail on stage
  to remove a laptop the audience never looks at.
- **Board-side word wrap and a caption history.** First and fourth on the cut
  list. There is no text-measurement API in the shim — wrapping is `strlen * 6 *
  size` arithmetic you write yourself — and the laptop speakers already tell the
  audience what was heard.
- **Rewriting `config.h` to remove the dead knobs.** Tempting and untimed. They
  are documented as dead in `CLAUDE.md` and in the README; deleting them touches
  a file every other header includes, on the day.
