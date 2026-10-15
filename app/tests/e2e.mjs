// Browser end-to-end test for the Vokal app, in headless Microsoft Edge.
//
// It starts server/server.mjs with no language model settings, serves the app under
// /Vokal/ (the same sub-path as GitHub Pages) and drives it with synthetic audio:
// - files through "Transcribe an audio file": the short fixture, a longer sentence made
//   with Windows System.Speech at run time, and 3 s each of near-silence and digital
//   silence made here;
// - the short fixture through Chromium's fake microphone, for hold to talk.
// speechSynthesis.speak is wrapped to record what is spoken (Edge runs with sound muted).
// The first visit downloads the speech model from huggingface.co and the speech runtime
// from cdn.jsdelivr.net. Nothing is sent to a language model provider.
//
// Not part of `npm test`. From app/:
//   npm install       once, for playwright-core
//   npm run e2e       tiny.en on WASM, every check
//   npm run e2e -- --base-en --webgpu --shots ../docs/images
//
// Options:
//   --base-en       also measure base.en on WASM (about 80 MB more to download)
//   --webgpu        also measure tiny.en on WebGPU (about 122 MB more) if the browser has an adapter
//   --shots <dir>   save the README screenshots (393 x 852 CSS pixels at 2x) into <dir>
//   --long <wav>    use this file as the longer sentence instead of making one
//   --headed        show the browser window
// VOKAL_E2E_CHANNEL=chrome uses Chrome instead of Edge. playwright-core can also come
// from another folder through NODE_PATH, which keeps node_modules out of a synced folder.
//
// Timings are printed for information and never asserted: they depend on the machine.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run "npm install" in app/ first.');
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const SERVER = path.resolve(APP_DIR, '..', 'server', 'server.mjs');
const BASE = '/Vokal/';
const SHORT_FIXTURE = path.join(HERE, 'fixtures', 'short-16k.wav');

const SHORT_SCRIPT = 'Could you pass me the water, please?';
const SHORT_WORDS = ['pass', 'water', 'please'];
const LONG_SCRIPT = "I don't want the soup today. Please bring me two slices of toast and a cup of tea at four o'clock.";
const LONG_WORDS = ["don't", 'soup', 'two', 'toast', 'tea', 'four'];
const DIDNT_CATCH = "Didn't catch that. Try again, or type.";
const NO_SOUND = 'No sound reached Vokal. Check the microphone is not muted or in use by another app.';
const RELEASED_EARLY = 'Hold the button until it says Listening.';
const DOWNLOAD_STOPPED = 'Download stopped. Tap Download to continue.';
const NOT_CONFIGURED = 'The suggestion server has no model configured.';
const BUSY = ['working', 'starting', 'listening'];
const REMOTE = /^https:\/\/([\w-]+\.)*(huggingface\.co|hf\.co)\/|^https:\/\/cdn\.jsdelivr\.net\//;

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const OPTIONS = {
  baseEn: args.includes('--base-en'),
  webgpu: args.includes('--webgpu'),
  headed: args.includes('--headed'),
  shots: option('--shots') ? path.resolve(option('--shots')) : null,
  long: option('--long') ? path.resolve(option('--long')) : null,
};

// --- results ---

const results = [];
const timings = [];

function check(name, ok, detail = '') {
  results.push({ name, status: ok ? 'PASS' : 'FAIL' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

function skip(name, reason) {
  results.push({ name, status: 'SKIP' });
  console.log(`SKIP ${name}: ${reason}`);
}

function note(...parts) {
  console.log('    ', ...parts);
}

function timing(config, what, ms) {
  timings.push({ config, what, ms });
  note(`${config}: ${what} ${ms} ms`);
}

// --- audio ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vokal-e2e-'));

function wavBytes(samples, rate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), 44 + i * 2));
  return buffer;
}

// 3 s of seeded uniform noise, peak 0.003: about -55 dBFS RMS, like a quiet room.
// Loud enough to pass the pre-check (-60 dBFS), so it reaches the model and the guard.
function makeNearSilence() {
  const samples = new Float32Array(48000);
  let seed = 12345;
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    samples[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.003;
  }
  const file = path.join(TMP, 'near-silence-16k.wav');
  fs.writeFileSync(file, wavBytes(samples, 16000));
  return file;
}

// 3 s of digital silence: the pre-check stops it before the model.
function makeSilence() {
  const file = path.join(TMP, 'silence-16k.wav');
  fs.writeFileSync(file, wavBytes(new Float32Array(48000), 16000));
  return file;
}

