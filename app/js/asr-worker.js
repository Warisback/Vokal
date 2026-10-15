// Speech worker: runs Whisper through transformers.js, off the main thread.
// It returns the raw model text; the guard runs on the main thread, so one tested
// guard module serves every path. Messages never contain or log transcript text.

import { asrError, classifyLoadError } from './asr.js';

const LIB_URL = new URL('../vendor/transformers.min.js', import.meta.url);
const TASK = 'automatic-speech-recognition';
const SAMPLE_RATE = 16000;
const MAX_SAMPLES = 480000;
const PROGRESS_INTERVAL_MS = 100; // at most 10 progress messages per second per stream
// For a cache-only load of a Hub model the library must be allowed local files (4.3.0
// refuses a load with both local and remote turned off). Its local lookups go to this
// path, and the fetch wrapper answers them from Cache Storage, so nothing reaches the
// network.
const CACHE_ONLY_PATH = new URL('../models/.cache-only/', import.meta.url).pathname;

let lib = null;
let NoSpeechProbe = null;
let runtimeFiles = [];
let transcriber = null;
let failures = []; // requests that failed during the current load
let cacheOnly = null; // { id, revision } while a Hub model loads from the cache only

const post = (message) => self.postMessage(message);

function fail(id, code, error) {
  // Only an error name and the code: never transcript text or URLs with user data.
  if (error) console.warn(`vokal worker: ${code}`, error && error.name ? error.name : 'Error');
  post({ type: 'error', id, ...asrError(code) });
}

// Records failed requests so a failed load can say whether it was offline,
// interrupted or a missing model.
function recordingFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const pathname = new URL(url, self.location.href).pathname;
  if (cacheOnly && pathname.startsWith(CACHE_ONLY_PATH)) return fromCache(pathname);
  return fetch(input, init).then(
    (response) => {
      if (response.status >= 400) failures.push({ url, status: response.status });
      return response;
    },
    (error) => {
      failures.push({ url, rejected: true });
      throw error;
    },
  );
}

// Answers a cache-only lookup with the cached file of the pinned commit, or a 404.
// 4.3.0 checks preprocessor_config.json without the revision, so it would otherwise
// miss the cached file offline and build the pipeline without its feature extractor.
async function fromCache(pathname) {
  const { id, revision } = cacheOnly;
  const prefix = `${CACHE_ONLY_PATH}${id}/`;
  if (pathname.startsWith(prefix)) {
    const file = decodeURIComponent(pathname.slice(prefix.length));
    const folder = lib.env.remotePathTemplate.replaceAll('{model}', id).replaceAll('{revision}', encodeURIComponent(revision));
    const key = `${lib.env.remoteHost.replace(/\/+$/, '')}/${folder.replace(/^\/+|\/+$/g, '')}/${file}`;
    try {
      const cache = await caches.open(lib.env.cacheKey);
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      // No Cache Storage: treat as not cached.
    }
  }
  return new Response(null, { status: 404, statusText: 'Not in the cache' });
}

function defineProbe(LogitsProcessor) {
  // Reads Whisper's no-speech probability the way the original implementation does:
  // the softmax at the start-of-transcript position, taken at the no-speech token.
  // Generation starts from start-of-transcript only, so the first step is that position.
  // The probe then forces the prefix and re-applies suppress_tokens and
  // begin_suppress_tokens, so the text matches the plain pipeline (measured for .en
  // models). The multilingual prefix (<|en|>, transcribe, no timestamps) has not been
  // checked against the plain pipeline yet; the browser test for it is still to run.
  return class extends LogitsProcessor {
    constructor(config, multilingual) {
      super();
      const noTimestamps = config.no_timestamps_token_id;
      this.noSpeechToken = noTimestamps - 1;
      this.prefix = multilingual
        ? [config.lang_to_id['<|en|>'], config.task_to_id.transcribe, noTimestamps]
        : [noTimestamps];
      if (this.prefix.some((token) => typeof token !== 'number')) throw new Error('prefix tokens missing');
      this.suppress = config.suppress_tokens || [];
      this.beginSuppress = config.begin_suppress_tokens || [];
      this.noSpeechProb = null;
      this.logprobs = [];
    }

    _call(inputIds, logits) {
      for (let b = 0; b < inputIds.length; b++) {
        const scores = logits[b].data;
        const step = inputIds[b].length;
        if (step === 1) this.noSpeechProb = softmaxAt(scores, this.noSpeechToken);
        if (step <= this.prefix.length) {
          scores.fill(-Infinity);
          scores[this.prefix[step - 1]] = 0;
          continue;
        }
        for (const token of this.suppress) scores[token] = -Infinity;
        if (step === this.prefix.length + 1) {
          for (const token of this.beginSuppress) scores[token] = -Infinity;
        }
        this.logprobs.push(logProbOfBest(scores));
      }
      return logits;
    }
  };
}

