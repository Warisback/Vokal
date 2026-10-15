// Service worker: keeps the app shell (pages, scripts, styles, icons and the vendored
// library) available offline. Model and runtime files belong to the library's own
// cache ('transformers-cache'); this worker never touches that cache, and model
// downloads pass straight through it.
'use strict';

const VERSION = '2.0.0';
// SHA-256 of the shell files (see the static test). Any change to the shell changes
// this value, which makes browsers install a new worker into a new cache.
const SHELL_HASH = 'e8f3df211cf05bc85ff7cc51cbbeffcbee182d9a3a7582501a0bbf68f5197910';
const CACHE_PREFIX = 'vokal-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${SHELL_HASH.slice(0, 12)}`;
const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/support.js',
  'js/app.js',
  'js/onboarding.js',
  'js/audio.js',
  'js/asr.js',
  'js/asr-worker.js',
  'js/guard.js',
  'js/models.js',
  'js/settings.js',
  'js/speech.js',
  'js/correct.js',
  'vendor/transformers.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// 'navigate', 'shell' or 'pass'. Anything not listed passes through untouched, so
// 40 to 200 MB model files never stream through this worker.
function route(request, scope) {
  if (request.method !== 'GET') return 'pass';
  const url = new URL(request.url);
  const base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return 'pass';
  const path = url.pathname.slice(base.pathname.length);
  if (path.startsWith('api/') || path.startsWith('models/')) return 'pass';
  if (request.mode === 'navigate') return 'navigate';
  if (PRECACHE.includes(path === '' ? './' : path)) return 'shell';
  return 'pass';
}

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

async function fromShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function navigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(scopeUrl('index.html'), { ignoreSearch: true });
  return cached || fetch(request);
}

async function shellComplete() {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const hits = await Promise.all(PRECACHE.map((path) => cache.match(scopeUrl(path))));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

self.addEventListener('install', (event) => {
  // All or nothing: addAll fails if any file fails. No skipWaiting here; the app
  // asks the person before an update takes over.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(PRECACHE.map((path) => new Request(scopeUrl(path), { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const kind = route(event.request, self.registration.scope);
  if (kind === 'navigate') event.respondWith(navigation(event.request));
  else if (kind === 'shell') event.respondWith(fromShell(event.request));
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'SHELL_STATUS' && event.ports && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil(shellComplete().then((complete) => port.postMessage({ type: 'SHELL_STATUS', complete, version: VERSION })));
  }
});
