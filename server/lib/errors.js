// Errors that end a request. Only these fixed messages cross HTTP: provider errors and
// exceptions can carry request text or credentials, so their messages are never sent or logged.
const HTTP_ERRORS = {
  INVALID_REQUEST: [400, 'Check the request fields and try again.'],
  INVALID_JSON: [400, 'Send a valid JSON request.'],
  UNAUTHORIZED: [401, 'Missing or wrong server key.'],
  FORBIDDEN_ORIGIN: [403, 'This server does not accept requests from that web address. Add it to VOKAL_ALLOWED_ORIGINS.'],
  REMOTE_NOT_ALLOWED: [403, 'This server only answers this computer. Set VOKAL_ACCESS_TOKEN to allow other devices.'],
  NOT_FOUND: [404, 'Nothing is served at this address.'],
  METHOD_NOT_ALLOWED: [405, 'This address does not accept that method.'],
  REQUEST_TIMEOUT: [408, 'The request took too long to arrive.'],
  BODY_TOO_LARGE: [413, 'The request is larger than 64 KB.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Send the request as application/json.'],
  INTERNAL_ERROR: [500, 'The server could not complete this request.'],
  NOT_CONFIGURED: [503, 'The suggestion server has no language model configured.'],
  INVALID_CONFIGURATION: [503, 'The suggestion server settings are not valid. Check its environment variables.'],
};

// Reasons a suggestion falls back to the person's own words. They travel in a 200 reply as
// `reason`, because the text is still usable.
export const DEGRADED_REASONS = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_QUOTA',
  'PROVIDER_AUTH',
  'PROVIDER_REJECTED',
  'PROVIDER_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'INVALID_MODEL_OUTPUT',
  'UNSAFE_CORRECTION',
];

export class ApiError extends Error {
  constructor(code, { field } = {}) {
    // The message is the code itself, so logging an ApiError never logs user text.
    super(code);
    this.name = 'ApiError';
    this.code = code;
    // Names the environment variable behind an INVALID_CONFIGURATION, never its value.
    if (field) this.field = field;
  }
}

export function isApiError(error, code) {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

export function publicError(error) {
  const code = error instanceof ApiError && Object.hasOwn(HTTP_ERRORS, error.code) ? error.code : 'INTERNAL_ERROR';
  const [status, message] = HTTP_ERRORS[code];
  return { status, code, body: { error: { code, message } } };
}

export function degradedReason(error) {
  return error instanceof ApiError && DEGRADED_REASONS.includes(error.code) ? error.code : 'PROVIDER_UNAVAILABLE';
}