function softmaxAt(scores, index) {
  let max = -Infinity;
  for (const value of scores) if (value > max) max = value;
  let sum = 0;
  for (const value of scores) sum += Math.exp(value - max);
  return Math.exp(scores[index] - max) / sum;
}

// Log probability of the greedy choice.
function logProbOfBest(scores) {
  let max = -Infinity;
  for (const value of scores) if (value > max) max = value;
  let sum = 0;
  for (const value of scores) if (value !== -Infinity) sum += Math.exp(value - max);
  return -Math.log(sum);
}

async function library() {
  if (lib) return lib;
  const imported = await import(LIB_URL.href);
  // Read the runtime paths now: the library later swaps the .mjs path for a blob: URL.
  const paths = imported.env.backends.onnx.wasm.wasmPaths;
  runtimeFiles = paths && typeof paths === 'object' ? [paths.wasm, paths.mjs].filter(Boolean) : [];
  imported.env.fetch = recordingFetch;
  NoSpeechProbe = defineProbe(imported.LogitsProcessor);
  lib = imported;
  return lib;
}

// The library looks in Cache Storage before anything else, so a cache-only load
// works offline.
function configure(env, spec, download) {
  cacheOnly = spec.source === 'hub' && !download ? { id: spec.id, revision: spec.revision } : null;
  if (spec.source === 'local') {
    env.allowLocalModels = true;
    env.localModelPath = spec.localPath;
    env.allowRemoteModels = false;
  } else if (download) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
  } else {
    env.allowLocalModels = true;
    env.localModelPath = CACHE_ONLY_PATH;
    env.allowRemoteModels = false;
  }
}

function progressReporter(id) {
  const lastByFile = new Map();
  let lastTotal = 0;
  return (info) => {
    const now = performance.now();
    if (info.status === 'progress') {
      const finished = info.loaded >= info.total;
      if (!finished && now - (lastByFile.get(info.file) || 0) < PROGRESS_INTERVAL_MS) return;
      lastByFile.set(info.file, now);
      post({ type: 'progress', id, file: info.file, loaded: info.loaded, total: info.total });
    } else if (info.status === 'progress_total') {
      const finished = info.loaded >= info.total;
      if (!finished && now - lastTotal < PROGRESS_INTERVAL_MS) return;
      lastTotal = now;
      post({ type: 'progress-total', id, loaded: info.loaded, total: info.total });
    }
  };
}

