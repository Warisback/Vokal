// Vokal controller: boot, screens, the talk flow, review, and the settings dialog.
// Flow: press, record, decode to 16 kHz, pre-check, transcribe on the device, guard,
// review. Nothing is spoken except inside a tap on Speak.

import { emptyOutcome, guardUtterance, levelDbfs, preCheck, tidy } from './guard.js';
import { approxDownloadMb, modelSpec, parseCustomModel, resolveRevision, sameSpec } from './models.js';
import * as store from './settings.js';
import { createAsr } from './asr.js';
import * as audio from './audio.js';
import { createSpeech, voiceLabel } from './speech.js';
import { createCorrector } from './correct.js';
import { createOnboarding } from './onboarding.js';

export const APP_VERSION = '2.0.0';

const byId = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const asrSupported = document.documentElement.dataset.asr !== 'off';

const STATUS = {
  ready: 'Ready',
  starting: 'Starting',
  listening: 'Listening',
  working: 'Working',
  review: 'Check the words',
  speaking: 'Speaking',
  missing: 'Speech model not downloaded',
  checking: 'Checking for the speech model',
  loading: 'Loading the speech model',
  downloading: 'Downloading the speech model',
  error: 'Something went wrong',
  unsupported: 'Type to speak',
};

const TAKE_MESSAGES = {
  RELEASED_EARLY: 'Hold the button until it says Listening.',
  EMPTY: 'Nothing was recorded. Try again.',
  RECORDER_FAILED: 'Recording could not start in this browser. You can type instead.',
  MIC_BLOCKED: 'Vokal cannot use the microphone. Allow it in the browser settings, or type instead.',
  NO_MIC: 'No microphone was found. Connect one, or type instead.',
  MIC_BUSY: 'The microphone is in use by another app. Close it and try again, or type instead.',
  MIC_FAILED: 'The microphone could not start. Try again, or type instead.',
};

const PRECHECK_MESSAGES = {
  too_short: "Didn't catch that. Try again, or type.",
  too_quiet: "Didn't catch that. Try again, or type.",
  no_signal: 'No sound reached Vokal. Check the microphone is not muted or in use by another app.',
};

const REMOVED_REASONS = {
  no_words: 'no words in it',
  annotation: 'a sound note, not speech',
  credit_line: 'a subtitle credit the model often invents',
  filler: 'a phrase the model often invents at the end',
  no_speech: 'the model scored the recording as probably not speech',
};

const DIDNT_CATCH = "Didn't catch that. Try again, or type.";

// --- storage ---

function browserStorage() {
  try {
    const storage = window.localStorage;
    storage.getItem(store.KEYS.settings);
    return storage;
  } catch {
    return null;
  }
}

const storage = browserStorage();
const loadedSettings = store.loadSettings(storage);
const loadedPhrases = store.loadPhrases(storage);
let settings = loadedSettings.settings;
let phrases = loadedPhrases.items;

function noteStorageFailure() {
  byId('storage-notice').hidden = false;
}

function saveSettings(changes) {
  settings = store.validateSettings({ ...settings, ...changes });
  if (!store.saveSettings(storage, settings)) noteStorageFailure();
}

function savePhrases(items) {
  phrases = items;
  if (!store.savePhrases(storage, phrases)) noteStorageFailure();
  renderPhrases();
}

// --- services ---

const asr = createAsr();
const speech = createSpeech();
const corrector = createCorrector();
const contextHolder = audio.createAudioContextHolder({ disabled: reducedMotion });

const state = {
  screen: null,
  requestId: 0,
  micReady: false,
  skipTypes: new Set(), // recorder MIME types that failed to decode this session
  last: null, // the latest transcription, for "What was heard" and "Use it anyway"
  lastAudio: null, // kept in memory only, so "Try again" needs no new recording
  chip: null,
  suggestion: null,
  recents: [],
  shellComplete: false,
  persisted: null,
  updateRequested: false,
};

// --- announcer: one polite live region, silent while the microphone is open ---

const announcer = (() => {
  const region = byId('announcer');
  let held = false;
  let timer = 0;
  return {
    say(text) {
      if (held || !text) return;
      clearTimeout(timer);
      region.textContent = '';
      timer = setTimeout(() => {
        region.textContent = text;
      }, 60);
    },
    // Screen readers would speak an announcement into the recording.
    hold() {
      held = true;
      clearTimeout(timer);
    },
    release() {
      held = false;
    },
  };
})();

function setStatus(kind, text = STATUS[kind]) {
  byId('status-dot').dataset.state = kind;
  byId('status-text').textContent = text;
}

// --- screens ---

function showScreen(name) {
  for (const screen of ['welcome', 'setup', 'talk']) byId(`screen-${screen}`).hidden = screen !== name;
  state.screen = name;
  byId(`${name}-title`).focus();
}

// --- speech model ---

const model = {
  spec: null,
  status: 'checking', // unsupported, invalid, checking, missing, downloading, loading, ready, error, paused
  check: null,
  ready: null,
  error: null,
  progress: null,
  note: '',
  offer: null, // { spec, mb } while asking before a WASM download after WebGPU failed
};
const modelListeners = new Set();
let modelToken = 0;

function currentSpec(overrides = {}) {
  return modelSpec({ ...settings, ...overrides }, { appBaseUrl: document.baseURI });
}

function setModel(changes) {
  Object.assign(model, changes);
  renderModel();
  for (const listener of modelListeners) listener(model);
}

function modelIdentity() {
  if (model.status !== 'ready' || !model.ready) return null;
  const { ready } = model;
  return { id: ready.model.id, revision: ready.model.revision, dtype: ready.dtype, device: ready.device };
}

async function refreshModel() {
  if (!asrSupported) {
    setModel({ status: 'unsupported' });
    return;
  }
  const spec = currentSpec();
  const busy = ['ready', 'checking', 'loading', 'downloading'].includes(model.status);
  if (busy && sameSpec(model.spec, spec)) return;
  const token = ++modelToken;
  // A different model is wanted: stop the current worker, and any download in it.
  if (busy) asr.terminate();
  if (spec.error) {
    setModel({ spec, status: spec.error === 'INVALID_CUSTOM' ? 'invalid' : 'missing', check: null, ready: null, error: null, note: '', offer: null });
    return;
  }
  setModel({ spec, status: 'checking', check: null, ready: null, error: null, note: '', offer: null });
  let check;
  try {
    check = await asr.check(spec);
  } catch (error) {
    if (token === modelToken) setModel({ status: 'error', error });
    return;
  }
  if (token !== modelToken) return;
  if (check.model && check.runtime) await loadModel(spec, { download: false, check });
  else setModel({ status: 'missing', check });
}

