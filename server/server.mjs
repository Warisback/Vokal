// Optional local server for Vokal: serves app/ for development, serves local model folders,
// and offers text suggestions through a language model. Speech to text is not here; it runs
// on the device. Not meant for public hosting.
import { existsSync, realpathSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { suggest } from './lib/correct.js';
import { ApiError, publicError } from './lib/errors.js';
import { checkAccess, checkOrigin, corsHeaders, readAccessConfig, readJsonBody, sendJson } from './lib/http.js';
import { createProvider, readLlmConfig } from './lib/providers.js';
import { baseHeaders, DATA_POLICY, sendText, serveStatic } from './lib/static.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 3210;
export const DEFAULT_APP_DIR = path.join(HERE, '..', 'app');
const API_METHODS = { 'api/correct': 'POST', 'api/health': 'GET' };

const USAGE = `Usage: node server.mjs [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--base /] [--app <dir>] [--models <dir>] [--isolate]`;

class UsageError extends Error {}

export function parseFlags(argv, env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        base: { type: 'string' },
        app: { type: 'string' },
        models: { type: 'string' },
        isolate: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  const portText = values.port ?? (String(env.PORT ?? '').trim() || String(DEFAULT_PORT));
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) {
    throw new UsageError('--port must be a number from 0 to 65535.');
  }
  const base = values.base ?? '/';
  if (!/^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)*$/.test(base)) {
    throw new UsageError('--base must start and end with "/", for example /Vokal/.');
  }
  const appDir = path.resolve(values.app ?? DEFAULT_APP_DIR);
  return {
    help: Boolean(values.help),
    port: Number(portText),
    host: values.host ?? '127.0.0.1',
    base,
    appDir,
    modelsDir: path.resolve(values.models ?? path.join(appDir, 'models')),
    isolate: Boolean(values.isolate),
  };
}

// Reads every setting once. A wrong value turns the API off (503) but keeps the
// static files working, and names the variable in the log, never its value.
function readConfig(env, provider, fetchImpl) {
  try {
    const llm = readLlmConfig(env);
    const access = readAccessConfig(env);
    return { llm, access, provider: provider ?? createProvider(llm, { fetchImpl }), error: null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { llm: null, access: { allowedOrigins: [], accessToken: null }, provider: null, error };
  }
}

function healthBody(provider) {
  return {
    ok: true,
    correction: { configured: Boolean(provider.configured), provider: provider.name, model: provider.model ?? null },
  };
}

export function createServer({
  appDir = DEFAULT_APP_DIR,
  modelsDir,
  base = '/',
  isolate = false,
  env = process.env,
  provider,
  fetchImpl,
  log = (line) => console.error(line),
} = {}) {
  const folders = {
    appDir: path.resolve(appDir),
    modelsDir: path.resolve(modelsDir ?? path.join(appDir, 'models')),
  };
  const config = readConfig(env, provider, fetchImpl);
  if (config.error) {
    log(`Configuration problem: ${config.error.field ?? config.error.code} is not valid. Suggestions are off until it is fixed.`);
  }
  const headers = baseHeaders({ isolate });

  function sendError(res, error) {
    const { status, code, body } = publicError(error);
    // Code and status only: never the request, the reply, a key or an error message.
    log(`${status} ${code}`);
    const extra = {};
    if (code === 'UNAUTHORIZED') extra['WWW-Authenticate'] = 'Bearer';
    // A client that stalls mid-body does not get to keep the connection.
    if (code === 'REQUEST_TIMEOUT') extra.Connection = 'close';
    sendJson(res, status, body, extra);
  }

  async function handleApi(req, res, route) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', DATA_POLICY);
    res.setHeader('Vary', 'Origin');
    try {
      // 1. Origin. 2. CORS, where preflights end. 3. Locality and the server key.
      const corsOrigin = checkOrigin(req, config.access.allowedOrigins);
      if (corsOrigin) {
        for (const [name, value] of Object.entries(corsHeaders(corsOrigin, req))) res.setHeader(name, value);
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (config.error) throw config.error;
      checkAccess(req, config.access.accessToken);

      const method = API_METHODS[route];
      if (!method) throw new ApiError('NOT_FOUND');
      if (req.method !== method) {
        res.setHeader('Allow', `${method}, OPTIONS`);
        throw new ApiError('METHOD_NOT_ALLOWED');
      }
      if (route === 'api/health') return sendJson(res, 200, healthBody(config.provider));

      const body = await readJsonBody(req);
      const result = await suggest(body, { provider: config.provider, timeoutMs: config.llm.timeoutMs });
      if (result.degraded) log(`200 degraded ${result.reason}`);
      return sendJson(res, 200, result);
    } catch (error) {
      return sendError(res, error);
    }
  }

  async function handle(req, res) {
    if (!req.url.startsWith('/')) return sendText(res, 404, 'Not found.');
    const url = new URL(`http://localhost${req.url}`);
    if (base !== '/' && url.pathname === base.slice(0, -1)) {
      res.writeHead(301, { Location: `${base}${url.search}`, 'Content-Length': 0 });
      return res.end();
    }
    if (!url.pathname.startsWith(base)) return sendText(res, 404, 'Not found.');
    const relativePath = url.pathname.slice(base.length);
    if (relativePath === 'api' || relativePath.startsWith('api/')) return handleApi(req, res, relativePath);
    return serveStatic(req, res, relativePath, folders);
  }

  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    handle(req, res).catch((error) => {
      // A client that goes away mid-download ends up here; there is nobody left to answer.
      if (res.headersSent) return res.destroy();
      return sendError(res, error);
    });
  });
  // Requests are small (64 KB at most), so a client gets 30 s to send one.
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  return server;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  let options;
  try {
    options = parseFlags(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (!existsSync(options.appDir)) console.error(`App folder not found: ${options.appDir}`);
  else if (!existsSync(path.join(options.appDir, 'vendor', 'transformers.min.js'))) {
    console.error('transformers.js is missing from app/vendor/. Run: npm run vendor --prefix app');
  }

  const server = createServer(options);
  server.on('error', (error) => {
    console.error(`Vokal server could not start: ${error.code ?? error.name}`);
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    const host = options.host.includes(':') ? `[${options.host}]` : options.host;
    console.log(`Vokal server: http://${host}:${server.address().port}${options.base}`);
  });
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (isMain()) main();
