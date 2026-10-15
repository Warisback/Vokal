# Decisions

What Vokal decided, why, and what was rejected. Some of these were learned on real recordings in v1 (the ESP32 puck and laptop, August 2026). The rest come from the move to the phone in v2 (October 2026).

Numbers here are measured, with what, where and on what hardware. "The laptop" means an Intel Core i5-12450H (12 logical cores, 40 GB RAM) running Windows 11, with integrated Intel UHD graphics and an RTX 3050 laptop GPU (4 GB). In the browser, WebGPU ran on the Intel UHD graphics; the browser did not use the RTX 3050.

## 1. Whisper runs with no prompt, no voice activity detection and no conditioning

Decision. Whisper is never given an `initial_prompt`. In Python, faster-whisper runs with `vad_filter=False`, `condition_on_previous_text=False` and greedy decoding (`beam_size=1`). The web app uses greedy decoding too (transformers.js 4.3.0 has no working beam search: with `num_beams` above 1 it still keeps one token per step) and sends at most one 30 s window, so the two sides behave the same way.

Why.
- An earlier setup note recommended `initial_prompt="A person speaking softly in a quiet voice."`, to bias Whisper towards quiet speech. On a real clip in v1, Whisper wrote the prompt itself into the transcript, so the device would have spoken it as if the person had said it. About 30 s of real speech went missing in the same run. Removing the prompt fixed both.
- Voice activity detection trims quiet speech, and quiet speech is who Vokal is for. The person already chooses where a recording starts and stops by pressing the button.
- Conditioning on previous text lets one invented segment cascade into the next.
- Greedy decoding: v1 judged that beam search buys little on short phrases and costs time. That was not measured. It is a setting in Python if step 5 wants to test it.

Rejected. A better-worded prompt. Any prompt can come back as output; the failure is structural, not a matter of wording. This also rules out the obvious shortcut for the phrase bank (decision 9).

## 2. The guard is mandatory, and it only removes

Decision. Every transcript passes through a guard before it is shown or spoken. It skips the model for a recording that is too short (under 0.3 s), silent (every sample zero) or too quiet (loudest 30 ms frame under -60 dBFS). It drops the whole result when Whisper's no-speech score is above 0.6. It removes sound tags such as `[Music]` or `(laughs)`, subtitle credit lines (`subtitles by`, `amara.org`, `www.`), and a short list of stock filler phrases ("Thank you.", "Thanks for watching", "Bye" and others) when they come at the very end. Each removal is reported with its reason. The JavaScript and Python guards pass the same 100 cases in `shared/guard_cases.json`, and `python/tests/test_guard_parity.py` runs both on 30,000 seeded random strings and checks the results are identical (characters added to Unicode after the version in Python's own database, 15.0 in Python 3.12, are outside that check).

Why. Whisper invents text on silence and noise. In v1 it added "Thank you." to the trailing silence of a real clip; on the laptop in v2, every model tried turned 3 s of digital silence into "you". Most products can live with that. Vokal speaks for someone who may not be able to say "I didn't say that", so an invented sentence is the worst failure it has, worse than a slow answer and much worse than an empty one.

What changed from v1, and what it costs.
- v1 had two guards with different lists, and two of its checks could never fire: the laptop pipeline removed the dot before looking for `amara.org` and `www.`. v2 has one list and checks credit lines on the raw text.
- v1 dropped a whole utterance that contained `www.`. v2 removes only that sentence. Cost: a web address someone really says is still removed.
- v1 removed filler phrases wherever they appeared. v2 removes them only at the end, where Whisper invents them. Cost: a real "Thank you" at the end is removed too. The app shows "Removed at the end: Thank you." with an Add back button. When filler was the whole result and the no-speech score was low, it asks whether the person said it.
- Tags are removed wherever they appear, because text to speech would read them aloud. Cost: a real aside that Whisper writes in round brackets is removed; "Use it anyway" restores it.
- The pre-check uses the loudest 30 ms frame, not the level of the whole clip. A 0.5 s word at -45 dBFS inside a 30 s hold averages about -62.8 dBFS and would have been thrown away; its loudest frame reads -45.

