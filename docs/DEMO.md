# Vokal — 60-second demo runbook

Judged on creativity, technical execution and usability. Sixty seconds. Two
people, two beats, one sentence of ethics, and a ladder to climb down if the
network dies.

Read this the night before, not on stage.

## Cast

**Presenter** — holds the board, talks to the room, never touches the laptop.
**Operator** — sits at the laptop, watches the terminal, says nothing unless the
ladder is being climbed. The operator's job is to be boring.

On the table: the board (unplugged, on battery), the laptop (plugged in, volume
up, terminal visible on the projector if there is one), and the phone providing
the hotspot, on charge, screen unlocked.

## What is actually running

Both models are **local**. Speech-to-text is faster-whisper `small.en` int8;
text-to-speech is **Piper**, voice `en_GB-cori-high`, loaded from
`C:\vokal-venv\voices`. There is no API key, no account and no internet
dependency — the only network traffic is the board posting audio to the laptop
over the hotspot. Nothing can rate-limit you, expire on you, or sit behind a
venue captive portal.

Timings you can quote, measured on this laptop:

| | |
|---|---|
| clip beat (tap -> sound) | **~50 ms** of laptop work — the audio is pre-rendered to disk |
| live beat (release -> first audio) | **~2 s**: ~600 ms upload, ~0.3 s Whisper, 0.83 s Piper |
| Piper `en_GB-cori-high` | 0.83 s to first audio, RTF 0.197 |
| faster-whisper `small.en` int8 | RTF 0.103 on real speech |

## The four commands

Everything on the laptop is these. Learn them now; nobody reconstructs a command
line on stage. **Use the venv interpreter explicitly** — the repo has no `.venv`
and the system `python` does not have these packages.

```powershell
cd laptop
C:\vokal-venv\Scripts\python.exe server.py                   # the real thing: whisper + Piper
C:\vokal-venv\Scripts\python.exe server.py --fake            # canned pipeline, no models
C:\vokal-venv\Scripts\python.exe smoke.py --host <laptop ip> # one-shot readiness check, exits non-zero
C:\vokal-venv\Scripts\python.exe smoke.py --watch            # live /state monitor, second terminal
```

`server.py` is the entry point — there is no other one. Start it **in a real
console window**, not piped, not backgrounded, not through a wrapper that eats
stdin: the keyboard fallback the whole failure ladder rests on is only started
when `sys.stdin.isatty()` is true, and it is silently skipped otherwise. Do not
pass `--no-hotkey`.

Give it a few seconds after start. Piper's `PiperVoice.load()` costs ~2.3 s and
the whisper model has to come off disk; both are loaded once at startup so that
no utterance ever pays for them. `/health` going true is the signal it is done.

**Do not type `curl` on stage.** In this PowerShell, `curl` is an alias for
`Invoke-WebRequest` (`Get-Command curl` says so), which takes different
parameters and dies with a parameter-binding error at the worst possible moment.
`curl.exe` — with the extension — is the real one, and that is what the examples
in `laptop/README.md` use. On stage, use neither: the keyboard fallback in the
server's own terminal is one keystroke and cannot be mistyped.

## Pre-flight — T-10 minutes

Do all of it. In order. Tick it off out loud.

- [ ] **Phone hotspot on, 2.4 GHz.** iPhone: Settings > Personal Hotspot >
      **Maximise Compatibility ON**. The ESP32-S3 has no 5 GHz radio and will not
      even see the network otherwise.
- [ ] **Laptop joined to that hotspot.** Not the venue wifi. Both devices must be
      on the same network.
- [ ] **Laptop IP matches `firmware/secrets.h`.** *This is the one that will get
      you.* A hotspot hands out a new address every time it restarts, and a stale
      `VOKAL_HOST` means the board POSTs into the void — it looks exactly like a
      dead board, and it is not.
      `Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like "*Wi-Fi*" }`
      It was **192.168.4.211** when this was written. If it has changed, edit
      `VOKAL_HOST` and reflash — that is a 60-second job now and an impossible one
      on stage.
- [ ] **Firewall allows inbound 8000.** Windows blocks it silently by default and
      the symptom is a board that times out with a healthy-looking server. As
      admin, once:
      `New-NetFirewallRule -DisplayName "Vokal 8000" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow`
