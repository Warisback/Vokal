import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://warisback.github.io/Vokal/';

function keyOf(request, { ignoreSearch = false } = {}) {
  const url = new URL(typeof request === 'string' ? request : request.url);
  if (ignoreSearch) url.search = '';
  return url.href;
}

class FakeCache {
  constructor(fetchImpl) {
    this.entries = new Map();
    this.fetchImpl = fetchImpl;
  }
  async match(request, options = {}) {
    if (!options.ignoreSearch) return this.entries.get(keyOf(request));
    for (const [key, response] of this.entries) {
      if (keyOf(key, { ignoreSearch: true }) === keyOf(request, { ignoreSearch: true })) return response;
    }
    return undefined;
  }
  async put(request, response) {
    this.entries.set(keyOf(request), response);
  }
  // All or nothing, like the real addAll.
  async addAll(requests) {
    const responses = await Promise.all(requests.map(async (request) => {
      const response = await this.fetchImpl(request);
      if (!response.ok) throw new TypeError('bad response');
      return [request, response];
    }));
    for (const [request, response] of responses) this.entries.set(keyOf(request), response);
  }
}

class FakeCaches {
  constructor(fetchImpl) {
    this.map = new Map();
    this.fetchImpl = fetchImpl;
  }
  async open(name) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache(this.fetchImpl));
    return this.map.get(name);
  }
  async keys() {
    return [...this.map.keys()];
  }
  async delete(name) {
    return this.map.delete(name);
  }
}

function loadWorker({ failPath = null } = {}) {
  const requested = [];
  const fetchImpl = async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    requested.push({ url, cache: request.cache });
    if (failPath && url.endsWith(failPath)) return new Response('missing', { status: 404 });
    return new Response(`body of ${url}`, { status: 200 });
  };
  const caches = new FakeCaches(fetchImpl);
  const listeners = {};
  const self = {
    registration: { scope: SCOPE },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    skipWaiting() { this.skipped = true; return Promise.resolve(); },
    clients: { claim() { self.claimed = true; return Promise.resolve(); } },
  };
  const context = vm.createContext({ self, caches, fetch: fetchImpl, Request, Response, URL, console });
  vm.runInContext(SOURCE, context);
  const constants = vm.runInContext('({ PRECACHE, VERSION, SHELL_CACHE })', context);
  return { context, listeners, self, caches, requested, ...constants };
}

function extendable(extra = {}) {
  const event = { promises: [], waitUntil(promise) { this.promises.push(promise); }, ...extra };
  event.done = () => Promise.all(event.promises);
  return event;
}

function fetchEvent(request) {
  const event = { request, responded: null, respondWith(promise) { this.responded = promise; } };
  return event;
}

async function installed() {
  const worker = loadWorker();
  const event = extendable();
  worker.listeners.install(event);
  await event.done();
  return worker;
}

test('install puts every precache entry in the current shell cache', async () => {
  const worker = await installed();
  const cache = await worker.caches.open(worker.SHELL_CACHE);
  for (const path of worker.PRECACHE) assert.ok(await cache.match(new URL(path, SCOPE).href), path);
  assert.ok(worker.requested.every((request) => request.cache === 'reload'), 'install bypasses the HTTP cache');
  assert.match(worker.SHELL_CACHE, /^vokal-shell-[0-9a-f]{12}$/);
  assert.equal(worker.self.skipped, undefined, 'no skipWaiting at install');
});

test('install fails as a whole when one file fails', async () => {
  const worker = loadWorker({ failPath: 'js/guard.js' });
  const event = extendable();
  worker.listeners.install(event);
  await assert.rejects(event.done());
  const cache = await worker.caches.open(worker.SHELL_CACHE);
  assert.equal(cache.entries.size, 0);
});

test('activate deletes old vokal caches only, then claims clients', async () => {
  const worker = await installed();
  for (const name of ['vokal-shell-000000000000', 'vokal-old', 'transformers-cache', 'someone-else']) await worker.caches.open(name);
  const event = extendable();
  worker.listeners.activate(event);
  await event.done();
  assert.deepEqual((await worker.caches.keys()).sort(), [worker.SHELL_CACHE, 'someone-else', 'transformers-cache'].sort());
  assert.equal(worker.self.claimed, true);
});

