// Checks on the files themselves: relative URLs, the shell list and its hash, the
// vendored library, the page security policy, ids, the manifest and the copy rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFileSync(path.join(APP, relative), 'utf8');
const VENDOR_SHA256 = '1475fd440e9932ab206682ee42cb18f6097403e9ee77ea62084c592d0f83597d';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; worker-src 'self'; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'none'";
const TEXT_TYPES = new Set(['.html', '.js', '.css', '.webmanifest', '.svg']);

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue; // playwright-core for the browser test, once installed
    const full = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, relative));
    else out.push(relative);
  }
  return out;
}

// Development files that are not part of the installed app.
const NOT_SHELL = (file) => file === 'sw.js' || file === 'vendor/LICENSE' || file === 'package.json' ||
  file === 'package-lock.json' || file.startsWith('tests/');
const ALL_FILES = listFiles(APP);
const OWN_TEXT_FILES = ALL_FILES.filter((file) => !file.startsWith('vendor/') && /\.(html|js|css|webmanifest|svg|json)$/.test(file));

function swConstants() {
  const context = vm.createContext({ self: { addEventListener() {}, registration: { scope: 'https://x.test/' } }, URL });
  vm.runInContext(read('sw.js'), context);
  return vm.runInContext('({ PRECACHE, VERSION, SHELL_HASH, SHELL_CACHE })', context);
}

function shellHash(precache) {
  const hash = createHash('sha256');
  for (const entry of precache) {
    if (entry === './') continue;
    let bytes = readFileSync(path.join(APP, entry));
    if (TEXT_TYPES.has(path.extname(entry))) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    hash.update(Buffer.from(`${entry}\n`, 'utf8'));
    hash.update(bytes);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function assertRelative(url, where) {
  assert.ok(!url.startsWith('/'), `${where}: ${url} starts with /`);
  assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(url), `${where}: ${url} is absolute`);
}

test('the shell list equals the app files on disk', () => {
  const { PRECACHE } = swConstants();
  assert.equal(PRECACHE[0], './');
  assert.deepEqual([...PRECACHE.slice(1)].sort(), ALL_FILES.filter((file) => !NOT_SHELL(file)).sort());
});

test('SHELL_HASH matches the shell files', () => {
  const { PRECACHE, SHELL_HASH, SHELL_CACHE } = swConstants();
  const expected = shellHash(PRECACHE);
  assert.equal(SHELL_HASH, expected, `SHELL_HASH should be ${expected}. Update SHELL_HASH and bump VERSION and APP_VERSION.`);
  assert.equal(SHELL_CACHE, `vokal-shell-${expected.slice(0, 12)}`);
});

test('the service worker version equals the app version', () => {
  const { VERSION } = swConstants();
  const appVersion = /export const APP_VERSION = '([^']+)'/.exec(read('js/app.js'));
  assert.ok(appVersion, 'APP_VERSION is declared in app.js');
  assert.equal(VERSION, appVersion[1]);
});

test('the vendored library is the pinned file, byte for byte', () => {
  const digest = createHash('sha256').update(readFileSync(path.join(APP, 'vendor/transformers.min.js'))).digest('hex');
  assert.equal(digest, VENDOR_SHA256);
  assert.ok(ALL_FILES.includes('vendor/LICENSE'));
});