- [ ] **The Piper voice file is where the server expects it.**
      `C:\vokal-venv\voices\en_GB-cori-high.onnx` and its `.json` sidecar. The
      voice and voices directory are set in `laptop/.env` with
      `PIPER_VOICE=en_GB-cori-high` and `PIPER_VOICE_DIR=C:\vokal-venv\voices`
      (both optional — those are already the defaults). No API keys to fill in
      — there are none in this project.
- [ ] **Server started, in its own console window.** `cd laptop`, then
      `C:\vokal-venv\Scripts\python.exe server.py`. It prints the
      keyboard-fallback help on start — if you do not see that block, stdin is
      not a tty and the fallback is not running. Fix that before anything else;
      it is the ladder.
- [ ] **Server healthy from the laptop.**
      `C:\vokal-venv\Scripts\python.exe smoke.py` — it checks `/health`, the
      `/state` shape, `/speak`, `/replay`, `/utterance` and the clip beat, and
      exits non-zero if any of it is wrong. `/health` must come back
      `{"ok":true,"whisper":true,"tts":true,"voice_id_set":true}`.
      `voice_id_set` is a frozen field name from the old contract; it now means
      **the Piper voice model loaded**. False means TTS will not speak.
- [ ] **Server healthy across the hotspot.**
      `C:\vokal-venv\Scripts\python.exe smoke.py --host <laptop ip>` from
      anywhere on the same network. Passing on localhost and failing across the
      hotspot is the firewall.
- [ ] **Listen to `clip1_rendered.wav` once, at full volume.** It is the first
      sound the room hears. It is a file on disk; if it sounds right now it will
      sound right on stage.
- [ ] **`VOKAL_CLIP_CREDIT` names the real source.** It lives in
      `firmware/config.h`, it is the on-screen credit for the clip beat, and the
      ethics answer rests on it being true and specific. 30 characters at
      `UI_S=2`, so it has to be short. Setting it means a reflash — do it now,
      not at T-2.
- [ ] **Board boots, joins, and reaches the laptop.** Watch the serial log for
      `[net] online as <ip>`. Then confirm a `GET /health` from the board.
- [ ] **Volume beats the room.** Play the clip beat once at full volume with
      people talking nearby. Crowd noise is the single most common reason a demo
      that worked in the corridor dies on stage. External speaker if there is one.
- [ ] **Battery.** Board charged and off the cable. Being tethered undercuts the
      whole "handheld" argument.
- [ ] **A data cable in your pocket** in case you have to reflash. Charge-only
      cables enumerate nothing, and a hotspot IP change means a reflash.
- [ ] **`POST /replay` has something to replay.** Run the full live beat once in
      rehearsal so there is a cached last-good result. `/replay` returns 409 if
      nothing has been spoken yet, which is the worst possible time to find out.
- [ ] **Rehearse the full 60 seconds twice.** Not once. Put
      `smoke.py --watch` on a second terminal while you do it — it prints every
      `/state` transition, so the operator can see `processing` -> `speaking`
      land and can time the real gap instead of guessing at it.

## The clip beat, and why it cannot fail

Beat 1 does not run the pipeline. The work was done offline and the answer is on
disk.

| | |
|---|---|
| source | `laptop/demo_clips/clip1_source.wav` — 21.20 s, 16 kHz mono, an excerpt at source offsets 8.0–29.2 s |
| transcript | `laptop/demo_clips/clip1.txt` — **hand-corrected by a human** |
| what plays | `laptop/demo_clips/clip1_rendered.wav` — 14.61 s, 22050 Hz, Piper `en_GB-cori-high` |

The transcript was corrected by hand because Whisper misheard **"help" as
"hell"** and added a sentence nobody said. On the beat that must not fail we do
not rely on the hallucination guard — a person read the words against the audio
and we froze them.

So at demo time `POST /demo/trigger` opens a file and starts playback: **~50 ms**.
No model runs. A loud room, a slow laptop and a busy CPU cannot touch it.

Note the timing when you rehearse: the rendered clip is **14.6 seconds long**.
That is most of your minute if you let it run. Talk over the tail deliberately or
be ready to move at the point in the audio you have chosen — do not stand
listening to all of it.

## The 60 seconds