// The longer sentence is made at run time with Windows System.Speech, 16 kHz mono,
// because it is over the size kept in the repo. Elsewhere, pass --long <wav>.
function makeLongSentence() {
  if (OPTIONS.long) return OPTIONS.long;
  if (process.platform !== 'win32') return null;
  const file = path.join(TMP, 'long-16k.wav');
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "try { $s.SelectVoice('Microsoft David Desktop') } catch { }",
    '$s.SetOutputToWaveFile($env:VOKAL_E2E_OUT, $format)',
    '$s.Speak($env:VOKAL_E2E_TEXT)',
    '$s.Dispose()',
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, VOKAL_E2E_OUT: file, VOKAL_E2E_TEXT: LONG_SCRIPT },
      stdio: 'ignore',
      timeout: 60000,
    });
    return fs.statSync(file).size > 44 ? file : null;
  } catch {
    return null;
  }
}

// Words for comparison: lower case, curly quotes made straight, small numbers as words,
// punctuation dropped. "4 o'clock" and "four o'clock" compare equal.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\d+/g, (digits) => NUMBER_WORDS[Number(digits)] ?? digits)
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Close enough: every key word is there and the length is within two words of the script.
function closeTo(text, script, keyWords) {
  const heard = words(text);
  const wanted = words(script);
  const missing = keyWords.filter((word) => !heard.includes(word));
  return {
    ok: missing.length === 0 && Math.abs(heard.length - wanted.length) <= 2,
    exact: heard.join(' ') === wanted.join(' '),
    missing,
  };
}

// Length of a PCM WAV file. Walks the chunks: System.Speech writes an 18-byte fmt chunk,
// so the data chunk is not always at byte 36.
function wavSeconds(file) {
  const bytes = fs.readFileSync(file);
  let offset = 12;
  let bytesPerSecond = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') bytesPerSecond = bytes.readUInt32LE(offset + 16);
    if (id === 'data') return Math.min(size, bytes.length - offset - 8) / bytesPerSecond;
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${file} is not a PCM WAV file`);
}

// --- server ---

// Language model settings are removed from the environment, so the server runs with
// suggestions off and can never call a provider.
function startServer() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VOKAL_|GOOGLE_|GEMINI_|OPENAI_|PORT$)/i.test(name)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--port', '0', '--base', BASE, '--app', APP_DIR], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = [];
    child.stderr.on('data', (chunk) => lines.push(...String(chunk).trim().split('\n')));
    child.stdout.on('data', (chunk) => {
      const match = /Vokal server: (\S+)/.exec(String(chunk));
      if (match) resolve({ child, url: match[1], lines });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
}

// --- browser ---

// Runs in the page before any app script: records what the checks need.
function initScript() {
  const log = { csp: [], spoken: [], tracks: [], posted: {}, states: [] };
  window.__vokal = log;
  document.addEventListener('securitypolicyviolation', (event) => log.csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  if (window.speechSynthesis) {
    const speak = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = (utterance) => {
      log.spoken.push({ text: utterance.text, local: utterance.voice ? utterance.voice.localService : null });
      return speak(utterance);
    };
  }
  if (navigator.mediaDevices) {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      log.tracks.push(...stream.getTracks());
      return stream;
    };
  }
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function postMessage(message, transfer) {
    const type = message && message.type;
    log.posted[type] = (log.posted[type] || 0) + 1;
    return post.call(this, message, transfer);
  };
  const watch = () => {
    const dot = document.getElementById('status-dot');
    if (!dot) {
      setTimeout(watch, 10);
      return;
    }
    const record = () => log.states.push({ t: performance.now(), state: dot.dataset.state });
    record();
    new MutationObserver(record).observe(dot, { attributes: true, attributeFilter: ['data-state'] });
  };
  watch();
}

// What the talk screen shows now.
function readScreen() {
  const byId = (id) => document.getElementById(id);
  const shown = (id) => !byId(id).hidden;
  const facts = Object.fromEntries([...document.querySelectorAll('#heard-facts > div')]
    .map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]));
  const inference = /^(\d+) ms/.exec(facts.Inference || '');
  const load = /^(\d+) ms/.exec(facts['Model load (includes any download)'] || '');
  return {
    state: byId('status-dot').dataset.state,
    status: byId('status-text').textContent,
    review: shown('review-panel') ? byId('review-text').value : null,
    error: shown('error-panel') ? byId('error-message').textContent : null,
    confirm: shown('confirm-panel') ? byId('confirm-question').textContent : null,
    heard: shown('heard-details') ? byId('heard-raw').textContent : null,
    removed: [...document.querySelectorAll('#heard-removed li')].map((item) => item.textContent),
    score: facts['No-speech score'] || null,
    inferMs: inference ? Number(inference[1]) : null,
    loadMs: load ? Number(load[1]) : null,
    speakReady: shown('review-panel') && !byId('speak-button').hidden && !byId('speak-button').disabled,
    note: shown('suggestion-note') ? byId('suggestion-note').textContent : null,
    suggestion: shown('suggestion') ? byId('suggestion-text').textContent : null,
  };
}

async function openBrowser(profile, origin) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: process.env.VOKAL_E2E_CHANNEL || 'msedge',
    headless: !OPTIONS.headed,
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    args: [
      '--mute-audio',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${MIC_FILE}%noloop`,
    ],
  });
  await context.addInitScript(initScript);
  const session = {
    context,
    page: context.pages()[0] || (await context.newPage()),
    errors: [],
    allowed: [], // console messages expected in the current step
    requests: [],
    failed: [], // requests that failed, with the browser's reason
  };
  const { page } = session;
  const onConsole = (where) => (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = `[${where} ${message.type()}] ${message.text()}`.slice(0, 300);
    if (!session.allowed.some((pattern) => pattern.test(text))) session.errors.push(text);
  };
  page.on('console', onConsole('page'));
  page.on('pageerror', (error) => session.errors.push(`[pageerror] ${error.message}`));
  page.on('worker', (worker) => worker.on('console', onConsole('worker')));
  page.on('dialog', (dialog) => dialog.accept());
  context.on('request', (request) => session.requests.push(request.url()));
  context.on('requestfailed', (request) => {
    const reason = request.failure() ? request.failure().errorText : 'unknown';
    session.failed.push(`${request.url().split('?')[0]} (${reason})`);
  });
  session.outside = () => session.requests.filter((url) => url.startsWith(origin) && !new URL(url).pathname.startsWith(BASE));
  session.remote = (from = 0) => session.requests.slice(from).filter((url) => REMOTE.test(url));
  return session;
}

