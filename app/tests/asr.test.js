import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoadError, createAsr } from '../js/asr.js';

// A stand-in for the module worker: records what is posted and lets the test reply.
class FakeWorker extends EventTarget {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = String(url);
    this.options = options;
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  postMessage(message, transfer = []) {
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  reply(data) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  last() {
    return this.posted[this.posted.length - 1].message;
  }
}

const SPEC = { key: 'tiny.en', source: 'hub', id: 'onnx-community/whisper-tiny.en', revision: 'r', localPath: null, device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } };

function setup() {
  FakeWorker.instances = [];
  const asr = createAsr({ workerUrl: 'https://app.test/js/asr-worker.js', WorkerImpl: FakeWorker });
  return asr;
}

async function loaded() {
  const asr = setup();
  const ready = asr.load(SPEC, { download: false });
  const worker = FakeWorker.instances[0];
  worker.reply({ type: 'ready', id: worker.last().id, model: { key: 'tiny.en', id: SPEC.id, revision: 'r' } });
  await ready;
  return { asr, worker };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('load creates a module worker and resolves on ready', async () => {
  const { asr, worker } = await loaded();
  assert.equal(worker.options.type, 'module');
  assert.equal(worker.url, 'https://app.test/js/asr-worker.js');
  assert.deepEqual(worker.posted[0].message, { type: 'load', model: SPEC, download: false, id: 1 });
  assert.equal(asr.state, 'ready');
});

test('progress reaches onProgress and replies route by id', async () => {
  const asr = setup();
  const seen = [];
  const ready = asr.load(SPEC, { download: true, onProgress: (message) => seen.push(message.type) });
  const worker = FakeWorker.instances[0];
  const id = worker.last().id;
  worker.reply({ type: 'progress', id, file: 'config.json', loaded: 1, total: 2 });
  worker.reply({ type: 'progress-total', id, loaded: 1, total: 2 });
  worker.reply({ type: 'progress', id: id + 99, file: 'x', loaded: 1, total: 1 });
  worker.reply({ type: 'ready', id: id + 99 });
  assert.equal(asr.state, 'loading', 'a reply with another id is ignored');
  worker.reply({ type: 'ready', id });
  await ready;
  assert.deepEqual(seen, ['progress', 'progress-total']);
});

test('requests are sent one at a time, in order', async () => {
  const { asr, worker } = await loaded();
  const first = asr.check(SPEC);
  const second = asr.forget(SPEC);
  assert.equal(worker.posted.length, 2, 'only the check has been sent');
  assert.equal(worker.last().type, 'check');
  worker.reply({ type: 'checked', id: worker.last().id, model: true, runtime: false });
  assert.deepEqual(await first, { type: 'checked', id: 2, model: true, runtime: false });
  assert.equal(worker.last().type, 'forget');
  worker.reply({ type: 'forgotten', id: worker.last().id });
  assert.equal(await second, undefined);
});

test('an error reply rejects with its code', async () => {
  const asr = setup();
  const ready = asr.load(SPEC, { download: true });
  const worker = FakeWorker.instances[0];
  worker.reply({ type: 'error', id: worker.last().id, code: 'DOWNLOAD_INTERRUPTED', message: 'Download stopped. Tap Download to continue.' });
  await assert.rejects(ready, { code: 'DOWNLOAD_INTERRUPTED', message: 'Download stopped. Tap Download to continue.' });
  assert.equal(asr.state, 'idle');
});

test('transcribe sends a copy and the caller keeps its array', async () => {
  const { asr, worker } = await loaded();
  const audio = new Float32Array([0.1, 0.2, 0.3]);
  const result = asr.transcribe(audio);
  const sent = worker.posted[worker.posted.length - 1];
  assert.equal(sent.message.type, 'transcribe');
  assert.equal(sent.message.sampleRate, 16000);
  assert.equal(sent.message.probe, true);
  assert.notEqual(sent.message.audio, audio);
  assert.equal(sent.transfer[0], sent.message.audio.buffer);
  assert.notEqual(sent.transfer[0], audio.buffer);
  assert.equal(audio.length, 3, 'the caller array keeps its length');
  worker.reply({ type: 'result', id: sent.message.id, text: ' Yes.' });
  assert.equal((await result).text, ' Yes.');
  asr.transcribe(audio, { probe: false });
  assert.equal(worker.last().probe, false);
});

test('a newer queued transcribe replaces the older one', async () => {
  const { asr, worker } = await loaded();
  const running = asr.transcribe(new Float32Array(4));
  const queued = asr.transcribe(new Float32Array(5));
  const newest = asr.transcribe(new Float32Array(6));
  await assert.rejects(queued, { code: 'SUPERSEDED' });
  worker.reply({ type: 'result', id: worker.last().id, text: 'one' });
  assert.equal((await running).text, 'one');
  assert.equal(worker.last().audio.length, 6);
  worker.reply({ type: 'result', id: worker.last().id, text: 'three' });
  assert.equal((await newest).text, 'three');
});

test('transcribe before a load rejects with NOT_LOADED', async () => {
  const asr = setup();
  await assert.rejects(asr.transcribe(new Float32Array(1)), { code: 'NOT_LOADED' });
});

for (const type of ['error', 'messageerror']) {
  test(`a worker ${type} event rejects everything pending with WORKER_CRASHED`, async () => {
    const { asr, worker } = await loaded();
    const running = asr.transcribe(new Float32Array(1));
    const waiting = asr.check(SPEC);
    worker.dispatchEvent(new Event(type));
    await assert.rejects(running, { code: 'WORKER_CRASHED' });
    await assert.rejects(waiting, { code: 'WORKER_CRASHED' });
    assert.equal(asr.state, 'crashed');
    assert.equal(worker.terminated, true);
  });
}

test('terminate rejects pending requests with TERMINATED', async () => {
  const { asr, worker } = await loaded();
  const running = asr.transcribe(new Float32Array(1));
  asr.terminate();
  await assert.rejects(running, { code: 'TERMINATED' });
  assert.equal(worker.terminated, true);
  assert.equal(asr.state, 'idle');
});

test('each load terminates the old worker and starts a new one', async () => {
  const { asr, worker } = await loaded();
  const pending = asr.check(SPEC);
  const next = asr.load(SPEC, { download: false });
  await assert.rejects(pending, { code: 'TERMINATED' });
  assert.equal(worker.terminated, true);
  assert.equal(FakeWorker.instances.length, 2);
  const fresh = FakeWorker.instances[1];
  assert.equal(fresh.last().type, 'load');
  fresh.reply({ type: 'ready', id: fresh.last().id });
  await next;
  await tick();
});

test('check and forget create a worker when there is none', async () => {
  const asr = setup();
  const checked = asr.check(SPEC);
  assert.equal(FakeWorker.instances.length, 1);
  const worker = FakeWorker.instances[0];
  worker.reply({ type: 'checked', id: worker.last().id, model: false, runtime: false });
  assert.equal((await checked).model, false);
});

test('classifyLoadError follows the documented order', () => {
  const hub404 = [{ url: 'https://huggingface.co/owner/name/resolve/abc/config.json', status: 404 }];
  assert.equal(classifyLoadError({ error: new Error('x'), source: 'hub', download: true, failures: hub404 }), 'MODEL_NOT_FOUND');
  const hub401 = [{ url: 'https://huggingface.co/owner/name/resolve/abc/onnx/encoder_model_quantized.onnx', status: 401 }];
  assert.equal(classifyLoadError({ error: new Error('x'), source: 'hub', download: true, failures: hub401 }), 'MODEL_NOT_FOUND');
  const optional404 = [{ url: 'https://huggingface.co/owner/name/resolve/abc/processor_config.json', status: 404 }];
  assert.equal(classifyLoadError({ error: new Error('x'), source: 'hub', download: true, failures: optional404 }), 'MODEL_LOAD_FAILED');
  const localMissing = new Error('`local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at "/models/x/config.json".');
  assert.equal(classifyLoadError({ error: localMissing, source: 'local', download: true, failures: [] }), 'MODEL_NOT_FOUND');
  assert.equal(classifyLoadError({ error: localMissing, source: 'hub', download: false, failures: [] }), 'NOT_DOWNLOADED');
  const offline = [{ url: 'https://cdn.jsdelivr.net/npm/x.wasm', rejected: true }];
  assert.equal(classifyLoadError({ error: new Error('x'), source: 'hub', download: false, failures: offline }), 'NOT_DOWNLOADED');
  assert.equal(classifyLoadError({ error: new Error('x'), source: 'hub', download: true, failures: offline }), 'DOWNLOAD_INTERRUPTED');
  assert.equal(classifyLoadError({ error: new TypeError('network error'), source: 'hub', download: true, failures: [] }), 'DOWNLOAD_INTERRUPTED');
  assert.equal(classifyLoadError({ error: new TypeError('x is undefined'), source: 'hub', download: true, failures: [] }), 'MODEL_LOAD_FAILED');
  assert.equal(classifyLoadError({ error: new Error('out of memory'), source: 'hub', download: true, failures: [] }), 'MODEL_LOAD_FAILED');
});
