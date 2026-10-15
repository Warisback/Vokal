# vokal (Python package)

A small reference package with the same Whisper settings and guard as the web app. It turns an audio file into text with faster-whisper, removes text that Whisper is known to invent, and can speak the result with a local Piper voice. It is the seam for the ML work: evaluation code can import `vokal.stt` and `vokal.guard`, and a fine-tuned Whisper model converted to CTranslate2 runs through `--model` (not tried yet with a fine-tuned model).

It has only run on Windows so far. A Raspberry Pi is an aim, not something that has been tried. There is no training or evaluation code here.

The package is versioned with the app (2.0.0).

Vokal has not been evaluated on dysarthric or other atypical speech. The measurements on this page use a synthetic voice.

## Install

Make the virtual environment outside OneDrive and away from long folder paths. OneDrive corrupts files in `site-packages`, and with Windows long paths off, numpy fails to install under a deep folder (WinError 206).

```
py -3.12 -m venv C:\venvs\vokal
C:\venvs\vokal\Scripts\activate
pip install -e "python[stt,dev]"
```

Run the `pip install` from the repository root. On Linux or a Raspberry Pi, use `python3 -m venv` and `source <venv>/bin/activate`. Not tried on Linux or a Raspberry Pi yet.

| Extra | Installs | Needed for |
|---|---|---|
| none | nothing | the guard and `--help` |
| `stt` | faster-whisper 1.2.1, av 18.1.0, numpy | `transcribe` and `say` |
| `tts` | piper-tts 1.7.0 | `speak` and `say` |
| `audio` | sounddevice 0.5.6 | playing speech on the speakers (not needed with `--out`) |
| `all` | `stt`, `tts` and `audio` | everything |
| `dev` | pytest 9.1.1 | the tests |

`av` is pinned because faster-whisper 1.2.1 asks only for `av>=11`, and its `decode_audio` fails with av 19.0.1. numpy is not pinned: ctranslate2 is built against one numpy generation, and forcing the other one gives an `_ARRAY_API not found` import error.

Resolved on 2026-10-14 by `pip install -e "python[all,dev]"` on Windows 11 with Python 3.12.10: faster-whisper 1.2.1, av 18.1.0, ctranslate2 4.8.3, numpy 2.5.4, onnxruntime 1.31.0, piper-tts 1.7.0, sounddevice 0.5.6, pytest 9.1.1. Python 3.10 and 3.11 are allowed by `pyproject.toml` but have not been tried.

## Commands

```
vokal transcribe FILE [--json] [--segments]
vokal speak TEXT [--out FILE.wav]
vokal say FILE [--out FILE.wav]
```

`python -m vokal` works the same way.

- `transcribe` decodes the file to 16 kHz mono, checks its length and level, runs Whisper, applies the guard, then prints the text, one line per removal and the timings. When nothing is left it prints `(didn't catch that)`, or `(no sound in the recording)` when every sample is zero. `--segments` adds each segment with its `no_speech_prob` and `avg_logprob`. `--json` prints one object with `text`, `raw`, `removed`, `segments`, `level_dbfs`, `duration_s`, `pre_check`, `timing_ms` and `model`.
- `speak` says the text with a Piper voice, or writes it to a WAV file with `--out` (no sound card needed).
- `say` does `transcribe`, then speaks the guarded text. Nothing is spoken when nothing is left.

Example, from the measurement below:

```
> vokal transcribe sentence-16k.wav --model tiny.en
I would like a glass of water, please. Could you open the window?
audio: 5.36 s, loudest 30 ms frame -12.4 dBFS
model: tiny.en (cpu, int8, beam 1)
timing: decode 469 ms, model load 1700 ms, stt 566 ms, guard 1 ms, total 2768 ms
```

Settings. A flag overrides its environment variable. There is no `.env` loading.

| Flag | Environment variable | Default |
|---|---|---|
| `--model` | `VOKAL_WHISPER_MODEL` | `small.en` |
| `--device` | `VOKAL_WHISPER_DEVICE` | `cpu` |
| `--compute-type` | `VOKAL_WHISPER_COMPUTE_TYPE` | `int8` |
| `--beam-size` | `VOKAL_WHISPER_BEAM_SIZE` | `1` |
| `--language` | | `en` |
| `--no-speech-max` | | `0.6` |
| `--voice` | `VOKAL_PIPER_VOICE` | `en_GB-cori-high` |
| `--voice-dir` | `VOKAL_PIPER_VOICE_DIR` | none, so it must be set for `speak` and `say` |
| `--output-device` | `VOKAL_OUTPUT_DEVICE` | the system output (an index, or part of a device name) |