| t | who | what happens | what is said |
|---|---|---|---|
| 0:00 | Presenter | holds up the board | "This is for people whose words are intact but whose voice cannot carry them. MND, laryngectomy, vocal-cord paralysis." |
| 0:05 | Presenter | thumb over the demo pad | "This is a recording of someone whose voice is failing." |
| 0:08 | Presenter | **taps the demo pad** | *(tap, then stop talking)* |
| 0:09 | Laptop | speaks, clear, credit line on the board | *(silence — let the first sentences land)* |
| 0:16 | Presenter | points at the credit line, over the tail of the clip | "That voice is a local speech model on the laptop. We cloned nobody. Nothing left the machine." |
| 0:22 | Presenter | raises the board to their mouth | "That was a recording. This is me." |
| 0:26 | Presenter | **holds the pad, whispers a sentence, releases** | *(whisper it — the point is that the room cannot hear you)* |
| 0:30 | Board | ring red while held, amber on release | "Three seconds of raw audio, sixteen kilohertz, straight off the board." |
| 0:32 | Laptop | speaks the sentence | *(stop talking — let the voice land)* |
| 0:36 | Presenter | — | "Speech to text and text to speech, both running on that laptop, offline. About two seconds, press to sound. No account, no API key, no recording of anybody's voice going anywhere." |
| 0:48 | Presenter | holds up the board one more time | "It is one button you can find without looking, one-handed, while you are looking at the person you are talking to. A phone cannot do that." |
| 0:57 | Presenter | — | "Ask us anything." |

**The whisper matters.** Do not project. If the room can hear you unaided, the
demo has no problem to solve.

**The source clip is never played aloud.** The board triggers the beat and the
laptop speaks the *result*; there is no "before" audio in this demo. The contrast
the audience gets is the presenter's own whisper at 0:26 against the clear voice
at 0:32 — and that is the one that matters anyway, because they can hear both.

## What to say while the pipeline runs

There is exactly **one** silence to fill: 0:30 to 0:32, from the release to the
voice. It is about two seconds. Silence on stage reads as a crash, so fill it
every time, even when it is fast — the fill line is in the table and it is doing
real work, saying what just left the board at the moment the audience is looking
at a screen with nothing on it.

That fill is **one sentence, about two seconds**, and it is sized that way on
purpose. If the voice starts while you are still talking, stop mid-sentence. The
architecture line has its own slot at 0:36, after the voice has landed, where
nothing is competing with it. If it runs long, keep going: "the board holds the
audio in PSRAM and posts it raw — no file, no upload dialogue." Past about six
seconds, stop narrating and climb the ladder.

The clip beat has no silence to fill at all — it starts speaking in about a tenth
of a second. **Do not talk over the opening of it.** Every row that says
*silence* is an instruction, not a stage direction: the ethics line at 0:16 lands
over the *tail* of the clip, once the first sentences have been heard, not on top
of them.

## Failure ladder

Climb down one rung at a time. Never explain a rung you have not had to use, and
never announce a fallback as a failure — the audience does not know what was
supposed to happen.

Every rung is **one line typed into the server's own terminal**, the one the
operator is already watching. The server reads them directly and calls the
engine, not HTTP, so they keep working when the network is the thing that broke:

```
[Enter] or r    replay the last thing that was spoken
s <text>        speak that text now
c <clip_id>     run the clip beat: pre-rendered audio, credit line
h               health
?               help
```

This only exists if the server was started in a real console — it is skipped
when stdin is not a tty, and `--no-hotkey` disables it. Confirm the help block
printed at startup during pre-flight, not now. And do not reach for `curl` here:
in this PowerShell it is an alias for `Invoke-WebRequest` and errors on the
parameters.

**Rung 1 — the mic dies.** No caption, a caption that is nonsense, or a board
that captures silence because the room is too loud. Do not debug the mic.

- If you have a **lavalier mic** on the laptop, plug it in and repeat the live
  beat into that: the pipeline does not care where the audio came from, and it is
  still a live, unscripted sentence.
- If you do not, the presenter says the sentence out loud as narration first, so
  the room hears it as speech and not as a prompt being typed, and the operator
  types `s <the sentence>`. It comes out of the speakers exactly as it would
  have, and only the operator knows.

**Rung 2 — the network dies.** The board never joins, or it sits on amber
forever (which is also what a stale `VOKAL_HOST` looks like — see pre-flight).
The laptop is a whole working product on its own:

- **Clip beat down:** type `c clip1`. That plays the same pre-rendered WAV the
  board would have triggered — same audio, same credit line, ethics sentence
  still true.
- **Live beat down:** `s <the sentence>`, after narrating it, as in rung 1.

**Never rescue the clip beat with `s`.** `s` tags the job as live and carries no
credit line. `c clip1` is the only clip rescue, because the credit is part of the
claim you are making out loud.

