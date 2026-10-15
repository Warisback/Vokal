import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../lib/errors.js';
import { DATA_POLICY } from '../lib/static.js';
import { DEFAULT_APP_DIR, parseFlags } from '../server.mjs';
import { fakeProvider, proposal, request, startServer, tempDir, writeFiles } from './helpers.js';

const SERVER_FILE = fileURLToPath(new URL('../server.mjs', import.meta.url));
const ORIGIN = 'https://warisback.github.io';
const TOKEN = randomBytes(24).toString('base64url');
const phrases = [{ heard: 'I need wader', intended: 'I need water' }];

function post(path, body, headers = {}) {
  return { method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body };
}

test('GET api/health reports the provider and model without calling it', async (t) => {
  const provider = fakeProvider();
  const { port } = await startServer(t, { provider });
  const res = await request(port, { path: '/api/health' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, correction: { configured: true, provider: 'fake', model: 'fake-model' } });
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-security-policy'], DATA_POLICY);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(provider.calls.length, 0);
});

test('with no model settings, health says not configured and a suggestion is 503 NOT_CONFIGURED', async (t) => {
  const { port, logs } = await startServer(t, { env: {} });
  const health = await request(port, { path: '/api/health' });
  assert.deepEqual(health.json, { ok: true, correction: { configured: false, provider: 'google', model: 'gemma-4-26b-a4b-it' } });
  const res = await request(port, post('/api/correct', { text: 'Hello' }));
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: { code: 'NOT_CONFIGURED', message: 'The suggestion server has no language model configured.' } });
  assert.deepEqual(logs, ['503 NOT_CONFIGURED']);
});

test('POST api/correct round trip under a base path', async (t) => {
  const provider = fakeProvider([proposal('I need water')]);
  const { port, logs } = await startServer(t, { provider, base: '/Vokal/' });
  const res = await request(port, post('/Vokal/api/correct', { text: 'I need wader', phrases }));
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json.raw, 'I need wader');
  assert.equal(res.json.suggested, 'I need water');
  assert.equal(res.json.changed, true);
  assert.equal(res.json.degraded, false);
  assert.equal(res.json.model, 'fake-model');
  assert.equal(typeof res.json.timing.correction_ms, 'number');
  assert.deepEqual(JSON.parse(provider.calls[0].data), { transcript: 'I need wader', examples: phrases });
  assert.deepEqual(logs, []);
});

test('a degraded suggestion is still 200 and is logged by its reason only', async (t) => {
  const provider = fakeProvider([new ApiError('PROVIDER_QUOTA')]);
  const { port, logs } = await startServer(t, { provider });
  const res = await request(port, post('/api/correct', { text: 'I need wader' }));
  assert.equal(res.status, 200);
  assert.equal(res.json.degraded, true);
  assert.equal(res.json.reason, 'PROVIDER_QUOTA');
  assert.equal(res.json.suggested, 'I need wader');
  assert.deepEqual(logs, ['200 degraded PROVIDER_QUOTA']);
});

test('unknown api paths are 404 JSON and wrong methods are 405 with Allow', async (t) => {
  const { port } = await startServer(t, { provider: fakeProvider() });
  for (const target of ['/api/nothing', '/api', '/api/', '/api/correct/extra']) {
    const res = await request(port, { path: target });
    assert.equal(res.status, 404, target);
    assert.equal(res.json.error.code, 'NOT_FOUND', target);
  }
  const getCorrect = await request(port, { path: '/api/correct' });
  assert.equal(getCorrect.status, 405);
  assert.equal(getCorrect.headers.allow, 'POST, OPTIONS');
  assert.equal(getCorrect.json.error.code, 'METHOD_NOT_ALLOWED');
  const postHealth = await request(port, post('/api/health', {}));
  assert.equal(postHealth.status, 405);
  assert.equal(postHealth.headers.allow, 'GET, OPTIONS');
});