Exit codes: 0 on success (including "didn't catch that"), 1 for a runtime error with a one-line message, 2 for a usage error.

## Whisper settings, and why

These come from v1. The first three were found on real recordings.

- No `initial_prompt`, ever. In v1 a prompt came back as transcript text and about 30 s of real speech was lost. This also means the phrase bank is never fed to Whisper.
- `vad_filter=False`. The person already chose where the recording starts and stops (a press of the button, or the file itself), and voice activity detection trims quiet speech, which is the speech this product is for.
- `condition_on_previous_text=False`. It stops one invented segment from cascading into the next.
- `beam_size=1` (greedy) by default. v1 found that beam search bought little on short utterances; that was not measured.
- No resampling of its own. Files are decoded by faster-whisper's `decode_audio` (PyAV), which filters before it downsamples. Measured on 2026-10-14: a 10 kHz tone in a 48 kHz WAV came out 111 dB down, where the plain decimation v1 used left it at full level, folded to 6 kHz. `test_decoder_filters` checks this whenever faster-whisper is installed.

## The guard

`vokal.guard` runs before anything is printed or spoken. It only removes text and reports each removal with its rule. The rules are the same as the web app's guard, and both are tested against [`shared/guard_cases.json`](../shared/guard_cases.json).

- Before the model: a recording under 0.3 s, one where every sample is zero, or one whose loudest 30 ms frame is under -60 dBFS is not sent to the model at all.
- Per segment: a segment whose `no_speech_prob` is above 0.6 is dropped. faster-whisper gives every segment from one 30 s decoding window the same score, so this mostly catches a window decoded from trailing silence.
- On the text: sentences with no letters or digits, tags such as `[Music]` or `(laughs)` and music notes, subtitle credit lines, and filler phrases such as "Thank you." at the very end.

Removals are logged to the `vokal.guard` logger at DEBUG, never at INFO.

The 0.6 threshold and the filler list rest on stock Whisper and synthetic audio. Fine-tuning may change how the score is calibrated, and atypical speech may score high even when someone is speaking.

## Running a fine-tuned model

`--model` (or `VOKAL_WHISPER_MODEL`) takes a size name such as `tiny.en`, `base.en` or `small.en`, or a local CTranslate2 folder. A folder must hold `model.bin` and the tokenizer files. To convert a Whisper model with merged LoRA weights:

```
ct2-transformers-converter --model <merged model folder> --output_dir <ct2 folder> --copy_files tokenizer.json preprocessor_config.json --quantization float16
vokal transcribe clip.wav --model <ct2 folder> --compute-type int8
```

Keep model folders outside OneDrive. The training and export plan is in [`ml/README.md`](../ml/README.md).

## Voices

A Piper voice is an `.onnx` file with its `.onnx.json` config beside it. Keep them in a folder outside the repository, then pass `--voice-dir` or set `VOKAL_PIPER_VOICE_DIR`. With the `tts` extra installed, Piper can download one:

```
python -m piper.download_voices --download-dir C:\piper-voices en_GB-cori-high
```

If a voice is missing, the error lists the voices that are in the folder.

## Measured

One run each, 2026-10-14. Laptop with an Intel Core i5-12450H, Windows 11, Python 3.12.10, CPU, int8. Input: a synthetic sentence ("I would like a glass of water, please. Could you open the window?") made with Windows System.Speech (voice Microsoft David Desktop), 16 kHz mono, 5.36 s. The models were already on disk. Timings change from run to run, so treat these as a rough guide.

| Command | Result |
|---|---|
| `transcribe --model tiny.en` | text correct, `no_speech_prob` 0.020; decode 469 ms, model load 1700 ms, stt 566 ms |
| the same again | decode 510 ms, model load 711 ms, stt 550 ms |
| `speak` with `en_GB-cori-high`, `--out` | voice load 4629 ms, synthesis 841 ms for 2.21 s of audio |
| `say` with `en_GB-alba-medium`, `--out` | synthesis 256 ms for 3.53 s of audio |

The first decode and voice load in each process include importing faster-whisper and PyAV, or Piper and ONNX Runtime. Playback on the speakers was not timed.

## Tests

```
pytest python/tests
```

The tests need no model download and no sound card. They load every case in `shared/guard_cases.json`, and use fake models, a fake Piper voice and a fake `sounddevice`. `test_decoder_filters` runs only when faster-whisper is installed, and is skipped otherwise.

## Not done yet

- No live microphone loop. v1's listen loop and its streaming player have not been ported.
- No evaluation on atypical speech.