async function loadModel(spec, { download, check = model.check }) {
  const token = ++modelToken;
  store.writeLoading(storage, spec);
  setModel({ spec, status: download ? 'downloading' : 'loading', progress: null, error: null, check, note: '', offer: null });
  try {
    const ready = await asr.load(spec, {
      download,
      onProgress: (message) => {
        if (message.type === 'progress-total' && token === modelToken) {
          setModel({ progress: { loaded: message.loaded, total: message.total } });
        }
      },
    });
    store.clearLoading(storage);
    if (token !== modelToken) return null;
    setModel({ status: 'ready', ready, progress: null });
    return ready;
  } catch (error) {
    // A crashed worker leaves the marker, as a crashed tab would.
    if (error.code !== 'WORKER_CRASHED' && error.code !== 'TERMINATED') store.clearLoading(storage);
    if (token === modelToken && error.code !== 'TERMINATED') setModel({ status: 'error', error, progress: null });
    return null;
  }
}

function requestPersistence() {
  try {
    navigator.storage.persist().then((persisted) => {
      state.persisted = persisted;
    }, () => {});
  } catch {
    // Not supported here.
  }
}

async function requestWakeLock() {
  try {
    return await navigator.wakeLock.request('screen');
  } catch {
    return null;
  }
}

async function resolveCustom() {
  const parsed = parseCustomModel(settings.customModel);
  if (parsed.error || parsed.source !== 'hub') return currentSpec();
  setModel({ status: 'checking', error: null });
  const resolved = await resolveRevision(parsed.id, parsed.ref);
  if (resolved.error) {
    const error = resolved.error === 'MODEL_NOT_FOUND'
      ? { code: 'MODEL_NOT_FOUND', message: 'That model could not be found. Only public models on huggingface.co are supported.' }
      : { code: 'NETWORK', message: 'Could not reach huggingface.co. Check the connection and try again.' };
    setModel({ status: 'error', error });
    return null;
  }
  saveSettings({ customResolved: { id: parsed.id, ref: parsed.ref, sha: resolved.sha, at: new Date().toISOString() } });
  return currentSpec();
}

// Only ever called from a tap: phone data costs money.
async function downloadModel(spec = currentSpec()) {
  if (!asrSupported) return;
  // Asked inside the tap, before anything is awaited.
  requestPersistence();
  const lock = requestWakeLock();
  if (spec.error === 'NOT_RESOLVED') spec = await resolveCustom();
  if (!spec || spec.error) {
    (await lock)?.release().catch(() => {});
    return;
  }
  const ready = await loadModel(spec, { download: true });
  (await lock)?.release().catch(() => {});
  if (!ready) return;
  // The library only logs a failed cache write (for example a full quota), so check.
  let check = null;
  try {
    check = await asr.check(spec);
  } catch {
    check = null;
  }
  const kept = check && check.model && check.runtime;
  setModel({ check, note: kept ? '' : 'This browser did not keep the model. It will download again next time.' });
  refreshStorage();
}

async function forgetModel() {
  const spec = model.spec;
  if (!spec || spec.error) return;
  modelToken++;
  try {
    await asr.forget(spec);
  } catch {
    // The status check below tells the truth either way.
  }
  asr.terminate();
  setModel({ status: 'checking', ready: null });
  await refreshModel();
  refreshStorage();
  announcer.say('The speech model was removed from this device.');
}

// WebGPU failed: offer WASM, checking the cache first and asking before any download.
async function offerWasm() {
  const spec = currentSpec({ device: 'wasm' });
  if (spec.error) return;
  let check = { model: false, runtime: false };
  try {
    check = await asr.check(spec);
  } catch {
    // Treat as not cached.
  }
  if (check.model && check.runtime) {
    announcer.say('Already on this device.');
    const ready = await loadModel(spec, { download: false, check });
    if (ready) saveSettings({ device: 'wasm' });
    return;
  }
  setModel({ offer: { spec, mb: approxDownloadMb(spec) } });
}

async function acceptWasmOffer() {
  if (!model.offer) return;
  const { spec } = model.offer;
  requestPersistence();
  const ready = await loadModel(spec, { download: true });
  if (ready) saveSettings({ device: 'wasm' });
}

function megabytes(bytes) {
  return Math.round(bytes / 1000000);
}

// Progress for every progress bar on the page. The total is never less than the
// known download size, because the library only learns file sizes as it goes.
function progressInfo() {
  const active = model.status === 'downloading' || model.status === 'loading';
  if (!active) return { active, value: null, text: '' };
  if (model.status === 'loading') return { active, value: null, text: 'Loading from this device' };
  const approx = approxDownloadMb(model.spec);
  const loaded = model.progress ? model.progress.loaded : 0;
  const total = Math.max(model.progress ? model.progress.total : 0, approx ? approx * 1000000 : 0);
  if (!total) return { active, value: null, text: `${megabytes(loaded)} MB so far` };
  return { active, value: Math.min(1, loaded / total), text: `${megabytes(loaded)} of ${megabytes(total)} MB` };
}

function renderProgress(block, bar, label) {
  const { active, value, text } = progressInfo();
  block.hidden = !active;
  if (!active) return;
  if (value === null) bar.removeAttribute('value');
  else bar.value = value;
  label.textContent = text;
}

function modelMessage() {
  const spec = model.spec;
  const approx = approxDownloadMb(spec);
  switch (model.status) {
    case 'invalid':
      return 'The custom model name is not valid. Check it in Settings.';
    case 'checking':
      return 'Checking for the speech model.';
    case 'paused':
      return 'Choose how to load the speech model above.';
    case 'missing':
      if (!spec || spec.error === 'NOT_RESOLVED') return 'Tap Download to fetch this model.';
      if (spec.source === 'local') return 'Tap Download to load this model from the Vokal server.';
      if (!navigator.onLine && approx) return `The speech model is not on this device yet. Connect once to download it (about ${Math.round(approx)} MB).`;
      return approx
        ? `The speech model is not on this device yet. Download it once: about ${approx} MB, plus the speech runtime the first time.`
        : 'The speech model is not on this device yet. Download it once.';
    case 'downloading':
      return 'Downloading the speech model. Keep this page open.';
    case 'loading':
      return 'Loading the speech model.';
    case 'error':
      if (model.offer) return model.offer.mb ? `This downloads about ${model.offer.mb} MB. Download now?` : 'This needs a download. Download now?';
      return model.error ? model.error.message : 'The speech model could not start on this device.';
    case 'ready':
      return model.note;
    default:
      return '';
  }
}

// True while the latest recording, file or retry is being transcribed. A request that
// a newer one replaced does not count.
function working() {
  return talk.busy && talk.busyId === state.requestId;
}

