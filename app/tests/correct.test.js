import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORRECT_MESSAGES, createCorrector } from '../js/correct.js';

const ENDPOINT = 'https://vokal.test/api/correct';
const HEALTH = 'https://vokal.test/api/health';
const PHRASES = [{ id: 'p-1', heard: 'Water please.', intended: 'Water, please.', model: { id: 'm' }, at: 'x' }];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, fetchImpl };
}

const OK = { raw: 'I need wader', suggested: 'I need water', changed: true, uncertain: false, degraded: false, reason: null, note: 'Suggested fix only. Check the words before speaking.', model: 'm', timing: { correction_ms: 10 } };

test('the request body has only text and phrases with heard and intended', async () => {
  const { calls, fetchImpl } = recorder(() => json(OK));
  const corrector = createCorrector({ fetchImpl });
  const result = await corrector.suggest({ text: 'I need wader', phrases: PHRASES, endpoint: ENDPOINT });
  assert.equal(result.suggested, 'I need water');
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'I need wader', phrases: [{ heard: 'Water please.', intended: 'Water, please.' }] });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'no key, no header');
  assert.equal(calls[0].init.redirect, 'error');
});

test('the server key is sent as a bearer token only when set', async () => {
  const { calls, fetchImpl } = recorder(() => json(OK));
  const corrector = createCorrector({ fetchImpl });
  await corrector.suggest({ text: 'x', endpoint: ENDPOINT, key: 'k3y' });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k3y');
  await corrector.health(HEALTH, 'k3y');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer k3y');
  assert.equal(calls[1].init.method, 'GET');
});

test('a slow server is aborted at timeoutMs', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const corrector = createCorrector({ fetchImpl, timeoutMs: 30 });
  const started = Date.now();
  const result = await corrector.suggest({ text: 'x', endpoint: ENDPOINT });
  assert.deepEqual(result, { error: { code: 'NETWORK', message: CORRECT_MESSAGES.NETWORK } });
  assert.ok(Date.now() - started < 1000);
});

test('a network failure gives the unreachable message and does not stop requests', async () => {
  let calls = 0;
  const corrector = createCorrector({ fetchImpl: async () => { calls++; throw new TypeError('Failed to fetch'); } });
  assert.equal((await corrector.suggest({ text: 'x', endpoint: ENDPOINT })).error.message, 'Could not reach the suggestion server.');
  await corrector.suggest({ text: 'x', endpoint: ENDPOINT });
  assert.equal(calls, 2);
  assert.equal(corrector.stopped, null);
});

const STOPPERS = [
  ['503 NOT_CONFIGURED', () => json({ error: { code: 'NOT_CONFIGURED', message: 'x' } }, 503), 'NOT_CONFIGURED', 'The suggestion server has no model configured.'],
  ['404', () => json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404), 'NO_SERVER', 'No suggestion server at this address.'],
  ['200 HTML page', () => new Response('<!doctype html><title>404</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'NO_SERVER', 'No suggestion server at this address.'],
  ['404 HTML page', () => new Response('<!doctype html>', { status: 404 }), 'NO_SERVER', 'No suggestion server at this address.'],
  ['401', () => json({ error: { code: 'UNAUTHORIZED', message: 'Missing or wrong server key.' } }, 401), 'UNAUTHORIZED', 'The server key is not right.'],
];

for (const [name, respond, code, message] of STOPPERS) {
  test(`${name} maps to ${code} and stops further requests until reset`, async () => {
    const { calls, fetchImpl } = recorder(respond);
    const corrector = createCorrector({ fetchImpl });
    assert.deepEqual(await corrector.suggest({ text: 'x', endpoint: ENDPOINT }), { error: { code, message } });
    assert.equal(corrector.stopped, code);
    await corrector.suggest({ text: 'x', endpoint: ENDPOINT });
    assert.equal(calls.length, 1, 'no second request');
    corrector.reset();
    await corrector.suggest({ text: 'x', endpoint: ENDPOINT });
    assert.equal(calls.length, 2);
  });
}

test('403 passes on the server message for origin and remote errors', async () => {
  const message = 'This server only answers this computer. Set VOKAL_ACCESS_TOKEN to allow other devices.';
  const corrector = createCorrector({ fetchImpl: async () => json({ error: { code: 'REMOTE_NOT_ALLOWED', message } }, 403) });
  assert.deepEqual(await corrector.suggest({ text: 'x', endpoint: ENDPOINT }), { error: { code: 'REMOTE_NOT_ALLOWED', message } });
  assert.equal(corrector.stopped, null);
});

test('degraded results pass through unchanged', async () => {
  const degraded = { ...OK, suggested: OK.raw, changed: false, uncertain: true, degraded: true, reason: 'PROVIDER_TIMEOUT', note: 'The suggestion took too long.' };
  const corrector = createCorrector({ fetchImpl: async () => json(degraded) });
  const result = await corrector.suggest({ text: OK.raw, endpoint: ENDPOINT });
  assert.equal(result.degraded, true);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'PROVIDER_TIMEOUT');
  assert.equal(result.suggested, OK.raw);
});

test('a JSON reply without the expected fields is reported, not used', async () => {
  const corrector = createCorrector({ fetchImpl: async () => json({ hello: 'world' }) });
  assert.equal((await corrector.suggest({ text: 'x', endpoint: ENDPOINT })).error.code, 'BAD_RESPONSE');
});

test('health reports configuration and maps errors without stopping suggestions', async () => {
  const configured = createCorrector({ fetchImpl: async () => json({ ok: true, correction: { configured: true, provider: 'google', model: 'm' } }) });
  assert.deepEqual(await configured.health(HEALTH), { ok: true, configured: true, provider: 'google', model: 'm' });
  const bare = createCorrector({ fetchImpl: async () => json({ ok: true, correction: { configured: false } }) });
  assert.equal((await bare.health(HEALTH)).configured, false);
  const missing = createCorrector({ fetchImpl: async () => new Response('<html>', { status: 404 }) });
  assert.equal((await missing.health(HEALTH)).error.code, 'NO_SERVER');
  assert.equal(missing.stopped, null);
});
