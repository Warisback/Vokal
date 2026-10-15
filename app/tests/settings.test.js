import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/settings.js';

const NOW = new Date('2026-10-14T15:02:11.000Z');
const SHA = 'b'.repeat(40);

class MemoryStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

// Private browsing on some browsers: every call throws.
const throwingStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
};

const MODEL = {
  id: 'onnx-community/whisper-tiny.en',
  revision: '2575352d61be1bf7225cf8f8b268a4678025fc58',
  dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  device: 'wasm',
};
const CAPTURE = { source: 'mic', mimeType: 'audio/webm;codecs=opus', bitsPerSecond: 128000, nativeRate: 48000, processing: true, resampler: 'decoder' };

function phrase(intended, heard = intended, extra = {}) {
  return { intended, heard, usedAnyway: false, model: MODEL, capture: CAPTURE, ...extra };
}

function fill(count) {
  let items = [];
  for (let i = 0; i < count; i++) items = store.addPhrase(items, phrase(`Phrase ${i}.`), NOW).items;
  return items;
}

test('defaults when nothing is stored', () => {
  const { settings, storageOk } = store.loadSettings(new MemoryStorage());
  assert.deepEqual(settings, store.DEFAULT_SETTINGS);
  assert.equal(storageOk, true);
});

test('each invalid field falls back on its own', () => {
  const raw = {
    model: 'large-v3', customModel: 'https://x', device: 'npu', dtype: 'int2', captureMode: 'shake',
    micProcessing: 'yes', voiceURI: 7, rate: 3, correctionServer: 'http://example.com/', correctionKey: 'has space',
    showDetails: 1, setupDone: true,
  };
  const settings = store.validateSettings(raw);
  assert.equal(settings.setupDone, true, 'a valid field survives');
  for (const key of ['model', 'customModel', 'device', 'dtype', 'captureMode', 'micProcessing', 'voiceURI', 'rate', 'correctionServer', 'correctionKey', 'showDetails']) {
    assert.deepEqual(settings[key], store.DEFAULT_SETTINGS[key], key);
  }
});

test('valid settings round trip through storage', () => {
  const storage = new MemoryStorage();
  const wanted = {
    ...store.DEFAULT_SETTINGS, model: 'custom', customModel: 'owner/name',
    customResolved: { id: 'owner/name', ref: 'main', sha: SHA, at: NOW.toISOString() },
    device: 'webgpu', dtype: 'fp32+q8', captureMode: 'tap', micProcessing: false, voiceURI: 'Daniel',
    rate: 1.2, correctionServer: './', correctionKey: 'abc-123_XYZ', showDetails: true, setupDone: true,
  };
  assert.equal(store.saveSettings(storage, wanted), true);
  assert.deepEqual(store.loadSettings(storage).settings, wanted);
});

test('device other than wasm or webgpu falls back to wasm', () => {
  assert.equal(store.validateSettings({ device: 'cuda' }).device, 'wasm');
  assert.equal(store.validateSettings({ device: 'webgpu' }).device, 'webgpu');
});

test('a resolved revision is dropped when it no longer matches the custom model', () => {
  const resolved = { id: 'owner/name', ref: 'main', sha: SHA, at: NOW.toISOString() };
  assert.deepEqual(store.validateSettings({ customModel: 'owner/name', customResolved: resolved }).customResolved, resolved);
  assert.equal(store.validateSettings({ customModel: 'owner/other', customResolved: resolved }).customResolved, null);
  assert.equal(store.validateSettings({ customModel: 'owner/name', customResolved: { ...resolved, sha: 'short' } }).customResolved, null);
});

test('correctionKey must be printable ASCII without spaces', () => {
  assert.equal(store.validateSettings({ correctionKey: 'k3y_-.~!' }).correctionKey, 'k3y_-.~!');
  assert.equal(store.validateSettings({ correctionKey: 'two words' }).correctionKey, '');
  assert.equal(store.validateSettings({ correctionKey: 'caf\u00e9' }).correctionKey, '');
  assert.equal(store.validateSettings({ correctionKey: 'x'.repeat(201) }).correctionKey, '');
});