async function stateLog(page) {
  return page.evaluate(() => window.__vokal.states.length);
}

async function waitForState(page, states, timeout = 60000) {
  await page.waitForFunction((wanted) => wanted.includes(document.getElementById('status-dot').dataset.state), states, { timeout, polling: 50 });
  return page.evaluate(() => document.getElementById('status-dot').dataset.state);
}

// Waits for Working followed by any state that is not busy, and times that stretch
// with the page clock: decode, pre-check, model, guard and render.
async function waitForOutcome(page, from, timeout = 120000) {
  await page.waitForFunction(({ from, busy }) => {
    const states = window.__vokal.states.slice(from);
    const working = states.findIndex((entry) => entry.state === 'working');
    return working !== -1 && states.slice(working + 1).some((entry) => !busy.includes(entry.state));
  }, { from, busy: BUSY }, { timeout, polling: 50 });
  const span = await page.evaluate(({ from, busy }) => {
    const states = window.__vokal.states.slice(from);
    const working = states.findIndex((entry) => entry.state === 'working');
    const done = states.slice(working + 1).find((entry) => !busy.includes(entry.state));
    return Math.round(done.t - states[working].t);
  }, { from, busy: BUSY });
  return { ...(await page.evaluate(readScreen)), wallMs: span };
}

async function transcribeFile(page, file) {
  await page.evaluate(() => { document.getElementById('file-details').open = true; });
  const from = await stateLog(page);
  const calls = await page.evaluate(() => window.__vokal.posted.transcribe || 0);
  await page.setInputFiles('#file-input', file);
  const outcome = await waitForOutcome(page, from);
  outcome.modelCalled = (await page.evaluate(() => window.__vokal.posted.transcribe || 0)) > calls;
  return outcome;
}

async function openSettings(page) {
  await page.click('#settings-open');
  await page.waitForFunction(() => document.getElementById('settings-dialog').open);
}

async function closeSettings(page) {
  await page.click('#settings-close');
  await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
}

// Picks the model and device in Settings and turns on the details panel, which
// carries the worker's own inference time and the no-speech score.
async function chooseModel(page, model, device) {
  await openSettings(page);
  await page.selectOption('#set-model', model);
  await page.selectOption('#set-device', device);
  await page.check('#set-details');
  await closeSettings(page);
  return waitForState(page, ['missing', 'ready', 'error']);
}

async function downloadModel(session, timeout = 600000) {
  const { page } = session;
  const started = Date.now();
  let sawProgress = false;
  await page.click('#model-download');
  for (;;) {
    const now = await page.evaluate(() => ({
      state: document.getElementById('status-dot').dataset.state,
      value: document.getElementById('model-progress').value,
      error: document.getElementById('model-message').textContent,
    }));
    if (now.value > 0 && now.value < 1) sawProgress = true;
    if (now.state === 'ready') return { ms: Date.now() - started, sawProgress };
    if (now.state === 'error') return { ms: Date.now() - started, sawProgress, error: now.error };
    if (Date.now() - started > timeout) return { ms: Date.now() - started, sawProgress, error: 'timed out' };
    await page.waitForTimeout(100);
  }
}