// The status line when nothing new has started. Late events, such as speech ending or
// a model update, call this too, so it must not replace Starting or Listening (the
// record control owns those) or Working.
function idleStatus() {
  if ([...recordControls].some((control) => control.recording)) return undefined;
  if (working()) return setStatus('working');
  if (!byId('speech-panel').hidden) return setStatus('speaking');
  if (!byId('review-panel').hidden) return setStatus('review');
  const map = { ready: 'ready', missing: 'missing', invalid: 'missing', checking: 'checking', loading: 'loading', downloading: 'downloading', error: 'error', paused: 'missing', unsupported: 'unsupported' };
  const kind = map[model.status] || 'checking';
  setStatus(kind, kind === 'error' && model.error ? model.error.message : STATUS[kind]);
}

function renderModel() {
  const ready = model.status === 'ready';
  const message = modelMessage();
  byId('model-panel').hidden = !asrSupported || (ready && !message);
  byId('model-message').textContent = message;
  const canDownload = model.status === 'missing' ||
    (model.status === 'error' && ['DOWNLOAD_INTERRUPTED', 'NOT_DOWNLOADED', 'NETWORK', 'MODEL_LOAD_FAILED', 'WORKER_CRASHED'].includes(model.error && model.error.code));
  const download = byId('model-download');
  download.hidden = !canDownload || Boolean(model.offer);
  download.textContent = model.status === 'error' && model.error && model.error.code === 'WORKER_CRASHED' ? 'Load again' : 'Download';
  const webgpuFailed = model.status === 'error' && settings.device === 'webgpu' && model.error &&
    ['WEBGPU_UNAVAILABLE', 'MODEL_LOAD_FAILED'].includes(model.error.code);
  byId('model-fallback').hidden = !webgpuFailed;
  byId('model-use-wasm').hidden = Boolean(model.offer);
  byId('model-fallback-download').hidden = !model.offer;
  renderProgress(byId('model-progress-block'), byId('model-progress'), byId('model-progress-text'));
  for (const control of recordControls) control.setEnabled(ready);
  idleStatus();
  renderModelSettings();
}

// --- record control, shared by the talk screen and setup ---

const recordControls = new Set();

