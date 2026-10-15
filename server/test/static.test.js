import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DATA_POLICY, PAGE_POLICY, SCRIPT_POLICY } from '../lib/static.js';
import { request, startServer, tempDir, writeFiles } from './helpers.js';

const SECRET = 'outside-the-app-folder';
const ONNX_BYTES = Buffer.from([0x08, 0x07, 0x12, 0x00, 0xff, 0x10]);

function layout(t) {
  const root = tempDir(t);
  const appDir = path.join(root, 'app');
  const modelsDir = path.join(root, 'models');
  writeFiles(appDir, {
    'index.html': '<!doctype html><title>Vokal</title>',
    'js/app.js': 'export const app = 1;\n',
    'js/asr-worker.js': 'self.onmessage = () => {};\n',
    'css/styles.css': 'body { margin: 0; }\n',
    'app.webmanifest': '{"id":"./"}',
    'icons/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'icons/icon-192.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'data.json': '{"ok":true}',
    'vendor/LICENSE': 'Apache-2.0',
    'notes.xyz': 'unknown type',
    '.hidden.json': '{"hidden":true}',
    '.git/config.json': '{"hidden":true}',
    'sub/readme.txt': 'no index here',
    'models/vokal-asr/config.json': '{"from":"app"}',
  });
  writeFiles(modelsDir, {
    'vokal-asr/config.json': '{"from":"models"}',
    'vokal-asr/onnx/encoder_model_quantized.onnx': ONNX_BYTES,
  });
  writeFiles(root, { 'secret.txt': SECRET, 'outside/secret.txt': SECRET });
  return { root, appDir, modelsDir };
}

async function serve(t, options = {}) {
  const dirs = layout(t);
  const { port } = await startServer(t, { appDir: dirs.appDir, modelsDir: dirs.modelsDir, base: '/Vokal/', ...options });
  return { ...dirs, get: (target, extra = {}) => request(port, { path: target, ...extra }) };
}

test('the base without its slash redirects, and the base serves index.html', async (t) => {
  const { get } = await serve(t);
  const redirect = await get('/Vokal');
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, '/Vokal/');
  assert.equal((await get('/Vokal?x=1')).headers.location, '/Vokal/?x=1');

  const index = await get('/Vokal/');
  assert.equal(index.status, 200);
  assert.equal(index.text, '<!doctype html><title>Vokal</title>');
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal((await get('/Vokal/?v=2')).status, 200);
  assert.equal((await get('/Vokal/index.html')).text, index.text);
});

test('MIME types and policies follow the extension', async (t) => {
  const { get } = await serve(t);
  const table = [
    ['/Vokal/index.html', 'text/html; charset=utf-8', PAGE_POLICY],
    ['/Vokal/js/app.js', 'text/javascript; charset=utf-8', SCRIPT_POLICY],
    ['/Vokal/js/asr-worker.js', 'text/javascript; charset=utf-8', SCRIPT_POLICY],
    ['/Vokal/css/styles.css', 'text/css; charset=utf-8', DATA_POLICY],
    ['/Vokal/app.webmanifest', 'application/manifest+json; charset=utf-8', DATA_POLICY],
    ['/Vokal/icons/icon.svg', 'image/svg+xml', DATA_POLICY],
    ['/Vokal/icons/icon-192.png', 'image/png', DATA_POLICY],
    ['/Vokal/data.json', 'application/json; charset=utf-8', DATA_POLICY],
    ['/Vokal/sub/readme.txt', 'text/plain; charset=utf-8', DATA_POLICY],
  ];
  for (const [target, type, policy] of table) {
    const res = await get(target);
    assert.equal(res.status, 200, target);
    assert.equal(res.headers['content-type'], type, target);
    assert.equal(res.headers['content-security-policy'], policy, target);
    assert.equal(res.headers['cache-control'], 'no-cache', target);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', target);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', target);
    assert.equal(res.headers['permissions-policy'], 'microphone=(self), camera=(), geolocation=()', target);
    assert.equal(res.headers['cross-origin-opener-policy'], undefined, target);
  }
});

test('the script policy lists only the runtime and model hosts; the page policy adds frame-ancestors', () => {
  assert.match(PAGE_POLICY, /frame-ancestors 'none'/);
  assert.match(PAGE_POLICY, /script-src 'self';/);
  assert.match(SCRIPT_POLICY, /script-src 'self' blob: 'wasm-unsafe-eval' https:\/\/cdn\.jsdelivr\.net;/);
  assert.match(SCRIPT_POLICY, /connect-src 'self' https:\/\/huggingface\.co https:\/\/\*\.huggingface\.co https:\/\/\*\.hf\.co https:\/\/cdn\.jsdelivr\.net;/);
  assert.doesNotMatch(SCRIPT_POLICY, /connect-src[^;]* https:(?:;| )/);
  assert.doesNotMatch(SCRIPT_POLICY, /'unsafe-eval'|'unsafe-inline'/);
});

