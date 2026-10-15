// Settings, the phrase bank and the loading marker, kept in localStorage.
// Every function takes the storage object, so tests pass a fake and private browsing
// (where storage throws) keeps working from memory.

import { DEVICES, DTYPE_CHOICES, parseCustomModel } from './models.js';

export const KEYS = Object.freeze({ settings: 'vokal.settings', phrases: 'vokal.phrases', loading: 'vokal.loading' });
export const MAX_PHRASES = 20;
export const MAX_PHRASE_CHARS = 300;

export const DEFAULT_SETTINGS = Object.freeze({
  v: 1,
  model: 'tiny.en',
  customModel: '',
  customResolved: null,
  device: 'wasm',
  dtype: 'auto',
  captureMode: 'hold',
  micProcessing: true,
  voiceURI: '',
  rate: 1,
  correctionServer: '',
  correctionKey: '',
  showDetails: false,
  setupDone: false,
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PRINTABLE_NO_SPACE = /^[\x21-\x7e]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RELATIVE_SERVER = /^\.\.?\/(?:[\w.~-]+\/)*[\w.~-]*$/;

function readJson(storage, key) {
  if (!storage) return { value: null, ok: false };
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return { value: null, ok: false };
  }
  if (raw === null || raw === undefined) return { value: null, ok: true };
  try {
    return { value: JSON.parse(raw), ok: true };
  } catch {
    return { value: null, ok: true };
  }
}

function writeJson(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isShortString(value, max = 200) {
  return typeof value === 'string' && value.length <= max;
}

// --- settings ---

function validResolved(resolved, customModel) {
  if (!isPlainObject(resolved)) return null;
  const parsed = parseCustomModel(customModel);
  if (parsed.error || parsed.source !== 'hub') return null;
  const { id, ref, sha, at } = resolved;
  if (id !== parsed.id || ref !== parsed.ref || !COMMIT.test(sha || '') || typeof at !== 'string') return null;
  return { id, ref, sha, at };
}

export function isValidServerAddress(value) {
  return value === '' || parseServerAddress(value) !== null;
}

// Each invalid field falls back to its default on its own, so one bad value
// never resets everything else.
export function validateSettings(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const out = { ...DEFAULT_SETTINGS };
  if (['tiny.en', 'base.en', 'custom'].includes(input.model)) out.model = input.model;
  if (isShortString(input.customModel)) {
    const trimmed = input.customModel.trim();
    if (trimmed === '' || !parseCustomModel(trimmed).error) out.customModel = trimmed;
  }
  out.customResolved = validResolved(input.customResolved, out.customModel);
  if (DEVICES.includes(input.device)) out.device = input.device;
  if (typeof input.dtype === 'string' && Object.hasOwn(DTYPE_CHOICES, input.dtype)) out.dtype = input.dtype;
  if (input.captureMode === 'hold' || input.captureMode === 'tap') out.captureMode = input.captureMode;
  if (typeof input.micProcessing === 'boolean') out.micProcessing = input.micProcessing;
  if (isShortString(input.voiceURI)) out.voiceURI = input.voiceURI;
  if (typeof input.rate === 'number' && Number.isFinite(input.rate) && input.rate >= 0.5 && input.rate <= 1.5) out.rate = input.rate;
  if (isShortString(input.correctionServer) && isValidServerAddress(input.correctionServer.trim())) {
    out.correctionServer = input.correctionServer.trim();
  }
  if (isShortString(input.correctionKey) && PRINTABLE_NO_SPACE.test(input.correctionKey)) out.correctionKey = input.correctionKey;
  if (typeof input.showDetails === 'boolean') out.showDetails = input.showDetails;
  if (typeof input.setupDone === 'boolean') out.setupDone = input.setupDone;
  return out;
}

export function loadSettings(storage) {
  const { value, ok } = readJson(storage, KEYS.settings);
  return { settings: validateSettings(value), storageOk: ok };
}

export function saveSettings(storage, settings) {
  return writeJson(storage, KEYS.settings, validateSettings(settings));
}

// --- suggestion server address ---

// Accepts a relative path (./ or ../x/), an https URL, or http on localhost or
// 127.0.0.1. Returns the server root, always ending in a slash, or null.
function parseServerAddress(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (RELATIVE_SERVER.test(text)) return text.endsWith('/') ? text : `${text}/`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

// Absolute endpoint URLs, resolved against the page, or null when suggestions are off.
export function correctionEndpoints(value, baseUrl) {
  const root = parseServerAddress(value);
  if (!root) return null;
  const server = new URL(root, baseUrl);
  return { correct: new URL('api/correct', server).href, health: new URL('api/health', server).href };
}

// --- phrase bank ---

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PHRASE_CHARS || CONTROL.test(trimmed)) return null;
  return trimmed;
}

function cleanModel(model) {
  if (!isPlainObject(model) || !isPlainObject(model.dtype)) return null;
  const { id, revision, dtype, device } = model;
  if (!isShortString(id) || !id || !isShortString(revision, 64) || !revision) return null;
  if (!isShortString(dtype.encoder_model, 16) || !isShortString(dtype.decoder_model_merged, 16)) return null;
  if (!DEVICES.includes(device)) return null;
  return { id, revision, dtype: { encoder_model: dtype.encoder_model, decoder_model_merged: dtype.decoder_model_merged }, device };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function cleanCapture(capture) {
  if (!isPlainObject(capture)) return null;
  const { source, mimeType, bitsPerSecond, nativeRate, processing, resampler } = capture;
  if (source !== 'mic' && source !== 'file') return null;
  if (resampler !== 'decoder' && resampler !== 'fallback') return null;
  return {
    source,
    mimeType: isShortString(mimeType, 100) ? mimeType : '',
    bitsPerSecond: numberOrNull(bitsPerSecond),
    nativeRate: numberOrNull(nativeRate),
    processing: typeof processing === 'boolean' ? processing : null,
    resampler,
  };
}

function newId(items) {
  const taken = new Set(items.map((item) => item.id));
  let id;
  do {
    id = `p-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
  } while (taken.has(id));
  return id;
}

function validatePhrase(input) {
  const intended = cleanText(input.intended);
  if (!intended) return { error: 'INTENDED_INVALID' };
  const heard = cleanText(input.heard);
  if (!heard) return { error: 'HEARD_INVALID' };
  const model = cleanModel(input.model);
  if (!model) return { error: 'MODEL_INVALID' };
  const capture = cleanCapture(input.capture);
  if (!capture) return { error: 'CAPTURE_INVALID' };
  return { phrase: { intended, heard, usedAnyway: input.usedAnyway === true, model, capture } };
}

export function loadPhrases(storage) {
  const { value, ok } = readJson(storage, KEYS.phrases);
  if (!isPlainObject(value) || !Array.isArray(value.items)) return { items: [], storageOk: ok };
  const items = [];
  for (const raw of value.items) {
    if (!isPlainObject(raw) || items.length >= MAX_PHRASES) continue;
    const checked = validatePhrase(raw);
    if (checked.error) continue;
    const id = typeof raw.id === 'string' && /^p-[a-z0-9]{1,12}$/.test(raw.id) && !items.some((i) => i.id === raw.id)
      ? raw.id : newId(items);
    const at = typeof raw.at === 'string' ? raw.at : new Date(0).toISOString();
    items.push({ id, ...checked.phrase, at });
  }
  return { items, storageOk: ok };
}

export function savePhrases(storage, items) {
  return writeJson(storage, KEYS.phrases, { v: 1, items });
}

// Adding a 21st phrase is refused rather than dropping the oldest without asking.
export function addPhrase(items, input, now = new Date()) {
  if (items.length >= MAX_PHRASES) return { error: 'FULL' };
  const checked = validatePhrase(input || {});
  if (checked.error) return checked;
  const item = { id: newId(items), ...checked.phrase, at: now.toISOString() };
  return { items: [...items, item], item };
}

export function removePhrase(items, id) {
  return items.filter((item) => item.id !== id);
}

export function exportPhrases(items, now = new Date()) {
  return JSON.stringify({ app: 'vokal', kind: 'phrases', v: 1, exportedAt: now.toISOString(), items }, null, 2);
}

function isDuplicate(items, phrase) {
  return items.some((item) => item.intended === phrase.intended && item.heard === phrase.heard &&
    item.model.id === phrase.model.id && item.model.revision === phrase.model.revision);
}

export function importPhrases(items, json, now = new Date()) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return { error: 'NOT_JSON' };
  }
  if (!isPlainObject(data) || data.app !== 'vokal' || data.kind !== 'phrases' || !Array.isArray(data.items)) {
    return { error: 'NOT_VOKAL_PHRASES' };
  }
  let next = [...items];
  let added = 0;
  let skipped = 0;
  let valid = 0;
  for (const raw of data.items) {
    const checked = isPlainObject(raw) ? validatePhrase(raw) : { error: 'NOT_OBJECT' };
    if (checked.error) {
      skipped++;
      continue;
    }
    valid++;
    if (isDuplicate(next, checked.phrase) || next.length >= MAX_PHRASES) {
      skipped++;
      continue;
    }
    const wantedId = typeof raw.id === 'string' && /^p-[a-z0-9]{1,12}$/.test(raw.id) ? raw.id : null;
    const id = wantedId && !next.some((item) => item.id === wantedId) ? wantedId : newId(next);
    const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? raw.at : now.toISOString();
    next = [...next, { id, ...checked.phrase, at }];
    added++;
  }
  if (valid === 0) return { error: 'NO_VALID_ITEMS' };
  return { items: next, added, skipped };
}

// Only phrases recorded with the active model are like-for-like pairs.
export function phrasesForModel(items, { id, revision }) {
  return items.filter((item) => item.model.id === id && item.model.revision === revision);
}

// --- loading marker: written before a model load, removed when it answers ---

export function readLoading(storage) {
  const { value } = readJson(storage, KEYS.loading);
  return isPlainObject(value) && typeof value.key === 'string' ? value : null;
}

export function writeLoading(storage, spec, now = new Date()) {
  const { key, id, revision, device, dtype } = spec;
  return writeJson(storage, KEYS.loading, { key, id, revision, device, dtype, at: now.toISOString() });
}

export function clearLoading(storage) {
  if (!storage) return false;
  try {
    storage.removeItem(KEYS.loading);
    return true;
  } catch {
    return false;
  }
}
