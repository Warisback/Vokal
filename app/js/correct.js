// Optional suggestion client. It is off unless a suggestion server is set in Settings.
// A suggestion is only ever offered: it is never applied or spoken automatically.

export const CORRECT_MESSAGES = Object.freeze({
  NETWORK: 'Could not reach the suggestion server.',
  NO_SERVER: 'No suggestion server at this address.',
  NOT_CONFIGURED: 'The suggestion server has no model configured.',
  UNAUTHORIZED: 'The server key is not right.',
  BAD_RESPONSE: 'The suggestion server sent a reply Vokal could not read.',
  SERVER_ERROR: 'The suggestion server could not check these words.',
});

function failure(code, message = CORRECT_MESSAGES[code]) {
  return { error: { code, message } };
}

// undefined when the body is not JSON. A network failure or timeout while reading
// the body is rethrown, so it is reported as unreachable rather than "no server".
async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error && error.name === 'SyntaxError') return undefined;
    throw error;
  }
}

function serverMessage(body) {
  const message = body && body.error && body.error.message;
  return typeof message === 'string' && message.length <= 200 ? message : CORRECT_MESSAGES.SERVER_ERROR;
}

export function createCorrector({ fetchImpl, timeoutMs = 50000 } = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  let stopped = null;

  async function request(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, { ...init, signal: controller.signal, cache: 'no-store', redirect: 'error' });
      // A 404, or a body that is not JSON (such as a static host's HTML error page),
      // means there is no Vokal server at this address.
      const body = await readJson(response);
      return { response, body };
    } catch {
      return { error: failure('NETWORK') };
    } finally {
      clearTimeout(timer);
    }
  }

  function mapError(response, body, { remember }) {
    const code = body && body.error && body.error.code;
    if (response.status === 404 || body === undefined) {
      if (remember) stopped = 'NO_SERVER';
      return failure('NO_SERVER');
    }
    if (response.status === 503 && code === 'NOT_CONFIGURED') {
      if (remember) stopped = 'NOT_CONFIGURED';
      return failure('NOT_CONFIGURED');
    }
    if (response.status === 401) {
      if (remember) stopped = 'UNAUTHORIZED';
      return failure('UNAUTHORIZED');
    }
    if (response.status === 403 && (code === 'REMOTE_NOT_ALLOWED' || code === 'FORBIDDEN_ORIGIN')) {
      return failure(code, serverMessage(body));
    }
    return failure(typeof code === 'string' ? code : 'SERVER_ERROR', CORRECT_MESSAGES.SERVER_ERROR);
  }

  function headers(key, withBody) {
    const result = { Accept: 'application/json' };
    if (withBody) result['Content-Type'] = 'application/json';
    if (key) result.Authorization = `Bearer ${key}`;
    return result;
  }

  return {
    get stopped() {
      return stopped;
    },
    // Settings changed: the next request may succeed.
    reset() {
      stopped = null;
    },
    async suggest({ text, phrases = [], endpoint, key = '' }) {
      if (stopped) return failure(stopped);
      const payload = { text, phrases: phrases.map(({ heard, intended }) => ({ heard, intended })) };
      const result = await request(endpoint, { method: 'POST', headers: headers(key, true), body: JSON.stringify(payload) });
      if (result.error) return result.error;
      const { response, body } = result;
      if (!response.ok || body === undefined) return mapError(response, body, { remember: true });
      if (!body || typeof body.suggested !== 'string' || typeof body.raw !== 'string') return failure('BAD_RESPONSE');
      return {
        raw: body.raw,
        suggested: body.suggested,
        changed: body.changed === true,
        uncertain: body.uncertain === true,
        degraded: body.degraded === true,
        reason: typeof body.reason === 'string' ? body.reason : null,
        note: typeof body.note === 'string' ? body.note : '',
        model: typeof body.model === 'string' ? body.model : '',
        timing: body.timing && typeof body.timing === 'object' ? body.timing : {},
      };
    },
    async health(endpoint, key = '') {
      const result = await request(endpoint, { method: 'GET', headers: headers(key, false) });
      if (result.error) return result.error;
      const { response, body } = result;
      if (!response.ok || body === undefined) return mapError(response, body, { remember: false });
      const correction = (body && body.correction) || {};
      return {
        ok: body.ok === true,
        configured: correction.configured === true,
        provider: typeof correction.provider === 'string' ? correction.provider : '',
        model: typeof correction.model === 'string' ? correction.model : '',
      };
    },
  };
}