test('HEAD sends the headers and no body', async (t) => {
  const { get } = await serve(t);
  const head = await get('/Vokal/js/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], String(Buffer.byteLength('export const app = 1;\n')));
  assert.equal(head.text, '');
});

test('other methods on static files are 405 with Allow', async (t) => {
  const { get } = await serve(t);
  const res = await get('/Vokal/index.html', { method: 'POST' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('traversal, encoded traversal, NUL, backslashes and colons are 404', async (t) => {
  const { get } = await serve(t);
  const attempts = [
    '/Vokal/../secret.txt',
    '/Vokal/%2e%2e/secret.txt',
    '/Vokal/%2E%2E/secret.txt',
    '/Vokal/..%2fsecret.txt',
    '/Vokal/%2e%2e%2fsecret.txt',
    '/Vokal/..%5csecret.txt',
    '/Vokal/js/..%2f..%2fsecret.txt',
    '/Vokal/models/..%2f..%2fsecret.txt',
    '/Vokal/models/%2e%2e/%2e%2e/secret.txt',
    '/Vokal/%00index.html',
    '/Vokal/index.html%00.txt',
    '/Vokal/index.html::$DATA',
    '/Vokal/C:%5cWindows%5cwin.ini',
    '/Vokal/%E0%A4%A',
    '/Vokal//index.html',
    '/Vokal/js//app.js',
    '//secret.txt',
  ];
  for (const target of attempts) {
    const res = await get(target);
    assert.equal(res.status, 404, target);
    assert.equal(res.text.includes(SECRET), false, target);
  }
});

test('dotfiles, unknown extensions, folders and paths outside the base are 404', async (t) => {
  const { get } = await serve(t);
  const missing = [
    '/Vokal/.hidden.json',
    '/Vokal/%2ehidden.json',
    '/Vokal/.git/config.json',
    '/Vokal/notes.xyz',
    '/Vokal/vendor/LICENSE',
    '/Vokal/index.html.',
    '/Vokal/index.html%20',
    '/Vokal/sub/',
    '/Vokal/sub',
    '/Vokal/js',
    '/Vokal/missing.js',
    '/index.html',
    '/Vokalx/index.html',
    '/other/Vokal/index.html',
  ];
  for (const target of missing) {
    const res = await get(target);
    assert.equal(res.status, 404, target);
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8', target);
    assert.equal(res.headers['content-security-policy'], DATA_POLICY, target);
  }
});

test('models/ comes from the --models folder, byte for byte', async (t) => {
  const { get } = await serve(t);
  const config = await get('/Vokal/models/vokal-asr/config.json');
  assert.equal(config.status, 200);
  assert.equal(config.text, '{"from":"models"}');
  const onnx = await get('/Vokal/models/vokal-asr/onnx/encoder_model_quantized.onnx');
  assert.equal(onnx.status, 200);
  assert.equal(onnx.headers['content-type'], 'application/octet-stream');
  assert.equal(onnx.headers['content-length'], String(ONNX_BYTES.length));
  assert.equal((await get('/Vokal/models/vokal-asr/missing.onnx')).status, 404);
});

test('without --models, models/ comes from the app folder', async (t) => {
  const { get } = await serve(t, { modelsDir: undefined });
  assert.equal((await get('/Vokal/models/vokal-asr/config.json')).text, '{"from":"app"}');
});

test('a base of / serves from the root', async (t) => {
  const { get } = await serve(t, { base: '/' });
  assert.equal((await get('/')).status, 200);
  assert.equal((await get('/js/app.js')).status, 200);
  assert.equal((await get('/Vokal/')).status, 404);
});

test('--isolate adds COOP, COEP and CORP', async (t) => {
  const { get } = await serve(t, { isolate: true });
  for (const target of ['/Vokal/', '/Vokal/js/app.js', '/Vokal/missing.js', '/Vokal/api/health']) {
    const res = await get(target);
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', target);
    assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp', target);
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin', target);
  }
});

test('a link inside the app folder cannot lead outside it', async (t) => {
  const { root, appDir, get } = await serve(t);
  try {
    // A directory junction needs no special rights on Windows; elsewhere this is a symlink.
    symlinkSync(path.join(root, 'outside'), path.join(appDir, 'linked'), 'junction');
  } catch (error) {
    t.skip(`could not create a link here (${error.code})`);
    return;
  }
  const res = await get('/Vokal/linked/secret.txt');
  assert.equal(res.status, 404);
  assert.equal(res.text.includes(SECRET), false);
});

test('the page policy matches the CSP meta tag in app/index.html', (t) => {
  const indexFile = fileURLToPath(new URL('../../app/index.html', import.meta.url));
  if (!existsSync(indexFile)) {
    t.skip('app/index.html is not present');
    return;
  }
  const html = readFileSync(indexFile, 'utf8');
  const meta = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i);
  assert.ok(meta, 'app/index.html has a CSP meta tag');
  const content = meta[0].match(/\bcontent=(["'])([\s\S]*?)\1/i)[2];
  const directives = (policy) => policy.split(';').map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const header = directives(PAGE_POLICY).filter((directive) => !directive.startsWith('frame-ancestors'));
  assert.deepEqual(directives(content), header,
    'The meta policy changed. Update PAGE_POLICY in server/lib/static.js to match it.');
});

test('a missing app file or models folder is a 404, not a crash', async (t) => {
  const root = tempDir(t);
  const appDir = path.join(root, 'app');
  mkdirSync(appDir);
  const { port } = await startServer(t, { appDir, modelsDir: path.join(root, 'no-such-folder'), base: '/Vokal/' });
  assert.equal((await request(port, { path: '/Vokal/models/x/config.json' })).status, 404);
  assert.equal((await request(port, { path: '/Vokal/' })).status, 404);
});