Rejected.
- Filling an empty result with something plausible, such as "Sorry, could you repeat that?". That is inventing speech for a person who cannot object. Vokal says "Didn't catch that" to the person and speaks nothing.
- OpenAI's combined rule (no-speech score above 0.6 and average log probability below -1.0). It would have kept the "you" invented on silence, whose average log probability was about -0.5.
- A voice activity floor. Any level high enough to reject room noise would also reject quiet speech. Room noise goes to the model, and its no-speech score decides.

Open risk. The 0.6 threshold and the filler list rest on stock Whisper and synthetic audio. Fine-tuning may shift the score, and dysarthric speech may score high even when someone is speaking. ML step 1 logs the score for every TORGO clip before the guard is trusted on real users.

## 3. The person reviews before anything is spoken

Decision. The words land in an editable box. Nothing is spoken until the person taps Speak. A suggested correction is shown beside their words and never applied or spoken on its own. "Show on screen" displays the words full size, for a noisy room or when speech fails.

Why. Even with the guard, Whisper mishears. In v1 it heard "help" as "hell" on a real clip and added a sentence nobody said; no filter can catch that. The person is the only reliable check, and one tap is a small price for never being misquoted.

Rejected. Speaking automatically after each recording, as v1 did. It cuts against review, and on iPhone speech that does not start inside a tap needs a workaround that has not been tested. It can come back after the phone checks if users want it.

Also. While the microphone is open, the screen reader live region stays silent and the record button's label changes before the microphone starts. A spoken announcement would be picked up by the microphone and transcribed as the person's words.

## 4. No voice cloning

Decision. Vokal speaks with voices the device already has (in the app) or a stock Piper voice (in Python). Nobody's voice is cloned.

Why. With no cloning there is no voice sample to protect, no vendor holding a disabled person's recording, and no consent question to manage.

Rejected. Cloning a presenter's voice for the v1 demo, with consent, through a hosted voice service. It was defensible, but it brought back a cloud dependency, an account and a key for a small gain.

Later, not built. Voice banking: someone who expects to lose their voice records it while they can, and the device later speaks in it.

## 5. Local voices

Decision. The app uses the browser's speech voices, lists local ones first, and labels any voice that "sends text online to speak". The Python package uses Piper (`en_GB-cori-high` by default), loaded once and kept in memory.

Why. A local voice works offline, has no key, quota or outage, and costs nothing to use.

Rejected. A hosted voice service. v1 started with ElevenLabs and removed it for these reasons.

Measured with the Python package on the laptop (2026-10-14, one run each, writing to a WAV file): `en_GB-cori-high` took 4.6 s to load, including importing Piper and ONNX Runtime, then 841 ms to synthesise 2.21 s of audio. `en_GB-alba-medium` synthesised 3.53 s of audio in 256 ms.

Cost. Piper and most device voices sound synthetic. `cori-high` was picked by ear in v1 from four installed voices.

## 6. Speech to text on the device, in the browser

Decision. Whisper runs in the browser through transformers.js and ONNX Runtime Web. Nothing downloads until the person taps Download, because phone data costs money. After one download the app works offline.

Why.
- Audio is the most sensitive thing Vokal touches. If it never leaves the phone, there is nothing to leak, store or hand to a vendor.
- It works with no signal, which matters for a device someone relies on to speak.
- There is no server to run or pay for, and one static site serves iPhone and Android without app stores.
- The custom model setting is the place a fine-tuned model plugs in without a code change. Loading one through it has not been tried yet.

Rejected.
- A cloud transcription API. The earlier phone prototype sent the recording to a hosted model (Gemini). That needs a network, a key and trust in a provider for every word someone says.
- A laptop doing the work, as in v1. It only works with a laptop nearby.
- A native app for now. It means two code bases and store review. If browser runtimes turn out too slow or too heavy on phones, step 5 compares native runtimes such as whisper.cpp.

