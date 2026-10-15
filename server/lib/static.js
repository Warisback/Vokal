import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// Only these extensions are served. Anything else is a 404, which also rules out
// Windows name tricks such as a trailing dot or space.
export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

// The page also carries this policy in a meta tag, because GitHub Pages cannot send headers.
// The header copy adds frame-ancestors, which a meta tag cannot set. Keep the two in step:
// test/static.test.js compares them when app/index.html exists.
export const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// A worker runs under the policy sent with its own script, not under the page's meta tag.
// The speech worker imports the vendored library, which fetches the ONNX Runtime from
// cdn.jsdelivr.net, imports it as a blob: module and compiles WebAssembly. Model files come
// from huggingface.co, which redirects to its CDN hosts under hf.co. Nothing else is allowed.
export const SCRIPT_POLICY = [
  "default-src 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
  "connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

// API replies and other files are data. This only matters if one is opened as a page.
export const DATA_POLICY = "default-src 'none'; frame-ancestors 'none'";

export function policyFor(extension) {
  if (extension === '.html') return PAGE_POLICY;
  if (extension === '.js' || extension === '.mjs') return SCRIPT_POLICY;
  return DATA_POLICY;
}

// Headers on every response. --isolate adds the three that make the page cross-origin
// isolated, so multi-threaded WebAssembly can be measured locally.
export function baseHeaders({ isolate = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  };
  if (isolate) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    headers['Cross-Origin-Resource-Policy'] = 'same-origin';
  }
  return headers;
}

function isSafeSegment(segment) {
  // No empty segments, no dotfiles or dot segments, no backslashes, no drive or stream
  // colons (Windows), no control characters.
  return segment !== '' && !segment.startsWith('.') && !/[\\:\u0000-\u001f\u007f]/.test(segment);
}

// Maps a path below the base (still percent-encoded) to a file, or null.
// "models/..." comes from the models folder, everything else from the app folder.
export async function findFile(relativePath, { appDir, modelsDir }) {
  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return null;
  }
  if (decoded === '' || decoded.endsWith('/')) decoded += 'index.html';
  const segments = decoded.split('/');
  if (!segments.every(isSafeSegment)) return null;

  const inModels = segments.length > 1 && segments[0] === 'models';
  const root = inModels ? modelsDir : appDir;
  const parts = inModels ? segments.slice(1) : segments;
  const extension = path.extname(parts.at(-1)).toLowerCase();
  const type = MIME_TYPES[extension];
  if (!type) return null;

  try {
    // Real paths on both sides, so a link inside the folder cannot lead outside it.
    const realRoot = await realpath(root);
    const file = await realpath(path.join(realRoot, ...parts));
    if (!file.startsWith(realRoot + path.sep)) return null;
    const info = await stat(file);
    if (!info.isFile()) return null;
    return { file, size: info.size, type, extension };
  } catch {
    return null;
  }
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': DATA_POLICY,
  });
  res.end(text);
}

export async function serveStatic(req, res, relativePath, folders) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
  }
  const found = await findFile(relativePath, folders);
  if (!found) return sendText(res, 404, 'Not found.');
  res.writeHead(200, {
    'Content-Type': found.type,
    'Content-Length': found.size,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': policyFor(found.extension),
  });
  if (req.method === 'HEAD') return res.end();
  return pipeline(createReadStream(found.file), res);
}