test('request errors through the server: 415, 413 and 400, with no provider call', async (t) => {
  const provider = fakeProvider();
  const { port } = await startServer(t, { provider });
  const wrongType = await request(port, { method: 'POST', path: '/api/correct', headers: { 'content-type': 'text/plain' }, body: 'Hello' });
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.json.error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const large = await request(port, post('/api/correct', { text: 'x'.repeat(70000) }));
  assert.equal(large.status, 413);
  assert.equal(large.json.error.code, 'BODY_TOO_LARGE');

  const badJson = await request(port, post('/api/correct', '{"text":'));
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.code, 'INVALID_JSON');

  const badField = await request(port, post('/api/correct', { text: 'Hello', mode: 'conversation' }));
  assert.equal(badField.status, 400);
  assert.equal(badField.json.error.code, 'INVALID_REQUEST');
  assert.equal(provider.calls.length, 0);
});

test('CORS: a listed origin gets a preflight and CORS headers; a foreign origin is 403', async (t) => {
  const provider = fakeProvider([proposal('Hello')]);
  const { port } = await startServer(t, { provider, env: { VOKAL_ALLOWED_ORIGINS: ORIGIN } });

  const preflight = await request(port, {
    method: 'OPTIONS',
    path: '/api/correct',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
      'access-control-request-private-network': 'true',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
  assert.match(preflight.headers['access-control-allow-headers'], /Authorization/);
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
  assert.equal(preflight.headers.vary, 'Origin');

  const listed = await request(port, post('/api/correct', { text: 'Hello' }, { origin: ORIGIN }));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers['access-control-allow-origin'], ORIGIN);

  const foreign = await request(port, post('/api/correct', { text: 'Hello' }, { origin: 'https://evil.example' }));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.json.error.code, 'FORBIDDEN_ORIGIN');
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  const foreignPreflight = await request(port, { method: 'OPTIONS', path: '/api/correct', headers: { origin: 'https://evil.example' } });
  assert.equal(foreignPreflight.status, 403);
  assert.equal(provider.calls.length, 1);
});

test('a request that is not local needs the server key', async (t) => {
  const tunnel = { host: 'abc.trycloudflare.com', origin: 'https://abc.trycloudflare.com' };

  const closed = await startServer(t, { provider: fakeProvider() });
  const refused = await request(closed.port, { path: '/api/health', headers: tunnel });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, 'REMOTE_NOT_ALLOWED');
  const forwarded = await request(closed.port, { path: '/api/health', headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(forwarded.status, 403);

  const open = await startServer(t, { provider: fakeProvider([proposal('Hello')]), env: { VOKAL_ACCESS_TOKEN: TOKEN } });
  const missing = await request(open.port, { path: '/api/health', headers: tunnel });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers['www-authenticate'], 'Bearer');
  assert.deepEqual(missing.json, { error: { code: 'UNAUTHORIZED', message: 'Missing or wrong server key.' } });
  const wrong = await request(open.port, { path: '/api/health', headers: { ...tunnel, authorization: `Bearer ${TOKEN}x` } });
  assert.equal(wrong.status, 401);
  const right = await request(open.port, post('/api/correct', { text: 'Hello' }, { ...tunnel, authorization: `Bearer ${TOKEN}` }));
  assert.equal(right.status, 200);
  // Requests from this computer need no key, and static files never do.
  assert.equal((await request(open.port, { path: '/api/health' })).status, 200);
  assert.equal((await request(open.port, { path: '/missing.js', headers: tunnel })).status, 404);
});

test('an invalid setting turns the API off, keeps static files, and names the variable not its value', async (t) => {
  const appDir = tempDir(t);
  writeFiles(appDir, { 'index.html': '<!doctype html>' });
  const { port, logs } = await startServer(t, { appDir, env: { VOKAL_ACCESS_TOKEN: 'too-short-secret' } });
  const health = await request(port, { path: '/api/health' });
  assert.equal(health.status, 503);
  assert.equal(health.json.error.code, 'INVALID_CONFIGURATION');
  assert.equal((await request(port, { path: '/' })).status, 200);
  assert.match(logs[0], /VOKAL_ACCESS_TOKEN is not valid/);
  assert.equal(logs.join('\n').includes('too-short-secret'), false);
});

