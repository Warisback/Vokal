import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ApiError } from '../lib/errors.js';
import {
  checkAccess,
  checkOrigin,
  corsHeaders,
  isLocalRequest,
  MAX_BODY_BYTES,
  readAccessConfig,
  readJsonBody,
} from '../lib/http.js';

const isCode = (code) => (error) => error instanceof ApiError && error.code === code;
const TOKEN = 'a-test-token-that-is-long-enough-1234';

function body(chunks, headers = { 'content-type': 'application/json' }) {
  const req = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  req.headers = headers;
  return req;
}

function fakeRequest({ remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress }, headers: { host: 'localhost:3210', ...headers } };
}

test('readJsonBody parses a streamed body and accepts a charset parameter', async () => {
  assert.deepEqual(await readJsonBody(body(['{"text":', '"Hello"}'])), { text: 'Hello' });
  const withCharset = body(['{"text":"Hi"}'], { 'content-type': 'Application/JSON; charset=utf-8' });
  assert.deepEqual(await readJsonBody(withCharset), { text: 'Hi' });
});

test('wrong or missing content type is 415 UNSUPPORTED_MEDIA_TYPE', async () => {
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', undefined]) {
    const headers = contentType ? { 'content-type': contentType } : {};
    await assert.rejects(readJsonBody(body(['{}'], headers)), isCode('UNSUPPORTED_MEDIA_TYPE'));
  }
});

test('a body over 64 KB is 413 BODY_TOO_LARGE, by declared length or by bytes read', async () => {
  assert.equal(MAX_BODY_BYTES, 65536);
  const declared = body(['{}'], { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) });
  await assert.rejects(readJsonBody(declared), isCode('BODY_TOO_LARGE'));
  const streamed = body([`{"text":"${'x'.repeat(40000)}`, `${'x'.repeat(40000)}"}`]);
  await assert.rejects(readJsonBody(streamed), isCode('BODY_TOO_LARGE'));
  const exact = `{"text":"${'x'.repeat(MAX_BODY_BYTES - 11)}"}`;
  assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES);
  assert.equal((await readJsonBody(body([exact]))).text.length, MAX_BODY_BYTES - 11);
});

test('invalid JSON, invalid UTF-8 and an empty body are 400 INVALID_JSON', async () => {
  await assert.rejects(readJsonBody(body(['{bad'])), isCode('INVALID_JSON'));
  await assert.rejects(readJsonBody(body([])), isCode('INVALID_JSON'));
  const badUtf8 = Readable.from([Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]);
  badUtf8.headers = { 'content-type': 'application/json' };
  await assert.rejects(readJsonBody(badUtf8), isCode('INVALID_JSON'));
});

test('a body that stops arriving is 408 REQUEST_TIMEOUT', async () => {
  const slow = new Readable({ read() {} });
  slow.headers = { 'content-type': 'application/json' };
  slow.push('{"text":');
  await assert.rejects(readJsonBody(slow, { timeoutMs: 20 }), isCode('REQUEST_TIMEOUT'));
});

test('origin rule: no Origin and same-origin requests pass without CORS', () => {
  assert.equal(checkOrigin(fakeRequest(), []), null);
  const sameSite = fakeRequest({ headers: { origin: 'http://localhost:3210', 'sec-fetch-site': 'same-origin' } });
  assert.equal(checkOrigin(sameSite, []), null);
  // The scheme is ignored: a page reached through an HTTPS tunnel posts to its own host.
  const tunnel = fakeRequest({ headers: { origin: 'https://abc.trycloudflare.com', host: 'abc.trycloudflare.com' } });
  assert.equal(checkOrigin(tunnel, []), null);
  const sameHost = fakeRequest({ headers: { origin: 'http://localhost:3210' } });
  assert.equal(checkOrigin(sameHost, []), null);
});