**Rung 3 — everything on the laptop side is unhappy** (whisper or Piper
erroring). Press **Enter** (or `r`) — replay. It re-runs the last successful
result, audio and caption, with no STT, no TTS and no network round trip. This is
why you rehearsed: the cached result is the one from rehearsal and it is good.

**Rung 4 — total loss.** Play `laptop/demo_clips/clip1_rendered.wav` from the
file manager and say plainly: "The wifi in here has beaten us; this is the run
from twenty minutes ago." Judges have seen a hundred demos fail and respect the
team that says so without flinching. Then hand them the board and let them press
the pad — the ring still goes red locally on press, because the board sets
`listening` itself without waiting for a round trip. Something still works in
your hand.

Do not, at any point, start debugging on stage. The 60 seconds are gone either
way; a calm fallback keeps the pitch and a terminal does not.

## What judges will actually ask

**"Why hardware and not a phone app?"**
A phone is not a voice. It is a lock screen, a passcode, a notification and a
thing you hold flat and look at. This is one physical control you can find
without looking, one-handed, in a pocket, while you are looking at the person you
are talking to. It boots into one function and a call cannot interrupt it. And
the screen is the consent surface — the person you are speaking to can see what
it says, which is not true of someone staring into a phone.

**"What about dysarthric or stuttered speech? Would this work for them?"**
Not today, and we will not pretend otherwise. General speech recognition fails on
exactly the speech patterns of the people who need this most. The route is
personalised recognition: about **1.4 hours of a user's own audio takes
recognition from unusable to roughly 16% word error**. That is the roadmap and it
is a solved research problem, not a hope.
**Do not run dysarthric audio through the demo.** Do not say "it handles that".
Naming the limit is a strong answer; being caught overclaiming it ends the pitch.

**"Whose voice is that? Did you have consent?"**
Nobody's — and that is the point. It is a general-purpose synthetic voice, Piper
`en_GB-cori-high`, running locally on that laptop. We do not clone voices, we do
not hold anybody's voice recording, and there is no consent question to answer
because we never ask anyone for their voice. The source recording in the clip is
credited on screen, because not cloning someone still does not entitle you to use
their recording uncredited.

If they push — *"but wouldn't people want their own voice back?"* — that is the
right question and the answer is **voice banking**: people diagnosed with MND
often record their own voice while they still can, and giving Vokal a voice built
from that recording, on their own device, by their own choice, is exactly where
this goes next. It is the roadmap. **It is not in this build**, and say so.

**"What happens if the wifi dies?"**
Nothing needs the internet — both models are on the laptop, so there is no
service to lose. The hotspot only carries board-to-laptop audio, and if that
drops, the laptop still drives the whole pipeline on its own, the clip beat is a
WAV already on disk, and `/replay` re-runs the last good result with no network
and no model at all. Longer term the laptop is a stand-in for a phone in your
pocket over BLE, or an on-device model; the split is where it is because a
2-second latency budget is easier to hit on a laptop than on an S3. It is a
deployment decision, not an architectural one.

**"How long from press to sound?"**
About two seconds, logged per stage. A three-second utterance is about **96 KB**
— 16 kHz, 16-bit, mono — and goes up over 2.4 GHz in well under a second;
faster-whisper `small.en` int8 runs at RTF 0.103, so roughly 300 ms on it; Piper
reaches first audio in 0.83 s. The budget is in `PROTOCOL.md`. If we ever needed
it faster, the `*-medium` Piper voices hit first audio in 0.13 s — we chose the
better-sounding voice on purpose.

**"Doesn't Whisper make things up?"**
Yes, and it did — to us, today, on this clip. It invented "Thank you." on
trailing silence, and an `initial_prompt` we thought would help made it emit the
prompt as a transcript segment and drop thirty seconds of real speech. For a
device that speaks on behalf of someone who cannot correct it, that is the worst
failure there is, so we ship a guard: no prompt, no VAD, no conditioning on
previous text, drop low-confidence segments, strip the known hallucination
phrases, and if nothing survives, say `(didn't catch that)` rather than invent
filler. The clip beat's transcript is hand-checked on top of that.

**"Why does the board not do the recognition itself?"**
It could do keyword spotting; it cannot do open-vocabulary recognition and
natural synthesis in two seconds. We put the work where the work fits and kept
the board doing the one thing only hardware can do — being a button you can find
without looking.

## After

Leave the board on the table and let people pick it up. It does something in the
hand — the ring responds to the pad immediately, with no network involved. That
is the last impression, and it is free.