test('responses and logs never contain the key, the token or the words', async (t) => {
  const key = randomBytes(18).toString('hex');
  const words = 'I need wader';
  const seenKeys = [];
  // The real Google client with a fake fetch: the whole path runs with no network.
  let calls = 0;
  const fetchImpl = async (url, init) => {
    seenKeys.push(init.headers['x-goog-api-key']);
    calls += 1;
    if (calls === 2) return new Response(`echo ${key} ${words}`, { status: 500 });
    const text = proposal('I need water');
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }), { status: 200 });
  };
  const env = { GOOGLE_API_KEY: key, VOKAL_ACCESS_TOKEN: TOKEN, VOKAL_ALLOWED_ORIGINS: ORIGIN };
  const { port, logs } = await startServer(t, { env, fetchImpl });

  const remote = { host: 'abc.trycloudflare.com' };
  const replies = [
    await request(port, { path: '/api/health' }),
    await request(port, post('/api/correct', { text: words, phrases })),
    await request(port, post('/api/correct', { text: words, phrases })),
    await request(port, post('/api/correct', { text: words }, { ...remote })),
    await request(port, post('/api/correct', { text: words }, { ...remote, authorization: `Bearer ${TOKEN.slice(1)}` })),
    await request(port, post('/api/correct', { text: words }, { ...remote, authorization: `Bearer ${TOKEN}`, origin: ORIGIN })),
    await request(port, post('/api/correct', { text: words, extra: key })),
  ];
  assert.deepEqual(replies.map((reply) => reply.status), [200, 200, 200, 401, 401, 200, 400]);
  assert.equal(replies[1].json.suggested, 'I need water');
  assert.equal(replies[2].json.reason, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(seenKeys, [key, key, key]);

  for (const reply of replies) {
    const everything = reply.text + JSON.stringify(reply.headers);
    assert.equal(everything.includes(key), false);
    assert.equal(everything.includes(TOKEN), false);
  }
  const logText = logs.join('\n');
  for (const secret of [key, TOKEN, TOKEN.slice(1), words, 'I need water']) {
    assert.equal(logText.includes(secret), false, 'log line leaked a value');
  }
});

test('parseFlags: defaults, PORT, and refusals', () => {
  const defaults = parseFlags([], {});
  assert.equal(defaults.port, 3210);
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.base, '/');
  assert.equal(defaults.isolate, false);
  assert.equal(defaults.appDir, path.resolve(DEFAULT_APP_DIR));
  assert.equal(defaults.modelsDir, path.join(path.resolve(DEFAULT_APP_DIR), 'models'));

  assert.equal(parseFlags([], { PORT: '4000' }).port, 4000);
  const flags = parseFlags(['--port', '0', '--base', '/Vokal/', '--models', 'some/models', '--isolate'], { PORT: '4000' });
  assert.equal(flags.port, 0);
  assert.equal(flags.base, '/Vokal/');
  assert.equal(flags.modelsDir, path.resolve('some/models'));
  assert.equal(flags.isolate, true);
  assert.equal(parseFlags(['--port=8080', '--base=/a/b/'], {}).port, 8080);

  const refused = [
    ['--base', 'Vokal'], ['--base', '/Vokal'], ['--base', '/../'], ['--base', '//'], ['--base', '/a b/'],
    ['--port', 'abc'], ['--port', '70000'], ['--port', '-1'], ['--unknown'], ['extra'],
  ];
  for (const argv of refused) assert.throws(() => parseFlags(argv, {}), Error, argv.join(' '));
});

test('node server.mjs --port 0 prints the startup line and serves the app', async (t) => {
  const root = tempDir(t);
  const appDir = path.join(root, 'app');
  writeFiles(appDir, { 'index.html': '<!doctype html><title>Vokal</title>' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VOKAL_|GOOGLE_API_KEY$|PORT$)/.test(name)));
  const child = spawn(process.execPath, [SERVER_FILE, '--port', '0', '--base', '/Vokal/', '--app', appDir, '--models', path.join(root, 'models')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());

  const line = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no startup line: ${output}`)), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/^Vokal server: http:\/\/127\.0\.0\.1:(\d+)\/Vokal\/\r?$/m);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
  const port = Number(line[1]);
  assert.ok(port > 0);
  assert.equal((await request(port, { path: '/Vokal/' })).status, 200);
  assert.deepEqual((await request(port, { path: '/Vokal/api/health' })).json.correction.configured, false);
});

test('node server.mjs refuses a bad base with exit code 2', async () => {
  const child = spawn(process.execPath, [SERVER_FILE, '--base', 'Vokal'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /--base must start and end with "\/"/);
});