function createRecordControl({ button, label, timer, cancel, canvas, onStart, onListening, onTake, onMessage }) {
  const meter = audio.createMeter({ canvas, holder: contextHolder });
  let take = null;
  let ticker = 0;
  let autoStop = 0;
  let stoppedAt30 = false;
  let keyHeld = false;
  let enabled = false;
  const tapMode = () => settings.captureMode === 'tap';
  const idleLabel = () => (tapMode() ? 'Tap to talk' : 'Hold to talk');

  function reset() {
    clearInterval(ticker);
    clearTimeout(autoStop);
    button.setAttribute('aria-pressed', 'false');
    button.dataset.state = 'idle';
    label.textContent = idleLabel();
    timer.hidden = true;
    if (cancel) cancel.hidden = true;
  }

  async function turnMicrophoneOn() {
    label.textContent = 'Turning the microphone on';
    const code = await audio.warmMicrophone({ processing: settings.micProcessing });
    label.textContent = idleLabel();
    if (code) {
      onMessage(TAKE_MESSAGES[code], 'error');
      return;
    }
    state.micReady = true;
    onMessage(tapMode() ? 'Microphone on. Now tap to talk.' : 'Microphone on. Now hold to talk.', 'info');
  }

  function startTimer() {
    const began = performance.now();
    timer.hidden = false;
    timer.textContent = '0:00 / 0:30';
    ticker = setInterval(() => {
      const seconds = Math.min(audio.MAX_SECONDS, Math.floor((performance.now() - began) / 1000));
      timer.textContent = `0:${String(seconds).padStart(2, '0')} / 0:30`;
    }, 250);
    autoStop = setTimeout(() => {
      stoppedAt30 = true;
      stop();
    }, audio.MAX_SECONDS * 1000);
  }

  function finish(outcome) {
    take = null;
    meter.detach();
    reset();
    // Every track has stopped by now, so announcing is safe again.
    announcer.release();
    if (outcome.cancelled) {
      onMessage('Recording discarded.', 'info');
      return;
    }
    if (outcome.error) {
      if (outcome.error === 'MIC_BLOCKED') state.micReady = false;
      onMessage(TAKE_MESSAGES[outcome.error] || TAKE_MESSAGES.MIC_FAILED, 'error');
      return;
    }
    announcer.say(stoppedAt30 ? 'Stopped at 30 seconds' : 'Working');
    onTake(outcome);
  }

  function start() {
    if (take || !enabled) return;
    if (!state.micReady) {
      turnMicrophoneOn();
      return;
    }
    speech.stop();
    announcer.hold();
    // The label changes before getUserMedia, so a screen reader hears it before the
    // microphone opens, not during the recording.
    button.setAttribute('aria-pressed', 'true');
    button.dataset.state = 'starting';
    label.textContent = tapMode() ? 'Recording. Tap to stop' : 'Recording. Release to stop';
    stoppedAt30 = false;
    if (onStart) onStart();
    take = audio.startTake({
      processing: settings.micProcessing,
      skip: state.skipTypes,
      onStreamReady: (stream) => meter.attach(stream),
      onListening: (info) => {
        button.dataset.state = 'listening';
        startTimer();
        if (onListening) onListening(info);
      },
      onEnd: finish,
    });
    if (cancel && tapMode()) cancel.hidden = false;
  }

  function stop() {
    if (take) take.stop();
  }

  function discard() {
    if (take) take.cancel();
  }

  button.addEventListener('pointerdown', (event) => {
    if (tapMode() || event.button !== 0) return;
    event.preventDefault();
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; release still arrives without it.
    }
    start();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, () => {
      if (!tapMode()) stop();
    });
  }
  button.addEventListener('click', () => {
    if (!tapMode()) return;
    if (take) stop();
    else start();
  });
  button.addEventListener('keydown', (event) => {
    if (tapMode() || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    if (event.repeat || keyHeld) return;
    keyHeld = true;
    start();
  });
  button.addEventListener('keyup', (event) => {
    if (tapMode() || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    keyHeld = false;
    stop();
  });
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  if (cancel) cancel.addEventListener('click', discard);

  const control = {
    reset,
    discard,
    setEnabled(value) {
      enabled = value;
      button.disabled = !value;
      if (!take) reset();
    },
    get recording() {
      return Boolean(take);
    },
  };
  recordControls.add(control);
  reset();
  return control;
}

// --- shared processing: decode, pre-check, transcribe, guard ---

async function decodeRecording(recording) {
  try {
    const decoded = await audio.decodeTo16k(await recording.blob.arrayBuffer());
    return {
      samples: audio.clipSamples(decoded.samples),
      capture: {
        source: 'mic',
        mimeType: recording.mimeType,
        bitsPerSecond: recording.bitsPerSecond,
        nativeRate: recording.nativeRate,
        processing: recording.processing,
        resampler: decoded.resampler,
      },
    };
  } catch {
    // Try the next recorder type on the next press.
    if (recording.mimeType) state.skipTypes.add(recording.mimeType);
    return { error: 'This recording could not be read on this browser.' };
  }
}

async function transcribeSamples(samples) {
  const durationS = samples.length / audio.TARGET_RATE;
  const level = levelDbfs(samples, audio.TARGET_RATE);
  const blocked = preCheck({ durationS, levelDbfs: level });
  if (blocked) return { kind: 'precheck', code: blocked, level, durationS };
  let result;
  try {
    result = await asr.transcribe(samples);
  } catch (error) {
    return { kind: 'error', error };
  }
  const guarded = guardUtterance({ text: result.text, noSpeechProb: result.noSpeechProb });
  return { kind: 'result', raw: result.text, guarded, outcome: emptyOutcome(guarded, result.noSpeechProb), result, level, durationS };
}

// --- talk screen ---

const talk = {
  busy: false,
  busyId: 0, // the requestId that set busy
  pressToListeningMs: null,
};

function startWork(id) {
  talk.busy = true;
  talk.busyId = id;
  setStatus('working');
}

function hidePanels() {
  for (const id of ['error-panel', 'confirm-panel', 'speech-panel']) byId(id).hidden = true;
}

function showError(message, { retry = false, useAnyway = false } = {}) {
  talk.busy = false;
  byId('error-panel').hidden = false;
  byId('error-message').textContent = message;
  byId('error-retry').hidden = !retry;
  byId('error-use-anyway').hidden = !useAnyway;
  idleStatus();
  announcer.say(message);
}

// The hint under the record button. A message (as opposed to the standing instruction)
// stays visible on a phone while words are in review; the instruction is hidden then.
function setHint(text, { message = false } = {}) {
  const hint = byId('record-hint');
  hint.textContent = text;
  hint.classList.toggle('hint-message', message);
}

function talkMessage(message, kind) {
  if (kind === 'error') {
    showError(message);
  } else {
    byId('error-panel').hidden = true;
    setHint(message, { message: true });
    announcer.say(message);
    idleStatus();
  }
}

function removedSummary(removed) {
  return removed.map((entry) => `"${entry.text}", ${REMOVED_REASONS[entry.rule] || entry.rule}`).join('; ');
}

function fact(list, name, value) {
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = name;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.append(dt, dd);
  list.append(wrap);
}

function renderHeard() {
  const details = byId('heard-details');
  const last = state.last;
  details.hidden = !last;
  if (!last) return;
  const raw = tidy(last.raw);
  byId('heard-raw').textContent = raw ? `"${raw}"` : 'The model returned no words.';
  const list = byId('heard-removed');
  list.replaceChildren();
  for (const entry of last.guarded.removed) {
    const item = document.createElement('li');
    item.textContent = `Removed "${entry.text}": ${REMOVED_REASONS[entry.rule] || entry.rule}.`;
    list.append(item);
  }
  byId('heard-use-anyway').hidden = !(raw && last.guarded.removed.length);
  const facts = byId('heard-facts');
  facts.replaceChildren();
  facts.hidden = !settings.showDetails;
  if (!settings.showDetails) return;
  const { result, capture } = last;
  const ready = model.ready;
  if (ready) {
    fact(facts, 'Model', ready.model.id);
    fact(facts, 'Revision', ready.model.revision.slice(0, 12));
    fact(facts, 'Device', `${ready.device}, ${ready.dtype.encoder_model} encoder, ${ready.dtype.decoder_model_merged} decoder`);
    fact(facts, 'Threads', String(ready.threads ?? 'unknown'));
    if (typeof ready.loadMs === 'number') fact(facts, 'Model load (includes any download)', `${ready.loadMs} ms`);
  }
  if (last.pressToListeningMs !== null && last.pressToListeningMs !== undefined) {
    fact(facts, 'Press to Listening', `${last.pressToListeningMs} ms`);
  }
  fact(facts, 'Inference', `${result.inferMs} ms for ${result.audioS.toFixed(2)} s of audio`);
  fact(facts, 'No-speech score', typeof result.noSpeechProb === 'number' ? result.noSpeechProb.toFixed(4) : 'No-speech score unavailable');
  if (typeof result.avgLogprob === 'number') fact(facts, 'Average log probability', result.avgLogprob.toFixed(3));
  fact(facts, 'Loudest 30 ms', `${last.level.toFixed(1)} dBFS`);
  fact(facts, 'Source', capture.source === 'mic' ? 'Microphone' : 'File');
  fact(facts, 'MIME type', capture.mimeType || 'browser default');
  fact(facts, 'Bitrate', capture.bitsPerSecond ? `${Math.round(capture.bitsPerSecond / 1000)} kbps` : 'unknown');
  fact(facts, 'Native rate', capture.nativeRate ? `${capture.nativeRate} Hz` : 'unknown');
  if (capture.source === 'mic') fact(facts, 'Voice processing', capture.processing ? 'on' : 'off');
  fact(facts, 'Resampler', capture.resampler);
}

function hideSuggestion() {
  byId('suggestion').hidden = true;
  byId('suggestion-note').hidden = true;
}

function showReview(text, { chip = null, announce = true } = {}) {
  talk.busy = false;
  hidePanels();
  hideSuggestion();
  byId('review-panel').hidden = false;
  byId('review-text').value = text;
  state.chip = chip;
  byId('removed-chip').hidden = !chip;
  if (chip) byId('removed-chip-text').textContent = `Removed at the end: ${chip}`;
  setStatus('review');
  if (announce) announcer.say(`Ready to speak: ${text}`);
  // Focus Speak rather than the text box, so the phone keyboard stays closed.
  (speech.available ? byId('speak-button') : byId('show-button')).focus();
}

function hideReview() {
  byId('review-panel').hidden = true;
  byId('review-text').value = '';
  state.chip = null;
  hideSuggestion();
}

async function runTalk({ samples, capture }) {
  const id = ++state.requestId;
  state.lastAudio = { samples, capture };
  startWork(id);
  const out = await transcribeSamples(samples);
  if (id !== state.requestId) return;
  talk.busy = false;
  if (out.kind === 'precheck') {
    showError(PRECHECK_MESSAGES[out.code]);
    return;
  }
  if (out.kind === 'error') {
    if (out.error.code !== 'SUPERSEDED') showError(out.error.message, { retry: true });
    return;
  }
  state.last = { ...out, capture, pressToListeningMs: capture.source === 'mic' ? talk.pressToListeningMs : null };
  renderHeard();
  const { guarded } = out;
  if (guarded.text) {
    const filler = guarded.removed.filter((entry) => entry.rule === 'filler').map((entry) => entry.text);
    showReview(guarded.text, { chip: filler.length ? filler.join(' ') : null });
    announceRemoved(id, guarded.removed);
    suggest(id, guarded.text);
    return;
  }
  hideReview();
  if (out.outcome === 'confirm') {
    talk.busy = false;
    byId('confirm-panel').hidden = false;
    byId('confirm-question').textContent = `Did you say \u201c${tidy(out.raw)}\u201d?`;
    idleStatus();
    announcer.say(byId('confirm-question').textContent);
    byId('confirm-yes').focus();
    return;
  }
  showError(DIDNT_CATCH, { useAnyway: out.outcome === 'offer' });
  announceRemoved(id, guarded.removed);
}

// After the main announcement, say what the guard removed, unless the person moved on.
function announceRemoved(id, removed) {
  if (!removed.length) return;
  setTimeout(() => {
    if (id === state.requestId) announcer.say(`Removed: ${removedSummary(removed)}`);
  }, 1500);
}

// "Use it anyway" and "Yes, use it" put the tidied raw text in review. They never speak.
function useRawText() {
  if (!state.last) return;
  const raw = tidy(state.last.raw);
  if (!raw) return;
  state.requestId++;
  showReview(raw);
}

async function onTalkTake(recording) {
  const pressId = state.requestId;
  startWork(pressId);
  const decoded = await decodeRecording(recording);
  if (pressId !== state.requestId) return;
  if (decoded.error) {
    showError(decoded.error);
    return;
  }
  await runTalk(decoded);
}

async function onFileChosen(file) {
  const input = byId('file-input');
  const id = ++state.requestId;
  hidePanels();
  startWork(id);
  announcer.say('Reading the file');
  const fail = (message) => {
    input.value = '';
    if (id === state.requestId) showError(message);
  };
  if (file.size > audio.MAX_FILE_BYTES) return fail(audio.FILE_MESSAGES.TOO_BIG);
  const buffer = await file.arrayBuffer();
  const info = audio.wavInfo(buffer);
  const durationS = info ? info.durationS : await audio.readMediaDuration(file);
  const problem = audio.checkFile({ sizeBytes: file.size, durationS });
  if (problem) return fail(audio.FILE_MESSAGES[problem]);
  let decoded;
  try {
    decoded = await audio.decodeTo16k(buffer);
  } catch {
    return fail('This file could not be read on this browser.');
  }
  if (audio.checkDecodedLength(decoded.samples)) return fail(audio.FILE_MESSAGES.TOO_LONG);
  input.value = '';
  if (id !== state.requestId) return;
  await runTalk({
    samples: audio.clipSamples(decoded.samples),
    capture: { source: 'file', mimeType: file.type || '', bitsPerSecond: null, nativeRate: info ? info.rate : null, processing: null, resampler: decoded.resampler },
  });
}

// --- suggestions (optional, off unless a server is set) ---

async function suggest(id, sentText) {
  const endpoints = store.correctionEndpoints(settings.correctionServer, document.baseURI);
  const identity = modelIdentity();
  if (!endpoints || !identity || corrector.stopped) return;
  const note = byId('suggestion-note');
  note.hidden = false;
  note.textContent = 'Asking the suggestion server. You can speak now.';
  const reply = await corrector.suggest({
    text: sentText,
    phrases: store.phrasesForModel(phrases, identity),
    endpoint: endpoints.correct,
    key: settings.correctionKey,
  });
  // Drop a late reply: the person has moved on or changed the words.
  if (id !== state.requestId || byId('review-text').value !== sentText) {
    note.hidden = true;
    return;
  }
  if (reply.error) {
    note.textContent = reply.error.message;
    return;
  }
  if (reply.degraded || !reply.changed || reply.suggested === sentText) {
    note.hidden = !(settings.showDetails && reply.note);
    note.textContent = reply.note;
    return;
  }
  note.hidden = !settings.showDetails;
  note.textContent = reply.note;
  state.suggestion = reply.suggested;
  byId('suggestion-text').textContent = reply.suggested;
  byId('suggestion').hidden = false;
  announcer.say('A suggested wording is ready. It is optional.');
}

// --- speaking ---

function addRecent(text) {
  state.recents = [text, ...state.recents.filter((item) => item !== text)].slice(0, 6);
  const list = byId('recent-list');
  list.replaceChildren();
  for (const phrase of state.recents) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.textContent = phrase;
    button.addEventListener('click', () => {
      // Back into review only: a recent phrase is never spoken or sent on a tap.
      state.requestId++;
      state.last = null;
      renderHeard();
      showReview(phrase);
    });
    item.append(button);
    list.append(item);
  }
  byId('recent-panel').hidden = state.recents.length === 0;
}

