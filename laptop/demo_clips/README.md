# demo_clips/ — the CLIP beat

The clip beat is demo beat 1: tap the board, and a pre-recorded clip of someone
with a weak voice comes out clear and loud through the speakers, with a credit
on screen. It is the beat that must not be able to fail on stage.

**It is pre-rendered.** At run time this beat plays a WAV off the disk and reads
a caption out of a text file. There is no speech-to-text and no text-to-speech
in the path — no model, no microphone, no network. That is the whole point: the
one beat we cannot afford to lose does not depend on anything that can be slow,
mishear, or fall over in a noisy room.

---

## How a clip is stored

Two files per clip, named off the clip id:

| file | what it is |
|---|---|
| `<id>_rendered.wav` | **what the audience hears.** The transcript already spoken by the local Piper voice, rendered ahead of time. This is the only file the clip beat plays. |
| `<id>.txt` | the caption the board displays, and the exact text that was rendered. |
| `<id>_source.wav` | optional. The original recording, kept so the clip can be re-rendered or re-checked. **Never played on stage.** |

`pipeline.list_clips()` finds clips by scanning this directory for
`*_rendered.wav`; the id is the filename with `_rendered.wav` removed. A clip
with no `_rendered.wav` does not exist as far as the server is concerned, and
`/demo/trigger` answers 404 for it.

Shipped clip: **`clip1`** — `clip1_rendered.wav` (14.6 s, 22050 Hz) rendered
from `clip1.txt`, with `clip1_source.wav` (21.2 s, 16 kHz) kept as the source.

---

## The rules — not preferences

From [`../../PROTOCOL.md`](../../PROTOCOL.md) § *Voice ethics*:

> Nothing is cloned and nothing leaves the laptop. Speech-to-text and
> text-to-speech both run locally. There is no account, no API key, and no
> voice model built from anybody's recordings — so there is no consent
> question to get wrong.

1. **Nobody's voice is cloned, including the person in the clip.** The clip is
   spoken by `en_GB-cori-high`, a general-purpose local Piper voice that sounds
   like nobody in particular. This is structural, not a policy we remember to
   follow: there is no cloning code in the repo to reach.
2. **Credit the source on screen, every time.** The board owns that string —
   `VOKAL_CLIP_CREDIT` in [`firmware/config.h`](../../firmware/config.h).
   `/state` carries no credit field. Set it to the real source before the demo.
3. **Only use audio you are allowed to use.** Get it from someone who recorded
   it themselves and agreed to this specific use, or from a source whose licence
   plainly permits it. "It was on the internet" is not a licence.
4. **Do not commit a person's voice recording casually.** `*.wav` here is
   gitignored by default. `clip1_source.wav` and `clip1_rendered.wav` are
   explicitly un-ignored in `../.gitignore` because they are cleared and because
   the demo's safety net has to survive a fresh checkout. Any *other* clip stays
   ignored unless you clear it the same way, deliberately.

If you cannot satisfy 1–4 for a clip, do not use that clip. Record a colleague
speaking quietly instead — it demonstrates exactly the same thing.

---

## Adding or re-rendering a clip

Rendering is a one-time offline step. Put the transcript in `<id>.txt`, then
render it with the same voice the live beat uses:

```powershell
C:\vokal-venv\Scripts\python.exe -c @'
from piper import PiperVoice
import wave
voice = PiperVoice.load(r"C:\vokal-venv\voices\en_GB-cori-high.onnx")
text = open("clip2.txt", encoding="utf-8").read().strip()
pcm, rate = bytearray(), 22050
for ch in voice.synthesize(text):
    pcm += ch.audio_int16_bytes
    rate = ch.sample_rate
w = wave.open("clip2_rendered.wav", "wb")
w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(pcm)); w.close()
'@
```

Then **listen to the rendered file** before you trust it on stage.

Keep clips short — the audience is listening to the output. `clip1` is 14.6 s,
which is already about a quarter of the pitch; see `docs/DEMO.md`, where the
ethics line is timed to land over the clip's tail rather than after it.

---

## Firing it

```powershell
curl.exe -s -X POST http://localhost:8000/demo/trigger -H "Content-Type: application/json" -d "{\"clip_id\":\"clip1\"}"
```

Or tap the board. Check what the server can see:

```powershell
curl.exe -s http://localhost:8000/health
```

`clips` lists every id it found. If `clip1` is missing from that list, the
`_rendered.wav` is not where the server is looking — fix that before anything
else, because it is the beat that cannot fail.

---

## Before the demo

- [ ] `/health` lists `clip1` in `clips`.
- [ ] The clip plays, all the way through, out of the speakers you will use.
- [ ] The credit line (`VOKAL_CLIP_CREDIT`) names the real source.
- [ ] `clip1.txt` matches the rendered audio word for word — it is the caption.
- [ ] You can say out loud where the clip came from and who agreed to it.