test('every URL is relative', () => {
  const html = read('index.html');
  for (const [, url] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    if (!url.startsWith('#')) assertRelative(url, 'index.html');
  }
  for (const [, url] of read('css/styles.css').matchAll(/url\(\s*['"]?([^'")]+)/g)) assertRelative(url, 'styles.css');
  const scripts = ALL_FILES.filter((file) => file.endsWith('.js') && !file.startsWith('vendor/') && !file.startsWith('tests/'));
  for (const file of scripts) {
    const source = read(file);
    const patterns = [/\bfrom\s+'([^']+)'/g, /\bimport\(\s*'([^']+)'/g, /new URL\(\s*'([^']+)'/g, /\bfetch\(\s*'([^']+)'/g, /\.register\(\s*'([^']+)'/g];
    for (const pattern of patterns) {
      for (const [, url] of source.matchAll(pattern)) assertRelative(url, file);
    }
    // The one absolute URL allowed in app code is the Hub API base, in models.js.
    // support.js uses an unparseable URL on purpose: nothing is ever fetched.
    const allowed = ["js/models.js 'https://huggingface.co/api/models/'", "js/support.js 'http://['"];
    for (const [literal] of source.matchAll(/['"`]https?:\/\/[^'"`]*['"`]/g)) {
      assert.ok(allowed.includes(`${file} ${literal}`), `${file} has the absolute URL ${literal}`);
    }
  }
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const url of [manifest.id, manifest.start_url, manifest.scope, ...manifest.icons.map((icon) => icon.src)]) {
    assertRelative(url, 'manifest.webmanifest');
  }
});

test('the manifest parses, points at icons that exist, and stays in its folder', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.id, './');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(ALL_FILES.includes(icon.src), icon.src);
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
});

test('the page carries the exact security policy, the favicon and the manifest link', () => {
  const html = read('index.html');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(meta, 'CSP meta tag present');
  assert.equal(meta[1], CSP);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'), 'the policy comes before any script');
  assert.match(html, /<link rel="icon" href="icons\/icon\.svg"/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<html lang="en-GB">/);
  assert.ok(html.indexOf('js/support.js') < html.indexOf('js/app.js'), 'support.js runs first');
});

test('no inline styles, no inline scripts, no HTML injection sinks', () => {
  const html = read('index.html');
  assert.ok(!html.includes('style="'), 'no style attributes (the CSP blocks them)');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline scripts');
  assert.ok(!/\son[a-z]+="/.test(html), 'no inline event handlers');
  for (const file of ALL_FILES.filter((f) => f.startsWith('js/') || f === 'sw.js')) {
    const source = read(file);
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      assert.ok(!source.includes(sink), `${file} uses ${sink}`);
    }
    assert.ok(!source.includes("setAttribute('style'"), `${file} sets a style attribute`);
    // Lookbehind is a parse error on Safari before 16.4.
    assert.ok(!source.includes('(?<=') && !source.includes('(?<!'), `${file} uses regex lookbehind`);
  }
});

test('every id the scripts look up exists in the page', () => {
  const html = read('index.html');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const file of ['js/app.js', 'js/onboarding.js']) {
    for (const [, id] of read(file).matchAll(/byId\('([^']+)'\)/g)) assert.ok(ids.has(id), `${file} looks up #${id}`);
  }
  for (const screen of ['welcome', 'setup', 'talk']) {
    assert.ok(ids.has(`screen-${screen}`) && ids.has(`${screen}-title`), screen);
  }
  for (const step of ['home', 'model', 'mic', 'phrases']) assert.ok(ids.has(`setup-step-${step}`), step);
  for (const id of ['setup-model-tiny-size', 'setup-model-base-size', 'unsupported', 'announcer']) assert.ok(ids.has(id), id);
  const duplicates = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((id, i, all) => all.indexOf(id) !== i);
  assert.deepEqual(duplicates, []);
});

test('copy rules: no em or en dashes, and no provider or demo names', () => {
  const forbidden = /\u0047emma|\u0047oogle|VOICE\u0020DEMO/;
  for (const file of OWN_TEXT_FILES) {
    const text = read(file);
    assert.ok(!/[\u2013\u2014]/.test(text), `${file} contains an em or en dash`);
    assert.ok(!forbidden.test(text), `${file} names a provider or the old demo`);
  }
});

test('Show details lists the model load time the worker reports', () => {
  assert.match(read('js/asr-worker.js'), /loadMs: Math\.round\(performance\.now\(\) - started\)/);
  assert.ok(read('js/app.js').includes("fact(facts, 'Model load (includes any download)', `${ready.loadMs} ms`)"));
});
