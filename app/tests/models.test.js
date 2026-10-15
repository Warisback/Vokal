import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DTYPE_BY_DEVICE, DTYPE_CHOICES, MODELS, approxDownloadMb, fallbackDtype, modelFiles, modelSpec,
  parseCustomModel, resolveDtype, resolveRevision, sameSpec,
} from '../js/models.js';
import { DEFAULT_SETTINGS } from '../js/settings.js';

const PAGES = 'https://warisback.github.io/Vokal/';
const LOCAL = 'http://127.0.0.1:3210/';
const SHA = 'a'.repeat(40);

function spec(overrides, base = PAGES) {
  return modelSpec({ ...DEFAULT_SETTINGS, ...overrides }, { appBaseUrl: base });
}

test('download sizes for the built-in models match the measured totals', () => {
  assert.equal(approxDownloadMb(spec({ model: 'tiny.en', device: 'wasm' })), 43.5);
  assert.equal(approxDownloadMb(spec({ model: 'tiny.en', device: 'webgpu' })), 122.3);
  assert.equal(approxDownloadMb(spec({ model: 'base.en', device: 'wasm' })), 79.6);
  assert.equal(approxDownloadMb(spec({ model: 'base.en', device: 'webgpu' })), 208.8);
});

test('size is unknown for custom and local models', () => {
  assert.equal(approxDownloadMb(spec({ model: 'custom', customModel: 'models/vokal-asr' })), null);
  assert.equal(approxDownloadMb({ error: 'NOT_RESOLVED' }), null);
});

test('resolveDtype and fallbackDtype cover every precision choice', () => {
  for (const [key, choice] of Object.entries(DTYPE_CHOICES)) {
    for (const device of ['wasm', 'webgpu']) {
      const expected = choice ? { encoder_model: choice[0], decoder_model_merged: choice[1] } : DTYPE_BY_DEVICE[device];
      assert.deepEqual(resolveDtype(key, device), expected, `${key} on ${device}`);
    }
    const fallback = choice ? { encoder_model: choice[0], decoder_model_merged: choice[1] } : DTYPE_BY_DEVICE.wasm;
    assert.deepEqual(fallbackDtype(key), fallback, `fallback for ${key}`);
  }
  assert.deepEqual(resolveDtype('nonsense', 'webgpu'), DTYPE_BY_DEVICE.webgpu);
});

test('parseCustomModel accepts Hub ids and local folders', () => {
  assert.deepEqual(parseCustomModel('owner/name'), { source: 'hub', id: 'owner/name', ref: 'main' });
  assert.deepEqual(parseCustomModel('owner/name@v1.2'), { source: 'hub', id: 'owner/name', ref: 'v1.2' });
  assert.deepEqual(parseCustomModel(`onnx-community/whisper-tiny@${SHA}`), { source: 'hub', id: 'onnx-community/whisper-tiny', ref: SHA });
  assert.deepEqual(parseCustomModel('models/vokal-asr'), { source: 'local', id: 'vokal-asr' });
  assert.deepEqual(parseCustomModel('models/vokal-asr/'), { source: 'local', id: 'vokal-asr' });
  assert.deepEqual(parseCustomModel('  owner/name  '), { source: 'hub', id: 'owner/name', ref: 'main' });
});