const ROUTES = [
  ['POST to the suggestion server', { url: `${SCOPE}api/correct`, method: 'POST', mode: 'cors' }, 'pass'],
  ['GET of api/health', { url: `${SCOPE}api/health`, method: 'GET', mode: 'cors' }, 'pass'],
  ['navigation to the app', { url: SCOPE, method: 'GET', mode: 'navigate' }, 'navigate'],
  ['navigation with a query', { url: `${SCOPE}index.html?from=home`, method: 'GET', mode: 'navigate' }, 'navigate'],
  ['a shell script', { url: `${SCOPE}js/guard.js`, method: 'GET', mode: 'cors' }, 'shell'],
  ['a shell file with a query', { url: `${SCOPE}css/styles.css?v=2`, method: 'GET', mode: 'no-cors' }, 'shell'],
  ['the vendored library', { url: `${SCOPE}vendor/transformers.min.js`, method: 'GET', mode: 'cors' }, 'shell'],
  ['a local model file', { url: `${SCOPE}models/vokal-asr/onnx/encoder_model_quantized.onnx`, method: 'GET', mode: 'cors' }, 'pass'],
  ['a Hub model file', { url: 'https://huggingface.co/onnx-community/whisper-tiny.en/resolve/x/config.json', method: 'GET', mode: 'cors' }, 'pass'],
  ['the speech runtime', { url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0/dist/ort.wasm', method: 'GET', mode: 'cors' }, 'pass'],
  ['the Hub API', { url: 'https://huggingface.co/api/models/owner/name/revision/main', method: 'GET', mode: 'cors' }, 'pass'],
  ['same origin outside the scope', { url: 'https://warisback.github.io/other/index.html', method: 'GET', mode: 'cors' }, 'pass'],
  ['a file in the scope that is not in the shell', { url: `${SCOPE}tests/guard.test.js`, method: 'GET', mode: 'cors' }, 'pass'],
];

for (const [name, request, expected] of ROUTES) {
  test(`route: ${name} is ${expected}`, async () => {
    const worker = await installed();
    assert.equal(worker.context.route(request, SCOPE), expected);
    const event = fetchEvent(request);
    worker.listeners.fetch(event);
    if (expected === 'pass') {
      assert.equal(event.responded, null, 'respondWith is never called for pass-through requests');
    } else {
      const response = await event.responded;
      assert.equal(response.status, 200);
    }
  });
}

test('navigation answers with the cached index.html', async () => {
  const worker = await installed();
  const event = fetchEvent({ url: `${SCOPE}?utm=x`, method: 'GET', mode: 'navigate' });
  worker.listeners.fetch(event);
  assert.equal(await (await event.responded).text(), `body of ${SCOPE}index.html`);
});

test('a shell miss is fetched, stored and returned', async () => {
  const worker = await installed();
  const cache = await worker.caches.open(worker.SHELL_CACHE);
  const url = `${SCOPE}js/app.js`;
  cache.entries.delete(url);
  const before = worker.requested.length;
  const event = fetchEvent({ url, method: 'GET', mode: 'cors' });
  worker.listeners.fetch(event);
  assert.equal((await event.responded).status, 200);
  assert.equal(worker.requested.length, before + 1);
  assert.ok(await cache.match(url));
});

async function shellStatus(worker) {
  let reply = null;
  const event = extendable({ data: { type: 'SHELL_STATUS' }, ports: [{ postMessage(message) { reply = message; } }] });
  worker.listeners.message(event);
  await event.done();
  return reply;
}

test('SHELL_STATUS reports whether every shell file is cached', async () => {
  const worker = await installed();
  // The reply is built inside the vm context, so compare it as plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(await shellStatus(worker))), { type: 'SHELL_STATUS', complete: true, version: worker.VERSION });
  const cache = await worker.caches.open(worker.SHELL_CACHE);
  cache.entries.delete(`${SCOPE}icons/icon-512.png`);
  assert.equal((await shellStatus(worker)).complete, false);
});

test('SKIP_WAITING lets a waiting worker take over', async () => {
  const worker = await installed();
  worker.listeners.message(extendable({ data: { type: 'SKIP_WAITING' }, ports: [] }));
  assert.equal(worker.self.skipped, true);
});