function speakText(text, { fromReview = true } = {}) {
  const tappedAt = performance.now();
  const timing = byId('speech-timing');
  speech.speak(text, {
    voiceURI: settings.voiceURI,
    rate: settings.rate,
    onStart: () => {
      byId('speech-panel').hidden = false;
      setStatus('speaking');
      announcer.say('Speaking');
      timing.hidden = !settings.showDetails;
      timing.textContent = `Voice started in ${((performance.now() - tappedAt) / 1000).toFixed(1)} s`;
    },
    onEnd: () => {
      byId('speech-panel').hidden = true;
      idleStatus();
    },
    onError: () => {
      byId('speech-panel').hidden = true;
      idleStatus();
      openShow(text, 'Speech did not work. Showing the words on screen instead.');
    },
  });
  if (fromReview) addRecent(text);
}

function onSpeak() {
  const text = byId('review-text').value.trim();
  if (!text) {
    announcer.say('There are no words to speak.');
    return;
  }
  speakText(text);
}

// --- show on screen ---

let showOpener = null;

function openShow(text, message = '') {
  showOpener = document.activeElement;
  byId('show-text').textContent = text;
  const note = byId('show-message');
  note.hidden = !message;
  note.textContent = message;
  byId('show-dialog').showModal();
}

// --- settings dialog ---

function renderVoices() {
  const select = byId('set-voice');
  const voices = speech.voices();
  select.replaceChildren();
  const fallback = document.createElement('option');
  fallback.value = '';
  fallback.textContent = voices.length ? `Default (${voiceLabel(voices[0])})` : 'Default voice';
  select.append(fallback);
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = voiceLabel(voice);
    select.append(option);
  }
  select.value = voices.some((voice) => voice.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
}

