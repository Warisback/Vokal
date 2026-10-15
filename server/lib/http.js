import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const BODY_TIMEOUT_MS = 8000;
export const MIN_TOKEN_LENGTH = 24;

const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip'];
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function setting(env, name) {
  return String(env[name] ?? '').trim();
}

// VOKAL_ALLOWED_ORIGINS and VOKAL_ACCESS_TOKEN. Wrong values throw INVALID_CONFIGURATION
// naming the variable, so a typo fails closed instead of opening the server.
export function readAccessConfig(env = process.env) {
  const allowedOrigins = setting(env, 'VOKAL_ALLOWED_ORIGINS')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseOrigin);
  const accessToken = setting(env, 'VOKAL_ACCESS_TOKEN');
  if (accessToken && (accessToken.length < MIN_TOKEN_LENGTH || /[^\x21-\x7e]/.test(accessToken))) {
    throw new ApiError('INVALID_CONFIGURATION', { field: 'VOKAL_ACCESS_TOKEN' });
  }
  return { allowedOrigins, accessToken: accessToken || null };
}

function parseOrigin(entry) {
  let url;
  try {
    url = new URL(entry);
  } catch {
    throw new ApiError('INVALID_CONFIGURATION', { field: 'VOKAL_ALLOWED_ORIGINS' });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password) {
    throw new ApiError('INVALID_CONFIGURATION', { field: 'VOKAL_ALLOWED_ORIGINS' });
  }
  return url.origin;
}

function header(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

// Step 1, the origin rule. Requests without Origin (curl, scripts) skip it.
// Returns the origin to answer with CORS headers, or null when none are needed.
export function checkOrigin(req, allowedOrigins) {
  const origin = header(req, 'origin');
  if (origin === undefined) return null;
  if (header(req, 'sec-fetch-site') === 'same-origin') return null;
  // The scheme is ignored, so a same-origin page reached through an HTTPS tunnel
  // in front of this plain HTTP server still counts as same-origin.
  const host = header(req, 'host');
  try {
    if (host && new URL(origin).host === host.toLowerCase()) return null;
  } catch {
    // Not a URL (for example "null"): only an exact listed origin can pass.
  }
  if (allowedOrigins.includes(origin)) return origin;
  throw new ApiError('FORBIDDEN_ORIGIN');
}

// Step 2, CORS headers for a listed origin.
export function corsHeaders(origin, req) {
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  };
  if (header(req, 'access-control-request-private-network') === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function isLoopbackAddress(address = '') {
  return address === '::1' || /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address);
}

function hostname(hostHeader) {
  const value = hostHeader.toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

// A request is local only when the socket is loopback, the Host header names this
// computer, and no proxy says it forwarded the request. A tunnel on this machine
// connects from loopback too, which is why the bind address alone is not enough.
// The Host check also blocks DNS rebinding.
export function isLocalRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = header(req, 'host');
  if (!host || !LOCAL_HOSTNAMES.includes(hostname(host))) return false;
  return FORWARDING_HEADERS.every((name) => header(req, name) === undefined);
}

function sameSecret(given, expected) {
  // Hashing first gives equal lengths, so the comparison takes the same time for any input.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// Step 3, locality and the server key.
export function checkAccess(req, accessToken) {
  if (isLocalRequest(req)) return;
  if (!accessToken) throw new ApiError('REMOTE_NOT_ALLOWED');
  const match = /^Bearer[ ]+(\S+)$/i.exec(header(req, 'authorization') ?? '');
  if (!match || !sameSecret(match[1], accessToken)) throw new ApiError('UNAUTHORIZED');
}

// Reads a JSON body of at most maxBytes, giving up after timeoutMs.
export async function readJsonBody(req, { maxBytes = MAX_BODY_BYTES, timeoutMs = BODY_TIMEOUT_MS } = {}) {
  const contentType = header(req, 'content-type');
  if (typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  }
  const length = Number(header(req, 'content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new ApiError('BODY_TOO_LARGE');
  const bytes = await readBytes(req, maxBytes, timeoutMs);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError('INVALID_JSON');
  }
}

function readBytes(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      if (error) {
        // Discard the rest of the body so the reply can still reach the client.
        req.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) finish(new ApiError('BODY_TOO_LARGE'));
      else chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => finish();
    const onError = () => finish(new ApiError('INVALID_JSON'));
    const timer = setTimeout(() => finish(new ApiError('REQUEST_TIMEOUT')), timeoutMs);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onError);
  });
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