test('storage that throws gives storageOk false without throwing', () => {
  const loaded = store.loadSettings(throwingStorage);
  assert.equal(loaded.storageOk, false);
  assert.deepEqual(loaded.settings, store.DEFAULT_SETTINGS);
  assert.equal(store.saveSettings(throwingStorage, store.DEFAULT_SETTINGS), false);
  assert.deepEqual(store.loadPhrases(throwingStorage), { items: [], storageOk: false });
  assert.equal(store.savePhrases(throwingStorage, []), false);
  assert.equal(store.readLoading(throwingStorage), null);
  assert.equal(store.clearLoading(throwingStorage), false);
  assert.equal(store.loadSettings(null).storageOk, false);
});

test('corrupt JSON in storage gives defaults', () => {
  const storage = new MemoryStorage({ 'vokal.settings': '{not json', 'vokal.phrases': '[' });
  assert.deepEqual(store.loadSettings(storage).settings, store.DEFAULT_SETTINGS);
  assert.deepEqual(store.loadPhrases(storage).items, []);
});

test('addPhrase stores the full model identity and capture path', () => {
  const { items, item } = store.addPhrase([], phrase(' Water, please. ', 'Water please.'), NOW);
  assert.equal(items.length, 1);
  assert.match(item.id, /^p-[a-z0-9]{4}$/);
  assert.equal(item.intended, 'Water, please.');
  assert.equal(item.heard, 'Water please.');
  assert.deepEqual(item.model, MODEL);
  assert.deepEqual(item.capture, CAPTURE);
  assert.equal(item.at, NOW.toISOString());
});

test('phrase limits: 20 items, 300 characters, no control characters, no empty heard', () => {
  const full = fill(20);
  assert.equal(full.length, 20);
  assert.deepEqual(store.addPhrase(full, phrase('One more.'), NOW), { error: 'FULL' });
  assert.equal(new Set(full.map((item) => item.id)).size, 20, 'ids are unique');
  assert.deepEqual(store.addPhrase([], phrase('x'.repeat(301)), NOW), { error: 'INTENDED_INVALID' });
  assert.ok(store.addPhrase([], phrase('x'.repeat(300)), NOW).items);
  assert.deepEqual(store.addPhrase([], phrase('Water\nplease'), NOW), { error: 'INTENDED_INVALID' });
  assert.deepEqual(store.addPhrase([], phrase('Water', '\u0007'), NOW), { error: 'HEARD_INVALID' });
  assert.deepEqual(store.addPhrase([], phrase('Water', '   '), NOW), { error: 'HEARD_INVALID' });
  assert.deepEqual(store.addPhrase([], phrase('Water', 'Water', { model: { ...MODEL, device: 'tpu' } }), NOW), { error: 'MODEL_INVALID' });
  assert.deepEqual(store.addPhrase([], phrase('Water', 'Water', { capture: { ...CAPTURE, resampler: 'linear' } }), NOW), { error: 'CAPTURE_INVALID' });
});

test('removePhrase removes by id only', () => {
  const items = fill(3);
  const left = store.removePhrase(items, items[1].id);
  assert.deepEqual(left.map((item) => item.id), [items[0].id, items[2].id]);
});

test('phrases survive a save and load', () => {
  const storage = new MemoryStorage();
  const items = fill(2);
  assert.equal(store.savePhrases(storage, items), true);
  assert.deepEqual(store.loadPhrases(storage), { items, storageOk: true });
});

test('importPhrases rejects files that are not Vokal phrases', () => {
  assert.deepEqual(store.importPhrases([], 'not json'), { error: 'NOT_JSON' });
  assert.deepEqual(store.importPhrases([], JSON.stringify({ app: 'other', kind: 'phrases', items: [] })), { error: 'NOT_VOKAL_PHRASES' });
  assert.deepEqual(store.importPhrases([], JSON.stringify({ app: 'vokal', kind: 'settings', items: [] })), { error: 'NOT_VOKAL_PHRASES' });
  const junk = JSON.stringify({ app: 'vokal', kind: 'phrases', v: 1, items: [{ intended: '' }, 7] });
  assert.deepEqual(store.importPhrases([], junk), { error: 'NO_VALID_ITEMS' });
});