function renderModelSettings() {
  const spec = model.spec;
  const statusText = {
    unsupported: 'Not available in this browser',
    invalid: 'Custom model name not valid',
    checking: 'Checking',
    downloading: 'Downloading',
    loading: 'Loading',
    paused: 'Waiting',
    error: model.error ? model.error.message : 'Error',
  }[model.status];
  let status = statusText;
  if (!status) {
    const onDevice = model.check && model.check.model && model.check.runtime;
    if (model.status === 'ready') status = onDevice ? (state.shellComplete ? 'Works offline' : 'Downloaded') : 'Loaded (not kept on this device)';
    else status = 'Not downloaded';
  }
  byId('set-model-status').textContent = status;
  const approx = approxDownloadMb(spec);
  byId('set-model-size').textContent = approx ? `About ${approx} MB, plus the speech runtime the first time` : 'Unknown for a custom model';
  byId('set-model-message').textContent = model.status === 'ready' ? model.note : '';
  renderProgress(byId('set-progress-block'), byId('set-progress'), byId('set-progress-text'));
  const busy = ['checking', 'downloading', 'loading'].includes(model.status);
  byId('set-download').disabled = busy || model.status === 'ready' || model.status === 'invalid' || !asrSupported;
  byId('set-forget').disabled = busy || !spec || Boolean(spec.error) || !(model.check && model.check.model);
  const ready = model.ready;
  byId('about-lib').textContent = ready ? `transformers.js ${ready.libVersion}` : 'Not loaded';
  byId('about-ort').textContent = ready && ready.ortVersion ? ready.ortVersion : 'Not loaded';
  byId('about-device').textContent = ready ? ready.device : 'Not loaded';
  byId('about-threads').textContent = ready ? String(ready.threads ?? 'unknown') : 'Not loaded';
  byId('about-revision').textContent = ready ? ready.model.revision.slice(0, 12) : 'Not loaded';
}

function renderCustom() {
  const custom = settings.model === 'custom';
  byId('set-custom-block').hidden = !custom;
  byId('set-custom').value = settings.customModel;
  const parsed = parseCustomModel(settings.customModel);
  const resolved = settings.customResolved;
  const isHub = custom && !parsed.error && parsed.source === 'hub';
  byId('set-custom-resolved').hidden = !(isHub && resolved);
  byId('set-custom-check').hidden = !(isHub && resolved);
  if (isHub && resolved) byId('set-custom-resolved').textContent = `Revision ${resolved.sha.slice(0, 12)}, checked ${resolved.at.slice(0, 10)}.`;
}

function serverHost() {
  const endpoints = store.correctionEndpoints(settings.correctionServer, document.baseURI);
  return endpoints ? new URL(endpoints.correct).host : null;
}

function renderServerState() {
  const host = serverHost();
  byId('set-server-state').textContent = host
    ? `Suggestions are on. The words on screen and your saved phrases for this speech model are sent to ${host}, which may pass them to a language model provider.`
    : 'Suggestions are off.';
}

function renderPhrases() {
  const list = byId('phrases-list');
  list.replaceChildren();
  for (const phrase of phrases) {
    const item = document.createElement('li');
    const text = document.createElement('div');
    const meant = document.createElement('p');
    meant.textContent = phrase.intended;
    const heard = document.createElement('p');
    heard.className = 'muted';
    heard.textContent = `Heard: ${phrase.heard}`;
    text.append(meant, heard);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button small';
    remove.setAttribute('aria-label', `Remove phrase: ${phrase.intended}`);
    remove.textContent = '\u00d7';
    remove.addEventListener('click', () => {
      savePhrases(store.removePhrase(phrases, phrase.id));
      byId('phrases-message').textContent = 'Phrase removed.';
    });
    item.append(text, remove);
    list.append(item);
  }
  byId('phrases-summary').textContent = phrases.length
    ? `${phrases.length} of ${store.MAX_PHRASES} phrases saved.`
    : 'No phrases saved yet.';
  const identity = modelIdentity();
  const other = identity ? phrases.length - store.phrasesForModel(phrases, identity).length : 0;
  byId('phrases-other').hidden = other === 0;
  byId('phrases-other').textContent = `${other} ${other === 1 ? 'phrase was' : 'phrases were'} recorded with another speech model and ${other === 1 ? 'is' : 'are'} not sent.`;
  byId('phrases-export').disabled = phrases.length === 0;
  byId('phrases-clear').disabled = phrases.length === 0;
}

async function refreshStorage() {
  try {
    const { usage } = await navigator.storage.estimate();
    byId('set-storage-used').textContent = `${megabytes(usage)} MB`;
  } catch {
    byId('set-storage-used').textContent = 'Unknown';
  }
  try {
    const persisted = await navigator.storage.persisted();
    byId('set-storage-kept').textContent = persisted ? 'Yes' : 'No';
  } catch {
    byId('set-storage-kept').textContent = 'Unknown';
  }
}

function renderSettings() {
  byId('set-model').value = settings.model;
  byId('set-device').value = settings.device;
  byId('set-dtype').value = settings.dtype;
  byId('set-mode-hold').checked = settings.captureMode === 'hold';
  byId('set-mode-tap').checked = settings.captureMode === 'tap';
  byId('set-processing').checked = settings.micProcessing;
  byId('set-rate').value = String(settings.rate);
  byId('set-rate-value').textContent = settings.rate.toFixed(1);
  byId('set-server').value = settings.correctionServer;
  byId('set-key').value = settings.correctionKey;
  byId('set-details').checked = settings.showDetails;
  byId('about-app').textContent = APP_VERSION;
  byId('set-voice-test').disabled = !speech.available;
  renderCustom();
  renderVoices();
  renderServerState();
  renderPhrases();
  renderModelSettings();
}

