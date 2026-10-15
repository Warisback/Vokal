# Vokal ML plan

Vokal runs stock Whisper today. Stock Whisper is trained mostly on typical voices, and Vokal has not been evaluated on atypical (dysarthric) speech at all. This folder is the plan for changing that: measure how badly stock Whisper does, adapt it to one person's speech, test whether a language model can repair what is left without inventing words, then make the result small enough for a phone.

I am writing the ML code (data loading, splits, training, scoring) myself, step by step, to learn it. That is why there is no code here yet. The product side is already built with seams where a trained model plugs in (see [Where a trained model plugs in](#where-a-trained-model-plugs-in)).

## Status

| Step | Question | Status |
|---|---|---|
| 1. Baseline | How badly does stock Whisper do on dysarthric speech, per speaker? | In progress, started 10 October 2026 |
| 2. Splits | How do I split TORGO so the test set is really unseen? | Planned |
| 3. Fine-tune | Does a little of one person's speech make a real difference? | Planned |
| 4. Repair | Does a language model with the person's phrase bank fix words or invent them? | Planned |
| 5. Shrink | How much accuracy survives the move to a phone? | Planned |
| 6. Ship | What helped, what did not, for whom? | Planned |

Nothing below is a result. Results go in this file, with their conditions, as each step finishes.

## The data: TORGO

[TORGO](https://www.cs.toronto.edu/~complingweb/data/TORGO/torgo.html) is a database of speech from people with dysarthria caused by cerebral palsy or amyotrophic lateral sclerosis (ALS), with matched control speakers, from the University of Toronto and the Holland Bloorview Kids Rehab hospital in Toronto. The public download has eight speakers with dysarthria (F01, F03, F04, M01 to M05) and seven controls (FC01 to FC03, MC01 to MC04). The prompts are non-words, short words, read sentences and spoken descriptions of pictures. Each session was recorded through two microphones at once: an array microphone about 60 cm away and a head-mounted one.

Two facts about it shape the evaluation:

- Speakers read the same prompt lists, so the same sentence appears for many speakers.
- Many prompts are single words, including "yes" and "no". Short words like these matter most in this product, and a short clip gives Whisper the least to go on, so they are the first place to check the guard's no-speech threshold.

## The plan

### Step 1. Baseline Whisper on TORGO

Question: how far is stock Whisper from usable on dysarthric speech, and for whom?

- Run stock Whisper (the same settings as the product, below) on every TORGO utterance and score word error rate (WER) per speaker and per severity group, with the number of utterances behind each figure. Report single-word prompts and sentences separately, and the control speakers beside the dysarthric ones.
- Log Whisper's `no_speech_prob` for every utterance, split by prompt length. The product's guard drops a result when this score is above 0.6. That threshold was set on stock Whisper with typical and synthetic speech. If dysarthric speech scores high while someone is clearly speaking, the guard would silently drop exactly the speech Vokal is for. This step finds out before anyone relies on it.
- Published: a table per speaker and severity, the no-speech score distribution, and the exact model, settings and text normalisation used.
- Seam: `vokal transcribe FILE --json --segments` in `python/` already returns the text, the raw text, each segment's `no_speech_prob` and `avg_logprob`, and what the guard removed. Evaluation code can also import `vokal.stt` and `vokal.guard` directly.

### Step 2. Speaker-disjoint and sentence-disjoint splits

Question: is the test set really unseen?

- A random split of clips leaks. Because speakers read the same prompts, the same sentence would land in training and in test, and the model would be scored partly on text it has already learned. That flatters the result.
- Two kinds of split answer two different questions:
  - Speaker-disjoint (no test speaker in training): does the model generalise to a new person?
  - Sentence-disjoint (no test prompt in training, for one speaker): does adapting to one person carry over to things they have not said yet? This is the product's case, where a person records a few phrases and then says something new.
- Both microphone recordings of one utterance go on the same side of a split, and the results say which microphone was scored.
- Fix the splits before any training, and publish the list of utterance ids in each split (not the audio).

### Step 3. Fine-tune Whisper-small with LoRA on one speaker

Question: does a small amount of one person's speech make a real difference?

- LoRA (low-rank adaptation) trains a small set of extra weights instead of the whole model. That keeps memory needs down, which matters on an RTX 3050 laptop GPU (4 GB), and leaves the base model unchanged.
- Whisper-small first, because it is the largest size that should train this way in 4 GB, so it shows what adaptation can do before size is traded away. Step 5 tries the same recipe on tiny and base, which the app runs today.
- Train on one speaker's training sentences and test on that speaker's held-out sentences (the sentence-disjoint split). Compare with the step 1 baseline on exactly the same test utterances.
- Published: WER before and after for that speaker, how much training audio was used, and how the result changes with less of it.
- Parked until after this step: using TORGO's articulatory recordings as an extra training signal. Prior work (Rudzicz and colleagues) is the place to start.

### Step 4. Repair with a language model and the person's phrase bank

Question: given the person's own phrase bank, does a language model fix misheard words, or does it invent new ones?

- The product already has this path. The optional server (`server/`, `POST api/correct`) sends the words on screen and the person's saved phrases to a language model (hosted Gemma, or any OpenAI-compatible server such as llama.cpp or Ollama running locally, though neither local option has been tried yet). A suggestion is shown beside the person's words and never applied or spoken on its own.
- The server refuses a suggestion that adds or removes a negation, changes a number, or changes more than 30% of the words. Known gaps, which this step should measure rather than assume: names, pronouns and tense are asked for in the prompt but not checked; one content word swapped for another within the limit passes ("water" to "warfarin"); ordinals above "third", "half" and "dozen" are not covered.
- Count both directions: errors fixed, and correct words changed into wrong ones. A repair step that fixes ten words and invents one is still dangerous in a device that speaks for someone.
- Each saved phrase records the model that heard it (id, revision, precision, device) and how it was recorded (format, bitrate, sample rate, voice processing). Only like-for-like pairs should be used, and the app only sends phrases recorded with the current model.
- Never pass the phrase bank to Whisper as `initial_prompt`. It is the obvious shortcut, and in v1 a prompt came back as part of the transcript while about 30 s of real speech went missing. Repair happens after transcription.

### Step 5. Shrink it for the phone

Question: how much of the accuracy survives on a real phone, and at what speed and memory cost?

- Model size: tiny, base and small against WER.
- Precision: q8, q4 and fp16 against WER, at the same model size.
- Runtimes: transformers.js on WebAssembly and WebGPU (what the app uses now), whisper.cpp, and ONNX Runtime.
- Measured on a named iPhone and a named mid-range Android phone: download size, load time, transcription time and memory. The app's "Show details" panel shows the model, revision, device, threads, model load time (including any download), inference time and press-to-Listening time. Memory needs measuring separately, with the browser's own tools. [`docs/PHONE_CHECKLIST.md`](../docs/PHONE_CHECKLIST.md) lists the manual checks.
- Also on the list: the capture format and bitrate (recorded with every phrase), browser voice processing on and off, raw PCM capture at the microphone's own rate, and whether WebGPU should become an automatic choice. So far it is opt-in: on the test laptop it was faster in the app's own test but not on a minimal test page, it downloads almost three times as much, and it has not been tried on a phone.

### Step 6. Ship it, with an honest write-up

- The installable web app with the chosen model as an option in Settings.
- A public write-up with per-speaker results, including the speakers it did not help and the approaches that did not work.

### Research, only if needed

- Continued pre-training on untranscribed speech, if fine-tuning plateaus. Untranscribed atypical speech is easier to collect than transcribed speech, and pre-training on it could adapt the model's audio side before any labelled fine-tuning.
- Voice banking, later: someone who expects to lose their voice records it while they can, and Vokal speaks in it. Not built.

## Evaluation rules

These apply to every step.

1. Splits are speaker-disjoint or sentence-disjoint, fixed before training, and published as lists of utterance ids.
2. WER is reported per speaker and per severity group, with the number of utterances behind it. An average over all speakers hides the people the product is for.
3. Single words and sentences are reported separately.
4. Every comparison uses the same test utterances, the same text normalisation (written down before scoring) and the same decoding settings. The stock model at the same precision is always shown beside a new result.
5. No tuning on the test set. Choices are made on a validation split.
6. What did not work is reported too.
7. Nothing claims Vokal works for dysarthric speech beyond what these numbers show, for these speakers, in these conditions.

The product's decoding settings are carried over from v1. The first three were found on real recordings: no `initial_prompt`, `vad_filter=False` (voice activity detection trims quiet speech), `condition_on_previous_text=False` (one invented segment cascades into the next). Greedy decoding (`beam_size=1`) was chosen in v1 without measuring. Whether beam search helps on atypical speech is an open question for step 5. The reasons are in [`docs/DECISIONS.md`](../docs/DECISIONS.md).

## Where a trained model plugs in

### In the web app

Settings, Speech model, Custom model takes one of:

- `owner/name` or `owner/name@revision`: a public model on huggingface.co. A branch or tag is resolved to a commit hash when the model downloads, so every file comes from one commit and a moving branch cannot change the weights between visits. Settings has Check for a newer version. Private models are not supported.
- `models/<name>`: a folder on your own computer, served by the local server with `node server/server.mjs --models <folder>`. The app loads it from `<base>models/<name>/`. This does not work on GitHub Pages, which has no model files.

The folder (or the Hub repo) needs the transformers.js layout:

```
config.json
generation_config.json
preprocessor_config.json
tokenizer.json
tokenizer_config.json
onnx/encoder_model<suffix>.onnx
onnx/decoder_model_merged<suffix>.onnx
```

The suffix is the precision: none for fp32, `_fp16`, `_quantized` for q8, `_q4` for q4. The app's default on WebAssembly is q8 for both files.

Not checked yet: loading a local folder through the app end to end, and a multilingual base model (such as one fine-tuned from `openai/whisper-small`). The app has code for both (a multilingual model gets the English transcribe prefix forced), but neither has been run in the browser. Check both before relying on them.

### In Python

`--model` (or `VOKAL_WHISPER_MODEL`) takes a faster-whisper size name such as `small.en`, or a local CTranslate2 folder holding `model.bin` and the tokenizer files. A missing folder, or one without `model.bin`, gives a one-line error. Only size names and that error have been tried so far; no converted fine-tuned model has been loaded yet.

## Exporting a fine-tuned model

Commands and steps only. Check each tool's own documentation for the version in use.

1. Merge the LoRA weights into the base model (PEFT's `merge_and_unload()`), and save the merged model and its `WhisperProcessor` to one folder.
2. For the app, export to ONNX:
   ```
   optimum-cli export onnx --model <merged folder> --task automatic-speech-recognition-with-past <onnx folder>
   ```
   Move the `.onnx` files into an `onnx/` subfolder, check the file names match the layout above, then quantise (q8, and optionally q4 or fp16) with the matching suffixes.
3. For Python, convert to CTranslate2:
   ```
   ct2-transformers-converter --model <merged folder> --output_dir <ct2 folder> --copy_files tokenizer.json preprocessor_config.json --quantization float16
   vokal transcribe clip.wav --model <ct2 folder> --compute-type int8
   ```
4. Before switching the app to it, compare its WER with the stock model at the same precision and on the same device.

Keep model folders outside the repository and outside OneDrive. OneDrive corrupts files it syncs while they are being written, and model files are large.

## Data rules

- No TORGO audio, transcripts or derived files in this repository. Recordings of real people stay out too: the only audio in the current files is synthetic test speech.
- Licence. The University of Toronto page says TORGO is free for academic (non-profit) use, and that any publication using it must cite at least one of the papers listed there. The write-up in step 6 counts. The Linguistic Data Consortium also distributes it (LDC2012S02) under the LDC User Agreement for Non-Members. Check the terms of the copy in use before publishing results, and before publishing any weights trained on it.
- Phrase banks belong to the person who recorded them. The app keeps them in the browser, as text only, and exports them only when the person chooses to.