test('export then import round trip skips duplicates', () => {
  const items = fill(2);
  const json = store.exportPhrases(items, NOW);
  const data = JSON.parse(json);
  assert.equal(data.app, 'vokal');
  assert.equal(data.kind, 'phrases');
  assert.equal(data.v, 1);
  assert.equal(data.exportedAt, NOW.toISOString());
  assert.deepEqual(store.importPhrases([], json, NOW), { items, added: 2, skipped: 0 });
  const again = store.importPhrases(items, json, NOW);
  assert.deepEqual(again, { items, added: 0, skipped: 2 });
});

test('import renames colliding ids and stops at the limit', () => {
  const mine = store.addPhrase([], phrase('Mine.'), NOW).items;
  const theirs = [{ ...phrase('Theirs.'), id: mine[0].id, at: NOW.toISOString() }];
  const result = store.importPhrases(mine, store.exportPhrases(theirs, NOW), NOW);
  assert.equal(result.added, 1);
  assert.notEqual(result.items[1].id, mine[0].id);

  const nineteen = fill(19);
  const incoming = [phrase('New one.'), phrase('New two.'), phrase('New three.')].map((p, i) => ({ ...p, id: `p-new${i}`, at: NOW.toISOString() }));
  const capped = store.importPhrases(nineteen, store.exportPhrases(incoming, NOW), NOW);
  assert.equal(capped.items.length, 20);
  assert.equal(capped.added, 1);
  assert.equal(capped.skipped, 2);
});

test('phrasesForModel keeps only like-for-like pairs', () => {
  const items = [
    ...store.addPhrase([], phrase('Same model.'), NOW).items,
  ];
  const other = store.addPhrase(items, phrase('Other model.', 'Other model.', { model: { ...MODEL, revision: 'c'.repeat(40) } }), NOW).items;
  assert.deepEqual(store.phrasesForModel(other, MODEL).map((item) => item.intended), ['Same model.']);
});

test('correctionEndpoints resolves allowed addresses and refuses others', () => {
  const base = 'https://warisback.github.io/Vokal/';
  assert.deepEqual(store.correctionEndpoints('./', base), {
    correct: 'https://warisback.github.io/Vokal/api/correct',
    health: 'https://warisback.github.io/Vokal/api/health',
  });
  assert.deepEqual(store.correctionEndpoints('https://host/x/', base), { correct: 'https://host/x/api/correct', health: 'https://host/x/api/health' });
  assert.deepEqual(store.correctionEndpoints('https://host/x', base), { correct: 'https://host/x/api/correct', health: 'https://host/x/api/health' });
  assert.deepEqual(store.correctionEndpoints('http://localhost:3210/', base), { correct: 'http://localhost:3210/api/correct', health: 'http://localhost:3210/api/health' });
  assert.equal(store.correctionEndpoints('http://127.0.0.1:3210/', base).correct, 'http://127.0.0.1:3210/api/correct');
  assert.equal(store.correctionEndpoints('../server/', base).correct, 'https://warisback.github.io/server/api/correct');
  for (const bad of ['http://example.com/', 'ftp://host/', 'javascript:alert(1)', 'https://user:pw@host/', 'https://host/?q=1', '/abs/', 'host/x']) {
    assert.equal(store.correctionEndpoints(bad, base), null, bad);
  }
  assert.equal(store.correctionEndpoints('', base), null);
  assert.equal(store.isValidServerAddress(''), true);
  assert.equal(store.isValidServerAddress('http://example.com/'), false);
});

test('a long relative address does not hang the check', () => {
  const started = Date.now();
  assert.equal(store.isValidServerAddress(`./${'a'.repeat(190)}!`), false);
  assert.ok(Date.now() - started < 100);
});

test('loading marker: write, read, clear', () => {
  const storage = new MemoryStorage();
  const spec = { key: 'base.en', id: 'onnx-community/whisper-base.en', revision: 'r', device: 'wasm', dtype: MODEL.dtype, localPath: null, source: 'hub' };
  assert.equal(store.readLoading(storage), null);
  assert.equal(store.writeLoading(storage, spec, NOW), true);
  assert.deepEqual(store.readLoading(storage), { key: 'base.en', id: spec.id, revision: 'r', device: 'wasm', dtype: MODEL.dtype, at: NOW.toISOString() });
  assert.equal(store.clearLoading(storage), true);
  assert.equal(store.readLoading(storage), null);
});