function exportPhrasesFile() {
  const now = new Date();
  const name = `vokal-phrases-${now.toISOString().slice(0, 10)}.json`;
  const file = new File([store.exportPhrases(phrases, now)], name, { type: 'application/json' });
  // On phones the share sheet comes first: blob downloads are unreliable in iOS
  // home-screen apps. On a desktop a download is what people expect.
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importPhrasesFile(file) {
  const message = byId('phrases-message');
  if (!file) return;
  if (file.size > 1024 * 1024) {
    message.textContent = 'That file is too large to be a Vokal phrases file.';
    return;
  }
  const result = store.importPhrases(phrases, await file.text());
  const errors = {
    NOT_JSON: 'That file is not a Vokal phrases file.',
    NOT_VOKAL_PHRASES: 'That file is not a Vokal phrases file.',
    NO_VALID_ITEMS: 'No phrases in that file could be used.',
  };
  if (result.error) {
    message.textContent = errors[result.error];
  } else {
    savePhrases(result.items);
    message.textContent = `Added ${result.added} ${result.added === 1 ? 'phrase' : 'phrases'}. Skipped ${result.skipped}.`;
  }
  announcer.say(message.textContent);
}

async function testServer() {
  const result = byId('set-server-result');
  const endpoints = store.correctionEndpoints(settings.correctionServer, document.baseURI);
  if (!endpoints) {
    result.textContent = 'Suggestions are off. Enter a server address first.';
    return;
  }
  result.textContent = 'Testing.';
  const health = await corrector.health(endpoints.health, settings.correctionKey);
  if (health.error) result.textContent = health.error.message;
  else if (!health.configured) result.textContent = 'The suggestion server has no model configured.';
  else result.textContent = 'Connected. The suggestion server is ready.';
  announcer.say(result.textContent);
}

function wireSettings() {
  const dialog = byId('settings-dialog');
  byId('settings-open').addEventListener('click', () => {
    renderSettings();
    refreshStorage();
    refreshShellStatus();
    dialog.showModal();
  });
  byId('settings-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => byId('settings-open').focus());

  byId('set-model').addEventListener('change', (event) => {
    saveSettings({ model: event.target.value });
    renderCustom();
    refreshModel();
  });
  byId('set-custom').addEventListener('change', (event) => {
    const value = event.target.value.trim();
    const error = byId('set-custom-error');
    if (value && parseCustomModel(value).error) {
      error.hidden = false;
      error.textContent = 'Use owner/name, owner/name@revision or models/name.';
      return;
    }
    error.hidden = true;
    if (value !== settings.customModel) saveSettings({ customModel: value, customResolved: null });
    renderCustom();
    refreshModel();
  });
  byId('set-custom-check').addEventListener('click', async () => {
    const parsed = parseCustomModel(settings.customModel);
    if (parsed.error || parsed.source !== 'hub') return;
    const message = byId('set-model-message');
    message.textContent = 'Checking huggingface.co.';
    const resolved = await resolveRevision(parsed.id, parsed.ref);
    if (resolved.error) {
      message.textContent = resolved.error === 'MODEL_NOT_FOUND' ? 'That model could not be found.' : 'Could not reach huggingface.co.';
      return;
    }
    if (settings.customResolved && resolved.sha === settings.customResolved.sha) {
      message.textContent = 'This is the newest version.';
      return;
    }
    saveSettings({ customResolved: { id: parsed.id, ref: parsed.ref, sha: resolved.sha, at: new Date().toISOString() } });
    renderCustom();
    await refreshModel();
    byId('set-model-message').textContent = 'A newer version is available. Tap Download to fetch it.';
  });
  byId('set-device').addEventListener('change', (event) => {
    saveSettings({ device: event.target.value });
    refreshModel();
  });
  byId('set-dtype').addEventListener('change', (event) => {
    saveSettings({ dtype: event.target.value });
    refreshModel();
  });
  byId('set-download').addEventListener('click', () => downloadModel());
  byId('set-forget').addEventListener('click', () => forgetModel());

  byId('set-voice').addEventListener('change', (event) => saveSettings({ voiceURI: event.target.value }));
  byId('set-rate').addEventListener('input', (event) => {
    saveSettings({ rate: Number(event.target.value) });
    byId('set-rate-value').textContent = settings.rate.toFixed(1);
  });
  byId('set-voice-test').addEventListener('click', () => speakText('This is how Vokal sounds.', { fromReview: false }));

  for (const id of ['set-mode-hold', 'set-mode-tap']) {
    byId(id).addEventListener('change', (event) => {
      saveSettings({ captureMode: event.target.value });
      for (const control of recordControls) control.reset();
      setHint(recordHint());
    });
  }
  byId('set-processing').addEventListener('change', (event) => saveSettings({ micProcessing: event.target.checked }));

  byId('phrases-add').addEventListener('click', () => {
    dialog.close();
    onboarding.start('phrases');
  });
  byId('phrases-export').addEventListener('click', exportPhrasesFile);
  byId('phrases-import').addEventListener('click', () => byId('phrases-import-file').click());
  byId('phrases-import-file').addEventListener('change', async (event) => {
    await importPhrasesFile(event.target.files[0]);
    event.target.value = '';
  });
  byId('phrases-clear').addEventListener('click', () => {
    if (!window.confirm('Remove all saved phrases from this browser?')) return;
    savePhrases([]);
    byId('phrases-message').textContent = 'All phrases removed.';
  });

  byId('set-server').addEventListener('change', (event) => {
    const value = event.target.value.trim();
    const error = byId('set-server-error');
    if (!store.isValidServerAddress(value)) {
      error.hidden = false;
      error.textContent = 'Use ./ for this server, an https address, or http://localhost with a port.';
      return;
    }
    error.hidden = true;
    saveSettings({ correctionServer: value });
    corrector.reset();
    renderServerState();
    byId('set-server-result').textContent = '';
  });
  byId('set-key').addEventListener('change', (event) => {
    const value = event.target.value;
    if (!/^[\x21-\x7e]*$/.test(value)) {
      byId('set-server-result').textContent = 'The server key cannot contain spaces or special characters.';
      return;
    }
    saveSettings({ correctionKey: value });
    corrector.reset();
    byId('set-server-result').textContent = '';
  });
  byId('set-server-test').addEventListener('click', testServer);
  byId('set-details').addEventListener('change', (event) => {
    saveSettings({ showDetails: event.target.checked });
    renderHeard();
  });
}

// --- talk screen wiring ---

function recordHint() {
  return settings.captureMode === 'tap'
    ? 'Tap, start speaking when it says Listening, then tap again. Up to 30 seconds.'
    : 'Start speaking when it says Listening. Up to 30 seconds.';
}

function wireTalk() {
  createRecordControl({
    button: byId('record-button'),
    label: byId('record-label'),
    timer: byId('record-timer'),
    cancel: byId('record-cancel'),
    canvas: byId('talk-meter'),
    onStart: () => {
      // Visual changes only: nothing is announced while the microphone is open.
      state.requestId++;
      hidePanels();
      talk.pressToListeningMs = null;
      setHint(recordHint());
      setStatus('starting');
    },
    onListening: ({ pressToListeningMs }) => {
      talk.pressToListeningMs = pressToListeningMs;
      setStatus('listening');
    },
    onTake: onTalkTake,
    onMessage: talkMessage,
  });

  byId('model-download').addEventListener('click', () => {
    if (model.error && model.error.code === 'WORKER_CRASHED') refreshModel();
    else downloadModel();
  });
  byId('model-use-wasm').addEventListener('click', offerWasm);
  byId('model-fallback-download').addEventListener('click', acceptWasmOffer);

  byId('error-retry').addEventListener('click', () => {
    if (!state.lastAudio) return;
    byId('error-panel').hidden = true;
    runTalk(state.lastAudio);
  });
  byId('error-use-anyway').addEventListener('click', useRawText);
  byId('heard-use-anyway').addEventListener('click', useRawText);
  byId('confirm-yes').addEventListener('click', useRawText);
  byId('confirm-no').addEventListener('click', () => {
    byId('confirm-panel').hidden = true;
    idleStatus();
    announcer.say('Not used. Try again, or type.');
    byId('record-button').focus();
  });

  const review = byId('review-text');
  review.addEventListener('input', () => {
    // Any edit hides an offered suggestion, so it can never replace the person's words.
    hideSuggestion();
    state.suggestion = null;
  });
  byId('removed-add-back').addEventListener('click', () => {
    if (!state.chip) return;
    review.value = `${review.value.trimEnd()} ${state.chip}`.trim();
    state.chip = null;
    byId('removed-chip').hidden = true;
    hideSuggestion();
    announcer.say('Added back.');
    byId('speak-button').focus();
  });
  byId('suggestion-use').addEventListener('click', () => {
    if (!state.suggestion) return;
    review.value = state.suggestion;
    state.suggestion = null;
    hideSuggestion();
    announcer.say('Suggestion in the box. Check it before you speak.');
    byId('speak-button').focus();
  });
  byId('suggestion-keep').addEventListener('click', () => {
    state.suggestion = null;
    hideSuggestion();
    byId('speak-button').focus();
  });

  byId('speak-button').addEventListener('click', onSpeak);
  byId('show-button').addEventListener('click', () => {
    const text = review.value.trim();
    if (text) openShow(text);
  });
  byId('clear-button').addEventListener('click', () => {
    state.requestId++;
    hideReview();
    state.last = null;
    renderHeard();
    idleStatus();
    announcer.say('Cleared.');
    byId('record-button').focus();
  });
  byId('speech-stop').addEventListener('click', () => {
    speech.stop();
    byId('speech-panel').hidden = true;
    idleStatus();
  });
  byId('speech-again').addEventListener('click', () => {
    const text = speech.lastText;
    if (text) speakText(text, { fromReview: false });
  });

  byId('type-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = tidy(byId('type-text').value).slice(0, 1000);
    if (!text) return;
    // Typed words go straight to review: not guarded, not sent for suggestions.
    state.requestId++;
    state.last = null;
    renderHeard();
    byId('type-text').value = '';
    byId('type-details').open = false;
    showReview(text);
  });
  byId('file-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) onFileChosen(file);
  });

  const show = byId('show-dialog');
  show.addEventListener('click', () => show.close());
  show.addEventListener('close', () => {
    if (showOpener && document.contains(showOpener)) showOpener.focus();
  });

  if (!speech.available) {
    byId('speak-button').hidden = true;
    byId('show-button').classList.replace('secondary', 'primary');
    byId('speech-again').hidden = true;
  }
}