async function hasWebGpuAdapter() {
  try {
    return Boolean(self.navigator.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load({ id, model: spec, download }) {
  let transformers;
  try {
    transformers = await library();
  } catch (error) {
    fail(id, 'UNSUPPORTED_BROWSER', error);
    return;
  }
  if (spec.device === 'webgpu' && !(await hasWebGpuAdapter())) {
    fail(id, 'WEBGPU_UNAVAILABLE');
    return;
  }
  const { env, pipeline } = transformers;
  configure(env, spec, download);
  failures = [];
  const started = performance.now();
  try {
    transcriber = await pipeline(TASK, spec.id, {
      device: spec.device,
      dtype: libraryDtype(spec.dtype),
      revision: spec.revision,
      progress_callback: progressReporter(id),
    });
  } catch (error) {
    transcriber = null;
    const code = classifyLoadError({ error, source: spec.source, download, failures });
    fail(id, code, error);
    return;
  }
  post({
    type: 'ready',
    id,
    model: { key: spec.key, id: spec.id, revision: spec.revision },
    device: spec.device,
    dtype: spec.dtype,
    threads: env.backends.onnx.wasm.numThreads ?? null,
    loadMs: Math.round(performance.now() - started),
    libVersion: env.version,
    ortVersion: (env.backends.onnx.versions && env.backends.onnx.versions.web) || null,
    runtimeFiles,
  });
}

function isMultilingual() {
  return transcriber.model.generation_config.is_multilingual === true;
}

// .en models must not be given a language or task (the library throws).
async function plainText(audio) {
  const options = isMultilingual() ? { language: 'en', task: 'transcribe' } : {};
  const output = await transcriber(audio, options);
  return output.text;
}

async function probedText(audio) {
  const config = transcriber.model.generation_config;
  const probe = new NoSpeechProbe(config, isMultilingual());
  const processors = new lib.LogitsProcessorList();
  processors.push(probe);
  const output = await transcriber(audio, {
    decoder_input_ids: [config.decoder_start_token_id],
    suppress_tokens: null,
    begin_suppress_tokens: null,
    logits_processor: processors,
  });
  const steps = probe.logprobs.length;
  return {
    text: output.text,
    noSpeechProb: typeof probe.noSpeechProb === 'number' ? probe.noSpeechProb : null,
    avgLogprob: steps ? probe.logprobs.reduce((a, b) => a + b, 0) / steps : null,
    tokens: steps,
  };
}

async function transcribe({ id, audio, sampleRate, probe }) {
  if (!transcriber) {
    fail(id, 'NOT_LOADED');
    return;
  }
  if (!(audio instanceof Float32Array) || sampleRate !== SAMPLE_RATE || audio.length === 0 || audio.length > MAX_SAMPLES) {
    fail(id, 'BAD_AUDIO');
    return;
  }
  const started = performance.now();
  try {
    let result = null;
    if (probe) {
      try {
        result = await probedText(audio);
      } catch (error) {
        // A library change can break the probe. The guard then has its text rules only.
        console.warn('vokal worker: no-speech probe failed', error && error.name ? error.name : 'Error');
      }
    }
    if (!result) result = { text: await plainText(audio), noSpeechProb: null, avgLogprob: null, tokens: null };
    post({
      type: 'result',
      id,
      ...result,
      inferMs: Math.round(performance.now() - started),
      audioS: audio.length / SAMPLE_RATE,
    });
  } catch (error) {
    fail(id, 'TRANSCRIBE_FAILED', error);
  }
}

// 4.3.0 loads a session with the precision named by its file ("encoder_model"), but
// lists a model's files (cache check, remove, download total) with the precision named
// by its session ("model" for the encoder), and without a device it assumes WASM.
// Given only { encoder_model, decoder_model_merged } and no device, the list for
// tiny.en on WebGPU named encoder_model_quantized.onnx instead of the fp32 encoder that
// was downloaded: the model showed as missing on every visit, and Remove would have
// left the encoder behind. Naming the encoder both ways, and passing the device, keeps
// the list and the load in step.
function libraryDtype(dtype) {
  return { model: dtype.encoder_model, ...dtype };
}

function cacheOptions(spec) {
  return { device: spec.device, dtype: libraryDtype(spec.dtype), revision: spec.revision };
}

async function runtimeCached() {
  try {
    const cache = await caches.open('transformers-cache');
    if (!runtimeFiles.length) return false;
    const hits = await Promise.all(runtimeFiles.map((url) => cache.match(url)));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

async function check({ id, model: spec }) {
  let transformers;
  try {
    transformers = await library();
  } catch (error) {
    fail(id, 'UNSUPPORTED_BROWSER', error);
    return;
  }
  configure(transformers.env, spec, false);
  let model = false;
  try {
    model = await transformers.ModelRegistry.is_pipeline_cached(TASK, spec.id, cacheOptions(spec));
  } catch {
    model = false;
  }
  post({ type: 'checked', id, model: model === true, runtime: await runtimeCached() });
}

async function forget({ id, model: spec }) {
  let transformers;
  try {
    transformers = await library();
  } catch (error) {
    fail(id, 'UNSUPPORTED_BROWSER', error);
    return;
  }
  configure(transformers.env, spec, false);
  try {
    // Model files only. The runtime files serve every model, so they stay.
    await transformers.ModelRegistry.clear_pipeline_cache(TASK, spec.id, cacheOptions(spec));
  } catch (error) {
    console.warn('vokal worker: could not clear the model cache', error && error.name ? error.name : 'Error');
  }
  post({ type: 'forgotten', id });
}

const handlers = { load, transcribe, check, forget };

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  const handler = handlers[message.type];
  if (!handler) return;
  try {
    await handler(message);
  } catch (error) {
    fail(message.id, message.type === 'transcribe' ? 'TRANSCRIBE_FAILED' : 'MODEL_LOAD_FAILED', error);
  }
});