Cost. A 43.5 MB download for the default model, plus the speech runtime (26.9 MB, fetched from cdn.jsdelivr.net and cached). Speed and memory on phones are not measured yet. If loading a model crashes the tab, the app notices on the next launch and offers the smaller model. The stored marker this relies on is unit-tested, but the path has not been triggered on a real device yet (phone checklist, item 10).

## 7. WebAssembly by default, WebGPU only when chosen

Decision. The app runs Whisper on WebAssembly unless the person picks WebGPU in Settings.

Why. For `tiny.en`, WebGPU downloads almost three times as much (122.3 MB against 43.5 MB), and nothing has been measured on a phone. On the laptop the speed comparison has gone both ways. All of these runs used synthetic speech in headless Edge 155, WebAssembly on one thread, and WebGPU on the integrated Intel UHD graphics with an fp32 encoder and a q4 decoder:

- A minimal test page that loads the same transformers.js 4.3.0 build and the same pinned model files as the app (not the app itself), 14 October 2026, with a 5.24 s sentence. `tiny.en` q8 on WebAssembly took 1.5 to 2.3 s and `base.en` 4.2 to 5.6 s. `tiny.en` on WebGPU took 2.0 to 2.3 s after the first call (10.6 s on the first visit, 3.8 s on the second). Loading from the cache took 1.6 s for `tiny.en`, 3.1 s for `base.en` and 2.2 s for `tiny.en` on WebGPU.
- The app's own browser test, 14 October 2026, on battery power with other programs open: `tiny.en` took 4.9 to 5.8 s for the 3.16 s sentence on WebAssembly, and 3.0 to 3.5 s on WebGPU.
- The app's own browser test, 15 October 2026, on mains power: `tiny.en` took 3.1 to 3.9 s for the 3.16 s sentence on WebAssembly, and 1.8 to 1.9 s on WebGPU after a first call of 5.6 s. The full table is in the README.

So in the app WebGPU was faster on this laptop, while on the test page it was not. The app was also slower than the test page on the same laptop, for a reason not found yet. Step 5 repeats the comparison on phones.

GitHub Pages does not let a site set the headers that allow more WebAssembly threads (cross-origin isolation). A service worker can add them, as coi-serviceworker does, but every file from huggingface.co and cdn.jsdelivr.net would then have to load under those rules too, and that has not been tried. With those headers on the same test page, `tiny.en` took 1.0 to 1.5 s on 4 threads. The app itself has not been run that way; `node server/server.mjs --isolate` sends the headers for a local try.

Rejected for now. Picking WebGPU automatically when the browser has it. It may become automatic after step 5, with numbers from real phones.

## 8. Optional suggestions run on a server the person controls, off the device

Decision. Correction by a language model is optional and off by default. The person points the app at their own Vokal server (`server/`), which calls a hosted model (Gemma through the Gemini API) or any OpenAI-compatible server, such as llama.cpp or Ollama on the same computer (neither tried yet). Only text is sent: the words on screen and the saved phrases recorded with the current speech model.

Why.
- The models used so far are far too large for a phone, and a provider key cannot sit in a public web page, where anyone could read it.
- It is slow. With hosted Gemma (`gemma-4-26b-a4b-it`), called from a laptop in September 2026, the earlier prototype took up to 25 s per suggestion. So a suggestion never blocks Speak; it arrives later or not at all.
- A language model can invent words, the exact failure the guard exists to stop. Before replying, the server refuses a suggestion that adds or removes a negation, changes a number word or a digit group, or changes more than 30% of the words. Known gaps: names, pronouns and tense are asked for in the prompt but not checked, and one swapped word within the limit passes ("water" to "warfarin"). The person's review is the real safeguard.

Access. A request from the same computer needs no key. Any other request, including one through a tunnel, needs the server key (`VOKAL_ACCESS_TOKEN`). The rule looks at each request rather than the listening address, because a tunnel runs on the same computer and connects from loopback.

Rejected.
- Calling the provider straight from the browser with a key.
- Applying a suggestion automatically.
- Retrying a failed provider call. The server gives up at 45 s, before the app's own 50 s limit.

