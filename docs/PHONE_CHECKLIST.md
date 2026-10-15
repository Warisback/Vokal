# Phone checklist

Manual checks on a real iPhone and a real Android phone. The app has only been tested in desktop Edge so far (headless, with a fake microphone and synthetic speech), so none of these has been checked yet, and nothing here is claimed until it is.

For each check, record the phone model, the OS and browser versions, the date and the result. Turn on Settings, About, Show details: the model load time, inference time and press-to-Listening time then appear under What was heard. The load time includes the download on the visit that downloads the model. Memory is not shown in the app and needs the browser's own tools.

## Devices

| | Phone | OS | Browser | Date |
|---|---|---|---|---|
| iPhone | not chosen yet | | Safari | |
| Android | not chosen yet (a mid-range phone) | | Chrome | |

Playwright's WebKit build on Windows would be an early, imperfect signal for Safari. It has not been run either, and it does not replace an iPhone.

## Checks

| # | Check | Why | iPhone | Android |
|---|---|---|---|---|
| 1 | The speech model loads under the page's security policy, on iOS 16.4 or later and on iOS 26. | Edge does not apply the page's policy to the speech worker; WebKit might. If Safari blocks it, `script-src` in `app/index.html` needs `blob:` and `'wasm-unsafe-eval'`, and `PAGE_POLICY` in `server/lib/static.js` must change in the same commit (a server test compares them). | Not checked | Not checked |
| 2 | In airplane mode after setup: the app opens, the model loads, and both a file and the microphone transcribe. | Offline use is checked in desktop Edge only. This also shows whether Safari sends the worker's requests through the service worker. | Not checked | Not checked |
| 3 | Microphone permission after a reload, and after relaunching the home-screen app. Does the phone ask again? The first press should only turn the microphone on. | A permission prompt must not steal a hold and lose what was said. | Not checked | Not checked |
| 4 | Time from press to "Listening", and whether the first syllable is cut off. | The app only records after the recorder starts. On the test laptop, in headless Edge with a fake microphone, this took 108 ms and 82 ms in two runs. | Not checked | Not checked |
| 5 | Which recording format the browser picks (WebM/Opus or MP4), and that it decodes. | A format that fails to decode is skipped for the rest of the session; this checks the first choice works. | Not checked | Not checked |
| 6 | After recording, speech comes from the loudspeaker, not the earpiece. | The app sets the audio session to playback where the browser supports it. | Not checked | Not checked |
| 7 | With VoiceOver and TalkBack on, nothing is announced while the microphone is open. | An announcement would be recorded and transcribed as the person's words. | Not checked | Not checked |
| 8 | Does the home-screen app see the model and phrases saved in Safari? | iOS may keep their storage apart. The setup text says "may" until this is checked. | Not checked | n/a |
| 9 | The screen stays on during the model download. If the phone locks anyway, Download continues from the files already finished. | Phones lock during long downloads. | Not checked | Not checked |
| 10 | Memory: base.en on WebAssembly, and WebGPU on iOS 26, on an older phone. After a crash, the next launch offers to start again or use tiny.en, instead of crashing again. | Loading a model is the most likely way to run out of memory. | Not checked | Not checked |
| 11 | Which voices are local, and whether speech works in airplane mode. | Voices marked "sends text online to speak" fail offline. | Not checked | Not checked |
| 12 | Chrome's local network access prompt, and the server key, when using a suggestion server through an HTTPS tunnel. | The server refuses requests from other machines without its key. | n/a | Not checked |
| 13 | Load time and transcription time per model and device (WebAssembly and WebGPU). | These are the numbers ML step 5 needs. | Not checked | Not checked |