test('parseCustomModel refuses URLs, paths and odd input', () => {
  for (const bad of ['https://huggingface.co/owner/name', '/models/x', '../x', '', 'owner', 'owner/na me',
    'owner /name', `owner/${'n'.repeat(97)}`, 'models/..', 'owner/..', 'models/a/b', 'x'.repeat(201), 'owner/name@', '@ref']) {
    assert.ok(parseCustomModel(bad).error, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('resolveRevision skips the request for a commit hash', async () => {
  let calls = 0;
  const result = await resolveRevision('owner/name', SHA, async () => {
    calls++;
    return new Response('{}');
  });
  assert.deepEqual(result, { sha: SHA });
  assert.equal(calls, 0);
});

test('resolveRevision reads the commit from the Hub API', async () => {
  let url = '';
  const result = await resolveRevision('owner/name', 'main', async (requested) => {
    url = requested;
    return new Response(JSON.stringify({ sha: SHA }), { status: 200 });
  });
  assert.deepEqual(result, { sha: SHA });
  assert.equal(url, 'https://huggingface.co/api/models/owner/name/revision/main');
});

test('resolveRevision maps missing models and network failures', async () => {
  for (const status of [401, 404]) {
    const result = await resolveRevision('owner/name', 'main', async () => new Response('{}', { status }));
    assert.deepEqual(result, { error: 'MODEL_NOT_FOUND' });
  }
  assert.deepEqual(await resolveRevision('owner/name', 'main', async () => { throw new TypeError('offline'); }), { error: 'NETWORK' });
  assert.deepEqual(await resolveRevision('owner/name', 'main', async () => new Response('oops', { status: 500 })), { error: 'NETWORK' });
  assert.deepEqual(await resolveRevision('owner/name', 'main', async () => new Response('<html>', { status: 200 })), { error: 'NETWORK' });
});

test('modelSpec builds the built-in specs on both devices', () => {
  for (const key of Object.keys(MODELS)) {
    for (const device of ['wasm', 'webgpu']) {
      assert.deepEqual(spec({ model: key, device }), {
        key, source: 'hub', id: MODELS[key].repo, revision: MODELS[key].revision, localPath: null,
        device, dtype: DTYPE_BY_DEVICE[device],
      });
    }
  }
});

test('modelSpec builds a local folder spec with a root-relative path', () => {
  const pages = spec({ model: 'custom', customModel: 'models/vokal-asr' });
  assert.equal(pages.source, 'local');
  assert.equal(pages.id, 'vokal-asr');
  assert.equal(pages.revision, 'main');
  assert.equal(pages.localPath, '/Vokal/models/');
  assert.equal(spec({ model: 'custom', customModel: 'models/vokal-asr' }, LOCAL).localPath, '/models/');
});

test('a custom Hub model needs a matching resolved revision', () => {
  assert.deepEqual(spec({ model: 'custom', customModel: 'owner/name' }), { error: 'NOT_RESOLVED' });
  const otherRef = { id: 'owner/name', ref: 'dev', sha: SHA, at: '2026-10-14T00:00:00.000Z' };
  assert.deepEqual(spec({ model: 'custom', customModel: 'owner/name', customResolved: otherRef }), { error: 'NOT_RESOLVED' });
  const resolved = { id: 'owner/name', ref: 'main', sha: SHA, at: '2026-10-14T00:00:00.000Z' };
  const built = spec({ model: 'custom', customModel: 'owner/name', customResolved: resolved });
  assert.equal(built.source, 'hub');
  assert.equal(built.revision, SHA);
  assert.deepEqual(spec({ model: 'custom', customModel: 'https://evil.example/x' }), { error: 'INVALID_CUSTOM' });
});

test('modelFiles lists the folder layout for a precision', () => {
  assert.deepEqual(modelFiles(DTYPE_BY_DEVICE.wasm).slice(-2), ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
  assert.deepEqual(modelFiles(DTYPE_BY_DEVICE.webgpu).slice(-2), ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx']);
});

test('sameSpec compares every field that changes the loaded model', () => {
  const a = spec({ model: 'tiny.en' });
  assert.ok(sameSpec(a, spec({ model: 'tiny.en' })));
  assert.ok(!sameSpec(a, spec({ model: 'tiny.en', dtype: 'fp16' })));
  assert.ok(!sameSpec(a, spec({ model: 'tiny.en', device: 'webgpu' })));
  assert.ok(!sameSpec(a, { error: 'NOT_RESOLVED' }));
});