async function about(page) {
  await openSettings(page);
  const facts = await page.evaluate(() => ({
    status: document.getElementById('set-model-status').textContent,
    lib: document.getElementById('about-lib').textContent,
    ort: document.getElementById('about-ort').textContent,
    device: document.getElementById('about-device').textContent,
    threads: document.getElementById('about-threads').textContent,
  }));
  await closeSettings(page);
  return facts;
}

async function browserVersion(page) {
  return page.evaluate(async () => {
    const data = navigator.userAgentData;
    if (!data) return navigator.userAgent;
    const { fullVersionList } = await data.getHighEntropyValues(['fullVersionList']);
    const brand = fullVersionList.find((entry) => /Edge|Chrome/.test(entry.brand) && !/Not/.test(entry.brand));
    return brand ? `${brand.brand} ${brand.version}` : navigator.userAgent;
  });
}

async function screenshot(page, name) {
  if (!OPTIONS.shots) return;
  fs.mkdirSync(OPTIONS.shots, { recursive: true });
  await page.mouse.move(1, 1); // no hover colour on the record button
  await page.evaluate(() => {
    for (const id of ['file-details', 'type-details', 'heard-details']) document.getElementById(id).open = false;
    if (document.activeElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(200);
  const file = path.join(OPTIONS.shots, name);
  await page.screenshot({ path: file });
  note('screenshot', file);
}

// --- one model on one device: cold download, transcriptions, warm start ---

async function measureModel(server, { label, model, device, files, keepOpen = false }) {
  const profile = fs.mkdtempSync(path.join(TMP, 'profile-'));
  const origin = new URL(server.url).origin;
  let session = await openBrowser(profile, origin);
  let { page } = session;
  await page.goto(server.url);
  await page.waitForSelector('#screen-welcome:not([hidden]), #screen-talk:not([hidden])');
  if (await page.isVisible('#screen-welcome')) {
    if (label === 'tiny.en WASM') await screenshot(page, 'app-welcome.png');
    await page.click('#welcome-skip');
  }
  const before = await chooseModel(page, model, device);
  if (before === 'error') return { session, error: await page.textContent('#model-message') };

  let cold = await downloadModel(session);
  if (cold.error === DOWNLOAD_STOPPED) {
    // A dropped connection. Do what the message says once, and report it.
    const dropped = session.failed.filter((entry) => REMOTE.test(entry));
    note(`${label}: download stopped after ${cold.ms} ms (${dropped.join(', ') || 'no failed request seen'}); tapping Download again`);
    const again = await downloadModel(session);
    cold = { ...again, ms: cold.ms + again.ms, retried: true };
  }
  if (cold.error) {
    const dropped = session.failed.filter((entry) => REMOTE.test(entry));
    check(`${label}: model downloads and loads`, false, `${cold.error}${dropped.length ? ` | failed: ${dropped.join(', ')}` : ''}`);
    return { session, error: cold.error };
  }
  check(`${label}: model downloads and loads`, true, cold.retried ? 'after a second tap on Download' : 'first tap');
  timing(label, `first visit, tap Download to Ready${cold.retried ? ' (two taps)' : ''}`, cold.ms);
  const info = await about(page);
  note(`${label}: ${info.lib}, ONNX Runtime ${info.ort}, device ${info.device}, threads ${info.threads}`);
  const firstRuns = {};
  for (const [name, file] of files) {
    const outcome = await transcribeFile(page, file);
    firstRuns[name] = outcome;
    timing(label, `first ${name} file: inference ${outcome.inferMs} ms, file chosen to review`, outcome.wallMs);
  }
  const firstLoad = Object.values(firstRuns)[0]?.loadMs ?? null;
  check(`${label}: Show details reports the model load time`, firstLoad !== null, firstLoad === null ? 'missing' : `${firstLoad} ms`);
  if (firstLoad !== null) timing(label, 'first visit, model load in the worker (includes the download)', firstLoad);
  await session.context.close();

  // Second visit: a new browser on the same profile. Everything must come from the cache.
  session = await openBrowser(profile, origin);
  page = session.page;
  const from = session.requests.length;
  const started = Date.now();
  await page.goto(server.url);
  const warmState = await waitForState(page, ['ready', 'error', 'missing'], 120000);
  const warmMs = Date.now() - started;
  const fetched = session.remote(from);
  check(`${label}: second visit is ready from the cache without a tap`, warmState === 'ready', `${warmState} after ${warmMs} ms`);
  check(`${label}: second visit makes no model or runtime requests`, fetched.length === 0, fetched.length ? fetched.slice(0, 3).join(', ') : '0 requests');
  timing(label, 'second visit, page open to Ready', warmMs);
  const warmRuns = {};
  for (const [name, file] of files) {
    warmRuns[name] = [];
    for (let i = 0; i < 3; i++) warmRuns[name].push(await transcribeFile(page, file));
    const infer = warmRuns[name].map((run) => run.inferMs);
    note(`${label}: warm ${name} file, inference ${infer.join(', ')} ms; file chosen to review ${warmRuns[name].map((run) => run.wallMs).join(', ')} ms`);
    timings.push({ config: label, what: `warm ${name} inference (3 runs)`, ms: `${Math.min(...infer)} to ${Math.max(...infer)}` });
  }
  const warmLoad = Object.values(warmRuns)[0]?.[0]?.loadMs ?? null;
  if (warmLoad !== null) timing(label, 'second visit, model load in the worker (from the cache)', warmLoad);
  const warmTexts = Object.values(warmRuns).flat();
  check(`${label}: second visit transcribes every file`, warmTexts.every((run) => run.speakReady && run.inferMs !== null),
    warmTexts.map((run) => run.review ?? run.error).filter((text, i, all) => all.indexOf(text) === i).join(' / '));
  if (!keepOpen) {
    await session.context.close();
    session = null;
  }
  return { session, profile, cold, warmMs, firstRuns, warmRuns, info };
}

// --- the run ---

const MIC_FILE = path.join(TMP, 'mic-short-16k.wav'); // a path without spaces for the browser flag
fs.copyFileSync(SHORT_FIXTURE, MIC_FILE);
const SHORT = MIC_FILE;
const NEAR_SILENCE = makeNearSilence();
const SILENCE = makeSilence();
const LONG = makeLongSentence();
const servers = [];
const sessions = [];

try {
  note(`machine: ${os.cpus()[0].model.trim()}, ${os.cpus().length} logical cores, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.type()} ${os.release()}`);
  if (!LONG) note('no longer sentence: pass --long <wav> (System.Speech is Windows only)');
  const files = [['short', SHORT], ...(LONG ? [['long', LONG]] : [])];

  let server = await startServer();
  servers.push(server);
  const origin = new URL(server.url).origin;
  note('server', server.url);

  // Check 1: the page loads cleanly under the sub-path, on a fresh profile.
  {
    const profile = fs.mkdtempSync(path.join(TMP, 'profile-'));
    const session = await openBrowser(profile, origin);
    sessions.push(session);
    const { page } = session;
    await page.goto(server.url);
    await page.waitForLoadState('networkidle');
    note('browser:', await browserVersion(page));
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    await page.waitForTimeout(1000);
    check('1 service worker scope is the sub-path', scope === server.url, scope);
    check('1 the library comes from the app folder', session.requests.some((url) => url === `${server.url}vendor/transformers.min.js`));
    check('1 no requests to the origin outside the sub-path', session.outside().length === 0, session.outside().join(', '));
    check('1 nothing downloads before a tap', session.remote().length === 0, session.remote().join(', '));
    check('1 no security policy violations', (await page.evaluate(() => window.__vokal.csp)).length === 0, (await page.evaluate(() => window.__vokal.csp)).join(', '));
    check('1 no console errors or warnings', session.errors.length === 0, session.errors.join(' | '));
    await session.context.close();
    sessions.pop();
  }

  // Checks 2 to 8 on tiny.en with WASM.
  const tiny = await measureModel(server, { label: 'tiny.en WASM', model: 'tiny.en', device: 'wasm', files, keepOpen: true });
  if (tiny.error) throw new Error(`tiny.en did not load: ${tiny.error}`);
  sessions.push(tiny.session);
  const { page } = tiny.session;

  // Check 2: the files give the words of the script.
  for (const [name, script, keyWords] of [['short', SHORT_SCRIPT, SHORT_WORDS], ['long', LONG_SCRIPT, LONG_WORDS]]) {
    const runs = [tiny.firstRuns[name], ...(tiny.warmRuns[name] || [])].filter(Boolean);
    if (!runs.length) {
      skip(`2 ${name} file transcribes close to the script`, 'no file');
      continue;
    }
    const texts = [...new Set(runs.map((run) => run.review))];
    const close = closeTo(runs[0].review, script, keyWords);
    check(`2 ${name} file transcribes close to the script`, close.ok && runs.every((run) => run.speakReady && run.review === runs[0].review),
      `"${runs[0].review}" (exact after normalising: ${close.exact ? 'yes' : 'no'}${close.missing.length ? `, missing ${close.missing.join(' ')}` : ''}; score ${runs[0].score}${texts.length > 1 ? `; runs differ: ${texts.join(' / ')}` : ''})`);
  }
  check('2 second visit transcribes the same as the first', tiny.warmRuns.short[0].review === tiny.firstRuns.short.review);

  // Check 8 (first half): the ready state, for the README.
  await page.click('#clear-button').catch(() => {});
  await waitForState(page, ['ready']);
  await screenshot(page, 'app-ready.png');

  // Check 4: near-silence leaves nothing to speak. It follows a transcript, so this also
  // checks that the earlier words do not stay on screen next to the message.
  // Digital silence is stopped by the pre-check, before the model.
  {
    const spokenBefore = await page.evaluate(() => window.__vokal.spoken.length);
    await transcribeFile(page, SHORT);
    const quiet = await transcribeFile(page, NEAR_SILENCE);
    check('4 near-silence shows "Didn\'t catch that"', quiet.error === DIDNT_CATCH,
      `${quiet.error ?? quiet.confirm ?? quiet.review} | model called: ${quiet.modelCalled}, score ${quiet.score}, heard ${quiet.heard}, removed: ${quiet.removed.join(' ') || 'nothing'}`);
    check('4 near-silence leaves no words to speak', quiet.review === null && !quiet.speakReady, String(quiet.review));
    const silent = await transcribeFile(page, SILENCE);
    check('4 digital silence says no sound reached Vokal, with no model call', silent.error === NO_SOUND && !silent.modelCalled && silent.review === null,
      `${silent.error ?? silent.review} | model called: ${silent.modelCalled}`);
    const spoken = await page.evaluate(() => window.__vokal.spoken.length);
    check('4 nothing was spoken', spoken === spokenBefore, `${spoken - spokenBefore} utterances`);
  }

  // Check 3: hold to talk with the fake microphone playing the short fixture.
  {
    const button = page.locator('#record-button');
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    const centre = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(...centre);
    // A short first press (150 ms). If the microphone is not on yet, it only turns it on
    // (design 4.6, step 1). If it is, the press is a take too short to keep: released
    // before Listening, or a moment after it, when the pre-check stops it. Either way
    // nothing reaches the model and the screen says what to do.
    {
      const fromEarly = await stateLog(page);
      const calls = await page.evaluate(() => window.__vokal.posted.transcribe || 0);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.waitForTimeout(1500);
      const early = await page.evaluate((start) => ({
        hint: document.getElementById('record-hint').textContent,
        error: document.getElementById('error-panel').hidden ? null : document.getElementById('error-message').textContent,
        states: window.__vokal.states.slice(start).map((entry) => entry.state),
        calls: window.__vokal.posted.transcribe || 0,
        tracks: window.__vokal.tracks.map((track) => track.readyState),
      }), fromEarly);
      const micTurnedOn = /^Microphone on/.test(early.hint);
      const listened = early.states.includes('listening');
      const wanted = micTurnedOn ? null : listened ? DIDNT_CATCH : RELEASED_EARLY;
      check('3 a short press records nothing and says why',
        early.calls === calls && early.tracks.every((state) => state === 'ended') && (micTurnedOn || early.error === wanted),
        `${micTurnedOn ? `turned the microphone on: "${early.hint}"` : `${listened ? 'reached Listening' : 'released before Listening'}: "${early.error}"`}; model called: ${early.calls > calls}; tracks ${early.tracks.join(', ') || 'none'}`);
      await page.evaluate(() => { window.__vokal.tracks.length = 0; });
    }
    const from = await stateLog(page);
    const spokenBefore = await page.evaluate(() => window.__vokal.spoken.length);
    await page.mouse.down();
    await page.waitForFunction((start) => window.__vokal.states.slice(start).some((entry) => entry.state === 'listening'), from, { timeout: 10000 });
    await page.waitForTimeout(Math.round(wavSeconds(SHORT) * 1000) + 1000);
    await page.mouse.up();
    const heard = await waitForOutcome(page, from);
    const close = closeTo(heard.review, SHORT_SCRIPT, SHORT_WORDS);
    const statuses = (await page.evaluate((start) => window.__vokal.states.slice(start).map((entry) => entry.state), from)).filter((s, i, all) => s !== all[i - 1]);
    const tracks = await page.evaluate(() => window.__vokal.tracks.map((track) => track.readyState));
    const pressFact = await page.evaluate(() => [...document.querySelectorAll('#heard-facts > div')].find((row) => row.querySelector('dt').textContent === 'Press to Listening')?.querySelector('dd').textContent);
    check('3 hold to talk gives a transcript', Boolean(heard.review) && /water/i.test(heard.review), `"${heard.review ?? heard.error}" (key words ${close.missing.length ? `missing ${close.missing.join(' ')}` : 'all present'}; ${statuses.join(' > ')})`);
    check('3 the microphone track is stopped after release', tracks.length > 0 && tracks.every((state) => state === 'ended'), tracks.join(', ') || 'no tracks');
    check('3 nothing was spoken after recording', (await page.evaluate(() => window.__vokal.spoken.length)) === spokenBefore);
    timing('tiny.en WASM', `hold to talk: press to Listening ${pressFact}, release to review`, heard.wallMs);
  }

  // Check 8 (second half): the review state with a transcript.
  {
    await transcribeFile(page, SHORT);
    await screenshot(page, 'app-review.png');
  }

  // Check 5: Speak says the reviewed words, once, and only after the tap.
  {
    const spokenBefore = await page.evaluate(() => window.__vokal.spoken.length);
    const stored = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('vokal.settings') || '{}')));
    check('5 no automatic speech: nothing spoken during any transcription', spokenBefore === 0, `${spokenBefore} utterances; settings have no auto-speak option: ${!stored.some((key) => /auto/i.test(key))}`);
    const edited = `${(await page.inputValue('#review-text')).replace(/\?$/, '')}, thank you?`;
    await page.fill('#review-text', edited);
    await page.waitForTimeout(500);
    check('5 editing the words speaks nothing', (await page.evaluate(() => window.__vokal.spoken.length)) === 0);
    await page.click('#speak-button');
    await page.waitForTimeout(500);
    const spoken = await page.evaluate(() => window.__vokal.spoken);
    check('5 Speak is called once with the reviewed text', spoken.length === 1 && spoken[0].text === edited, JSON.stringify(spoken));
    note('voice is on this device:', spoken[0] ? spoken[0].local : 'n/a');
    // A file chosen while the voice is still speaking: the end of the speech must not
    // end Working early and leave the old words on screen as if they were the result.
    const speaking = await page.waitForFunction(() => !document.getElementById('speech-panel').hidden, null, { timeout: 3000 }).then(() => true, () => false);
    if (speaking && LONG) {
      const during = await transcribeFile(page, LONG);
      check('5 a file chosen while speaking ends with its own words', closeTo(during.review, LONG_SCRIPT, LONG_WORDS).ok, `"${during.review ?? during.error}"`);
      note('utterances after the file:', (await page.evaluate(() => window.__vokal.spoken.length)) - 1);
    } else {
      skip('5 a file chosen while speaking ends with its own words', speaking ? 'no longer sentence' : 'the voice did not start within 3 s');
    }
    if (await page.isVisible('#speech-stop')) await page.click('#speech-stop');
  }

  // Check 6: suggestions on, pointed at this server, which has no model configured.
  {
    const health = await fetch(`${server.url}api/health`).then((response) => response.json());
    check('6 the server reports no model configured', health.correction && health.correction.configured === false, JSON.stringify(health));
    tiny.session.allowed = [/status of 503/];
    const corrects = () => tiny.session.requests.filter((url) => url.endsWith('/api/correct')).length;
    await openSettings(page);
    await page.fill('#set-server', './');
    await page.press('#set-server', 'Tab');
    await page.click('#set-server-test');
    await page.waitForFunction(() => !/^Testing/.test(document.getElementById('set-server-result').textContent) && document.getElementById('set-server-result').textContent);
    const tested = await page.textContent('#set-server-result');
    check('6 Test in Settings says no model is configured', tested === NOT_CONFIGURED, tested);
    await closeSettings(page);
    const spokenBefore = await page.evaluate(() => window.__vokal.spoken.length);
    const first = await transcribeFile(page, SHORT);
    await page.waitForFunction(() => !/^Asking/.test(document.getElementById('suggestion-note').textContent), null, { timeout: 60000 });
    const after = await page.evaluate(readScreen);
    check('6 the transcript still reaches review with Speak ready', after.review === first.review && after.speakReady && after.error === null, `"${after.review}"`);
    check('6 no suggestion box and a calm note instead of an error', after.suggestion === null && (after.note === null || after.note === NOT_CONFIGURED), String(after.note));
    await page.click('#speak-button');
    await page.waitForTimeout(500);
    const spoken = await page.evaluate(() => window.__vokal.spoken.slice(-1)[0]);
    check('6 Speak still works', (await page.evaluate(() => window.__vokal.spoken.length)) === spokenBefore + 1 && spoken.text === after.review);
    if (await page.isVisible('#speech-stop')) await page.click('#speech-stop');
    const asked = corrects();
    await transcribeFile(page, SHORT);
    await page.waitForTimeout(500);
    check('6 after "not configured" the app stops asking', asked === 1 && corrects() === 1, `${corrects()} requests to api/correct`);
    check('6 no request left this computer apart from the model download', tiny.session.requests.every((url) => url.startsWith(origin) || REMOTE.test(url) || /^(data|blob):/.test(url)));
    await openSettings(page);
    await page.fill('#set-server', '');
    await page.press('#set-server', 'Tab');
    await closeSettings(page);
    tiny.session.allowed = [];
    note('server log:', server.lines.join(' | '));
  }

  check('no console errors or warnings on tiny.en', tiny.session.errors.length === 0, tiny.session.errors.join(' | '));
  check('no security policy violations on tiny.en', (await page.evaluate(() => window.__vokal.csp)).length === 0);
  check('no requests to the origin outside the sub-path', tiny.session.outside().length === 0, tiny.session.outside().join(', '));

  // Check 7: offline. The server is stopped and the browser is offline, then the page reloads.
  {
    server.child.kill();
    await tiny.session.context.setOffline(true);
    tiny.session.errors = [];
    const from = tiny.session.requests.length;
    const failed = [];
    tiny.session.context.on('requestfailed', (request) => failed.push(request.url()));
    await page.reload();
    const state = await waitForState(page, ['ready', 'error', 'missing'], 120000);
    check('7 offline: the app opens from the service worker', await page.isVisible('#screen-talk'));
    check('7 offline: the model loads from the cache', state === 'ready', await page.textContent('#status-text'));
    const offline = await transcribeFile(page, SHORT);
    check('7 offline: a file still transcribes', closeTo(offline.review, SHORT_SCRIPT, SHORT_WORDS).ok, `"${offline.review ?? offline.error}"`);
    const tried = tiny.session.requests.slice(from).filter((url) => !/^(data|blob):/.test(url));
    note(`offline: ${tried.length} requests, ${failed.length} failed: ${[...new Set(failed)].join(', ') || 'none'}`);
    note('offline console:', tiny.session.errors.join(' | ') || 'nothing');
    await tiny.session.context.close();
    sessions.pop();
  }

  // Optional: base.en on WASM, and tiny.en on WebGPU.
  if (OPTIONS.baseEn || OPTIONS.webgpu) {
    server = await startServer();
    servers.push(server);
  }
  if (OPTIONS.baseEn) {
    const base = await measureModel(server, { label: 'base.en WASM', model: 'base.en', device: 'wasm', files });
    if (!base.error) {
      for (const [name, script, keyWords] of [['short', SHORT_SCRIPT, SHORT_WORDS], ['long', LONG_SCRIPT, LONG_WORDS]]) {
        const run = base.firstRuns[name];
        if (run) check(`base.en ${name} file transcribes close to the script`, closeTo(run.review, script, keyWords).ok, `"${run.review}" score ${run.score}`);
      }
    }
  }
  if (OPTIONS.webgpu) {
    const probe = await openBrowser(fs.mkdtempSync(path.join(TMP, 'profile-')), new URL(server.url).origin);
    await probe.page.goto(server.url);
    const adapter = await probe.page.evaluate(async () => {
      if (!navigator.gpu) return null;
      const found = await navigator.gpu.requestAdapter();
      return found ? `${found.info.vendor} ${found.info.architecture}`.trim() : null;
    });
    await probe.context.close();
    if (!adapter) {
      skip('tiny.en WebGPU', 'this browser has no WebGPU adapter in this launch mode; WASM only');
    } else {
      note('WebGPU adapter:', adapter);
      const gpu = await measureModel(server, { label: 'tiny.en WebGPU', model: 'tiny.en', device: 'webgpu', files });
      if (!gpu.error) {
        const run = gpu.firstRuns.short;
        check('tiny.en WebGPU short file transcribes close to the script', closeTo(run.review, SHORT_SCRIPT, SHORT_WORDS).ok, `"${run.review}" score ${run.score}`);
      }
    }
  }
} catch (error) {
  check('run completed', false, error.stack || String(error));
} finally {
  for (const session of sessions) await session.context.close().catch(() => {});
  for (const server of servers) server.child.kill();
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    // Edge can hold a profile file for a moment after it closes.
    note(`could not remove ${TMP} (${error.code}); delete it by hand`);
  }
}

console.log('\nTimings (information only, this machine):');
for (const entry of timings) console.log(`  ${entry.config.padEnd(16)} ${String(entry.ms).padStart(14)} ms  ${entry.what}`);
const failed = results.filter((result) => result.status === 'FAIL').length;
const skipped = results.filter((result) => result.status === 'SKIP').length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed ? 1 : 0;