// --- service worker ---

function shellStatus(worker) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 3000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(Boolean(event.data && event.data.complete));
    };
    worker.postMessage({ type: 'SHELL_STATUS' }, [channel.port2]);
  });
}

async function refreshShellStatus() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    state.shellComplete = registration.active ? await shellStatus(registration.active) : false;
  } catch {
    state.shellComplete = false;
  }
  renderModelSettings();
}

function offerUpdate(worker) {
  const banner = byId('update-banner');
  banner.hidden = false;
  byId('update-reload').onclick = () => {
    state.updateRequested = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Reload only when the person asked for the update.
    if (state.updateRequested) window.location.reload();
  });
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const incoming = registration.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(incoming);
      });
    });
    refreshShellStatus();
  } catch (error) {
    console.warn('vokal: service worker registration failed', error && error.name ? error.name : 'Error');
  }
}

// --- onboarding ---

const onboarding = createOnboarding({
  announcer,
  showScreen,
  getSettings: () => settings,
  saveSettings,
  model: {
    get: () => model,
    download: () => downloadModel(),
    subscribe: (listener) => modelListeners.add(listener),
    sizeMb: (key) => approxDownloadMb(currentSpec({ model: key })),
    progress: progressInfo,
    select: (key) => {
      saveSettings({ model: key });
      return refreshModel();
    },
    identity: modelIdentity,
  },
  microphone: {
    warm: async () => {
      contextHolder.ensure();
      const code = await audio.warmMicrophone({ processing: settings.micProcessing });
      if (!code) state.micReady = true;
      return code ? TAKE_MESSAGES[code] : null;
    },
    isReady: () => state.micReady,
    startTake: (options) => audio.startTake({ processing: settings.micProcessing, skip: state.skipTypes, ...options }),
    createMeter: (canvas) => audio.createMeter({ canvas, holder: contextHolder }),
  },
  createRecordControl,
  transcribeRecording: async (recording) => {
    const decoded = await decodeRecording(recording);
    if (decoded.error) return { kind: 'decode', message: decoded.error };
    const out = await transcribeSamples(decoded.samples);
    return { ...out, capture: decoded.capture };
  },
  messages: { precheck: PRECHECK_MESSAGES, didntCatch: DIDNT_CATCH },
  phrases: {
    count: () => phrases.length,
    max: store.MAX_PHRASES,
    add: (input) => {
      const result = store.addPhrase(phrases, input);
      if (!result.error) savePhrases(result.items);
      return result;
    },
  },
  bumpRequest: () => ++state.requestId,
  finish: () => {
    saveSettings({ setupDone: true });
    showScreen('talk');
  },
});

// --- boot ---

function wireGlobal() {
  // One AudioContext for the meters, created on the first click or key press.
  document.addEventListener('click', () => contextHolder.ensure(), { capture: true, once: true });
  document.addEventListener('keydown', () => contextHolder.ensure(), { capture: true, once: true });
  const discardTakes = () => {
    for (const control of recordControls) control.discard();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') discardTakes();
  });
  window.addEventListener('pagehide', discardTakes);
  window.addEventListener('online', renderModel);
  window.addEventListener('offline', renderModel);
  if (speech.available && 'onvoiceschanged' in window.speechSynthesis) {
    window.speechSynthesis.addEventListener('voiceschanged', renderVoices);
  }

  byId('welcome-setup').addEventListener('click', () => onboarding.start());
  byId('welcome-skip').addEventListener('click', () => {
    saveSettings({ setupDone: true });
    showScreen('talk');
  });
  byId('crash-retry').addEventListener('click', () => {
    store.clearLoading(storage);
    byId('crash-notice').hidden = true;
    refreshModel();
  });
  byId('crash-safe').addEventListener('click', () => {
    store.clearLoading(storage);
    byId('crash-notice').hidden = true;
    saveSettings({ model: 'tiny.en', device: 'wasm', dtype: 'auto' });
    refreshModel();
  });
}

function boot() {
  byId('foot-version').textContent = `Version ${APP_VERSION}`;
  if (!loadedSettings.storageOk || !loadedPhrases.storageOk) noteStorageFailure();
  wireGlobal();
  wireTalk();
  wireSettings();
  registerServiceWorker();
  audio.micPermission({ onChange: (value) => { state.micReady = value === 'granted'; } }).then((value) => {
    if (value === 'granted') state.micReady = true;
  });

  setHint(recordHint());
  if (!asrSupported) {
    setHint('Speech to text is not available in this browser. Type instead.', { message: true });
    byId('type-details').open = true;
  }
  const marker = store.readLoading(storage);
  if (marker && asrSupported) {
    // The last load did not answer: it probably ran out of memory and closed the tab.
    byId('crash-notice').hidden = false;
    setModel({ status: 'paused', spec: currentSpec() });
  } else {
    refreshModel();
  }
  renderModel();
  showScreen(settings.setupDone ? 'talk' : 'welcome');
}

boot();