test('origin rule: a foreign origin is 403 FORBIDDEN_ORIGIN; a listed one passes with CORS', () => {
  const foreign = fakeRequest({ headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  assert.throws(() => checkOrigin(foreign, []), isCode('FORBIDDEN_ORIGIN'));
  assert.throws(() => checkOrigin(foreign, ['https://warisback.github.io']), isCode('FORBIDDEN_ORIGIN'));
  // A different port is a different origin.
  assert.throws(() => checkOrigin(fakeRequest({ headers: { origin: 'http://localhost:9999' } }), []), isCode('FORBIDDEN_ORIGIN'));
  assert.throws(() => checkOrigin(fakeRequest({ headers: { origin: 'null' } }), []), isCode('FORBIDDEN_ORIGIN'));

  const listed = fakeRequest({ headers: { origin: 'https://warisback.github.io', 'sec-fetch-site': 'cross-site' } });
  assert.equal(checkOrigin(listed, ['https://warisback.github.io']), 'https://warisback.github.io');
  const headers = corsHeaders('https://warisback.github.io', listed);
  assert.equal(headers['Access-Control-Allow-Origin'], 'https://warisback.github.io');
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
  assert.match(headers['Access-Control-Allow-Headers'], /Authorization/);
  assert.match(headers['Access-Control-Allow-Headers'], /Content-Type/);
  assert.equal(headers['Access-Control-Max-Age'], '600');
  assert.equal(headers['Access-Control-Allow-Private-Network'], undefined);
});

test('a preflight that asks for private network access gets the allow header', () => {
  const preflight = fakeRequest({ headers: { origin: 'https://warisback.github.io', 'access-control-request-private-network': 'true' } });
  assert.equal(corsHeaders('https://warisback.github.io', preflight)['Access-Control-Allow-Private-Network'], 'true');
});

test('locality: loopback socket and a local Host header, with no forwarding headers', () => {
  assert.equal(isLocalRequest(fakeRequest()), true);
  assert.equal(isLocalRequest(fakeRequest({ headers: { host: '127.0.0.1:3210' } })), true);
  assert.equal(isLocalRequest(fakeRequest({ headers: { host: 'LOCALHOST' } })), true);
  assert.equal(isLocalRequest(fakeRequest({ remoteAddress: '::1', headers: { host: '[::1]:3210' } })), true);
  assert.equal(isLocalRequest(fakeRequest({ remoteAddress: '::ffff:127.0.0.1' })), true);
  assert.equal(isLocalRequest(fakeRequest({ remoteAddress: '127.0.0.53' })), true);

  // A tunnel on this machine connects from loopback, but its Host header gives it away.
  assert.equal(isLocalRequest(fakeRequest({ headers: { host: 'example.trycloudflare.com' } })), false);
  // DNS rebinding: a foreign name pointed at 127.0.0.1.
  assert.equal(isLocalRequest(fakeRequest({ headers: { host: 'evil.example:3210' } })), false);
  assert.equal(isLocalRequest(fakeRequest({ headers: { host: 'localhost.evil.example' } })), false);
  assert.equal(isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false);
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip']) {
    assert.equal(isLocalRequest(fakeRequest({ headers: { [name]: '203.0.113.7' } })), false, name);
  }
  // A phone on the same network is not local.
  assert.equal(isLocalRequest(fakeRequest({ remoteAddress: '192.168.1.20' })), false);
  assert.equal(isLocalRequest(fakeRequest({ remoteAddress: '::ffff:192.168.1.20' })), false);
  assert.equal(isLocalRequest({ socket: {}, headers: { host: 'localhost:3210' } }), false);
});

test('server key: local requests need none; others need the token', () => {
  assert.doesNotThrow(() => checkAccess(fakeRequest(), null));
  assert.doesNotThrow(() => checkAccess(fakeRequest(), TOKEN));

  const remote = (authorization) => fakeRequest({
    remoteAddress: '192.168.1.20',
    headers: authorization ? { authorization } : {},
  });
  assert.throws(() => checkAccess(remote(), null), isCode('REMOTE_NOT_ALLOWED'));
  assert.throws(() => checkAccess(remote(`Bearer ${TOKEN}`), null), isCode('REMOTE_NOT_ALLOWED'));
  assert.throws(() => checkAccess(remote(), TOKEN), isCode('UNAUTHORIZED'));
  assert.throws(() => checkAccess(remote(`Bearer ${TOKEN}x`), TOKEN), isCode('UNAUTHORIZED'));
  assert.throws(() => checkAccess(remote(`Bearer ${TOKEN.slice(0, -1)}`), TOKEN), isCode('UNAUTHORIZED'));
  assert.throws(() => checkAccess(remote(`Basic ${TOKEN}`), TOKEN), isCode('UNAUTHORIZED'));
  assert.throws(() => checkAccess(remote(TOKEN), TOKEN), isCode('UNAUTHORIZED'));
  assert.doesNotThrow(() => checkAccess(remote(`Bearer ${TOKEN}`), TOKEN));
  assert.doesNotThrow(() => checkAccess(remote(`bearer ${TOKEN}`), TOKEN));
});

test('access settings: a short token or a malformed origin is INVALID_CONFIGURATION', () => {
  assert.deepEqual(readAccessConfig({}), { allowedOrigins: [], accessToken: null });
  assert.equal(readAccessConfig({ VOKAL_ACCESS_TOKEN: 'x'.repeat(24) }).accessToken, 'x'.repeat(24));
  assert.deepEqual(
    readAccessConfig({ VOKAL_ALLOWED_ORIGINS: ' https://warisback.github.io/ , http://localhost:5173,' }).allowedOrigins,
    ['https://warisback.github.io', 'http://localhost:5173'],
  );
  const invalid = [
    [{ VOKAL_ACCESS_TOKEN: 'x'.repeat(23) }, 'VOKAL_ACCESS_TOKEN'],
    [{ VOKAL_ACCESS_TOKEN: `${'x'.repeat(24)} space` }, 'VOKAL_ACCESS_TOKEN'],
    [{ VOKAL_ALLOWED_ORIGINS: 'https://warisback.github.io/Vokal/' }, 'VOKAL_ALLOWED_ORIGINS'],
    [{ VOKAL_ALLOWED_ORIGINS: '*' }, 'VOKAL_ALLOWED_ORIGINS'],
    [{ VOKAL_ALLOWED_ORIGINS: 'warisback.github.io' }, 'VOKAL_ALLOWED_ORIGINS'],
  ];
  for (const [env, field] of invalid) {
    assert.throws(() => readAccessConfig(env), (error) => isCode('INVALID_CONFIGURATION')(error) && error.field === field, JSON.stringify(env));
  }
});
