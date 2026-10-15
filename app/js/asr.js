// Main-thread client for the speech worker. One request is in flight at a time and
// the others wait in order. The worker module imports the error table from here, so
// both sides share one list of codes and messages.

export const ASR_MESSAGES = Object.freeze({
  UNSUPPORTED_BROWSER: 'This browser cannot run the speech model.',
  NOT_DOWNLOADED: 'The speech model is not on this device yet.',
  DOWNLOAD_INTERRUPTED: 'Download stopped. Tap Download to continue.',
  MODEL_NOT_FOUND: 'That speech model could not be found.',
  WEBGPU_UNAVAILABLE: 'WebGPU is not available on this device.',
  MODEL_LOAD_FAILED: 'The speech model could not start on this device.',
  NOT_LOADED: 'The speech model is not loaded.',
  BAD_AUDIO: 'This recording could not be used.',
  TRANSCRIBE_FAILED: 'Transcription failed.',
  WORKER_CRASHED: 'The speech model stopped working. Load it again.',
  TERMINATED: 'The speech model was stopped.',
  SUPERSEDED: 'A newer recording replaced this one.',
});

export function asrError(code) {
  return { code, message: ASR_MESSAGES[code] || ASR_MESSAGES.MODEL_LOAD_FAILED };
}

// The library's message for a file it was not allowed to fetch (transformers.js 4.3.0).
// A library upgrade must re-check this text.
const NOT_ALLOWED_REMOTE = 'env.allowRemoteModels=false';
const BODY_READ_FAILURE = /network|fetch|body|stream|load failed|aborted/i;
// Files every Whisper export needs. A 404 on an optional file says nothing about the model.
const REQUIRED_FILE = /\/(?:config\.json|preprocessor_config\.json|tokenizer\.json|[^/]+\.onnx)$/;

// Decides which error a failed load reports. failures lists the requests the worker
// saw fail during this load: { url, status } or { url, rejected: true }.
export function classifyLoadError({ error, source, download, failures = [] }) {
  const message = String((error && error.message) || error || '');
  const requiredFromHub = (failure) => {
    try {
      const url = new URL(failure.url);
      return url.hostname === 'huggingface.co' && REQUIRED_FILE.test(url.pathname);
    } catch {
      return false;
    }
  };
  const missingFromHub = source === 'hub' && failures.some((f) => (f.status === 401 || f.status === 404) && requiredFromHub(f));
  if (missingFromHub || (source === 'local' && message.includes(NOT_ALLOWED_REMOTE))) return 'MODEL_NOT_FOUND';
  const rejected = failures.some((f) => f.rejected);
  if (!download && (rejected || message.includes(NOT_ALLOWED_REMOTE))) return 'NOT_DOWNLOADED';
  const bodyReadFailed = error && error.name === 'TypeError' && BODY_READ_FAILURE.test(message);
  if (download && (rejected || bodyReadFailed)) return 'DOWNLOAD_INTERRUPTED';
  return 'MODEL_LOAD_FAILED';
}

export function createAsr({ workerUrl, WorkerImpl } = {}) {
  const url = workerUrl || new URL('./asr-worker.js', import.meta.url);
  const Impl = WorkerImpl || globalThis.Worker;
  let worker = null;
  let state = 'idle';
  let nextId = 1;
  let inFlight = null;
  const queue = [];

  function rejectAll(code) {
    const pending = inFlight ? [inFlight, ...queue] : [...queue];
    inFlight = null;
    queue.length = 0;
    for (const request of pending) request.reject(asrError(code));
  }

  function stopWorker(code) {
    rejectAll(code);
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  function onCrash(event) {
    if (event && event.preventDefault) event.preventDefault();
    stopWorker('WORKER_CRASHED');
    state = 'crashed';
  }

  function onMessage(event) {
    const message = event.data || {};
    if (!inFlight || message.id !== inFlight.id) return; // a reply for a request that was dropped
    if (message.type === 'progress' || message.type === 'progress-total') {
      if (inFlight.onProgress) inFlight.onProgress(message);
      return;
    }
    const request = inFlight;
    inFlight = null;
    if (message.type === 'error') {
      if (request.message.type === 'load') state = 'idle';
      request.reject({ code: message.code, message: message.message || asrError(message.code).message });
    } else {
      if (message.type === 'ready') state = 'ready';
      request.resolve(message);
    }
    sendNext();
  }

  function spawn() {
    worker = new Impl(url, { type: 'module' });
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onCrash);
    worker.addEventListener('messageerror', onCrash);
  }

  function sendNext() {
    if (inFlight || !queue.length || !worker) return;
    inFlight = queue.shift();
    const { message } = inFlight;
    if (message.type === 'transcribe') {
      // Send a copy and transfer the copy's buffer: the caller's array keeps its
      // length, so "Try again" can send it again.
      const audio = inFlight.audio.slice();
      worker.postMessage({ ...message, audio }, [audio.buffer]);
    } else {
      worker.postMessage(message);
    }
  }

  function enqueue(message, extra = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      queue.push({ id, message: { ...message, id }, resolve, reject, ...extra });
      sendNext();
    });
  }

  return {
    get state() {
      return state;
    },
    // Always a fresh worker: WASM memory never shrinks, so a model change gets a new one.
    load(spec, { download = false, onProgress } = {}) {
      stopWorker('TERMINATED');
      spawn();
      state = 'loading';
      return enqueue({ type: 'load', model: spec, download }, { onProgress });
    },
    // At most one transcription waits in the queue. A running inference cannot be
    // stopped short of terminating the worker, so a newer one replaces a queued one.
    transcribe(audio, { probe = true } = {}) {
      if (!worker || state !== 'ready') return Promise.reject(asrError('NOT_LOADED'));
      const queued = queue.findIndex((request) => request.message.type === 'transcribe');
      if (queued !== -1) {
        const [replaced] = queue.splice(queued, 1);
        replaced.reject(asrError('SUPERSEDED'));
      }
      return enqueue({ type: 'transcribe', sampleRate: 16000, probe }, { audio });
    },
    check(spec) {
      if (!worker) spawn();
      return enqueue({ type: 'check', model: spec });
    },
    forget(spec) {
      if (!worker) spawn();
      return enqueue({ type: 'forget', model: spec }).then(() => undefined);
    },
    terminate() {
      stopWorker('TERMINATED');
      state = 'idle';
    },
  };
}