## 9. The phrase bank is never a Whisper prompt

Decision. The person's saved phrases are used after transcription, by the optional suggestion server, never as a prompt to Whisper.

Why. Decision 1: a prompt can come back as speech. Each phrase also records which model heard it (id, revision, precision, device) and how it was captured (format, bitrate, sample rate, voice processing), and only phrases from the current model are sent. Step 4 needs like-for-like pairs to say whether repair helps.

## 10. No build step, and everything pinned

Decision. The app is plain ES modules with relative URLs, served as static files from any sub-path. transformers.js 4.3.0 is served from the app's own folder, byte for byte: `npm run vendor --prefix app` downloads the pinned build and checks its SHA-256, and a test checks it again. The build is fetched rather than committed because it is 580 KB of someone else's minified code, and because GitHub's secret scanner reads one of its minified strings as an API key. The built-in models are pinned to Hugging Face commit hashes, and a custom model's branch is resolved to a commit when it downloads. The service worker's cache name comes from a hash of the app's files, so a changed file always gets a fresh cache.

Why. What runs is exactly what was tested, with no bundler and no drift in a dependency or a model between visits.

Rejected. A bundler, and loading the library from a CDN at run time (a page script from another host, and its version can move). The ONNX Runtime WebAssembly file is too big to vendor (26.9 MB), so it still comes from cdn.jsdelivr.net, at the exact version the pinned library names.

## 11. No real recordings, from v2 on

Decision. Test audio is synthetic speech from Windows System.Speech, or silence, noise and tones made by the tests. A CI job fails if any audio file other than `app/tests/fixtures/*.wav`, any `.env` file other than an example, or a `secrets.h` is committed.

Why. A recording of someone's voice is personal data, and the people Vokal is for are a vulnerable group. TORGO clips also stay off the repository (see `ml/README.md`).

## 12. Environments and model weights stay outside OneDrive

Decision. Python virtual environments, Piper voices and model weights live outside the repository folder, on a short path.

Why. Two Windows problems, both hit in practice. OneDrive syncing thousands of small files while pip writes them produced packages that imported and then failed at run time. And with long paths off, pip could not install numpy under a deep folder (WinError 206). The local server's `--models` option serves weights from any folder for this reason.

## v1 hardware lessons

The ESP32-S3 puck is gone, but these cost real debugging time and apply to any small device. Most of the board work behind them is by [@stosifian](https://github.com/stosifian).

- USB serial writes block when nothing is reading. With no serial monitor attached, the transmit buffer filled and every `printf` stalled the main loop for the full timeout: the screen updated every few seconds and touch felt dead. It only behaved while a monitor was attached, which is exactly the condition that hid the bug during development. The fix was `Serial.setTxTimeoutMs(0)`, which drops debug output instead of blocking, plus an `availableForWrite()` check before writes on hot paths.
- The IMU's default low-pass filter erased taps. On the QMI8658 it sits at 2.66% of the output data rate, a 3.3 Hz corner at 125 Hz, which removes a tap transient completely. The fix was to turn the filter off and raise the rate to 1000 Hz. Tap detection then keyed off the high-passed vertical axis plus pulse width, because amplitude alone cannot tell a finger strike from picking the device up.
- The I2S receive ring kept old audio. The capture task stops reading between recordings, but the I2S channel keeps running, so the first reads of a new recording return sound from before the press. For a meeting recorder that is invisible; for a short phrase it is not. The capture task also only checked the stop flag at the top of its loop, so the byte count could still grow for one read after stop. The fix designed for push-to-talk was to drain the ring before arming, and to have the capture task set an idle flag that the sender waits for. A fixed delay was rejected: it works until the chunk size changes. The push-to-talk firmware was not finished, so this fix is not in the tagged code.
- Touch was sampled at 200 Hz and the screen painted at 10 Hz, so a click flag that lasted one sample was usually missed. Clicks are latched until the paint pass has seen them.
- Capture ran in its own task on one core and the screen on the other, so neither could starve the other.

The v1 code is kept at the git tag `v1-esp32-puck`.
