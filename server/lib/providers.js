import { ApiError } from './errors.js';

export const DEFAULT_TIMEOUT_MS = 45000;
export const MIN_TIMEOUT_MS = 1000;
export const GOOGLE_DEFAULT_MODEL = 'gemma-4-26b-a4b-it';
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const PROVIDERS = ['google', 'openai-compatible'];
const MODEL_NAME = /^[A-Za-z0-9][\w.:/-]{0,127}$/;
// The Google model name becomes part of the URL path, so it may not contain '/' or ':'.
const GOOGLE_MODEL_NAME = /^[A-Za-z0-9][\w.-]{0,127}$/;
const GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

function setting(env, name) {
  return String(env[name] ?? '').trim();
}

function invalid(field) {
  return new ApiError('INVALID_CONFIGURATION', { field });
}

// Reads the language model settings. Missing values leave suggestions off (configured: false);
// values that are present but wrong throw INVALID_CONFIGURATION naming the variable.
export function readLlmConfig(env = process.env) {
  const provider = setting(env, 'VOKAL_LLM_PROVIDER') || 'google';
  if (!PROVIDERS.includes(provider)) throw invalid('VOKAL_LLM_PROVIDER');

  const timeoutText = setting(env, 'VOKAL_LLM_TIMEOUT_MS');
  const timeoutMs = timeoutText ? Number(timeoutText) : DEFAULT_TIMEOUT_MS;
  if (timeoutText && (!/^\d+$/.test(timeoutText) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > DEFAULT_TIMEOUT_MS)) {
    throw invalid('VOKAL_LLM_TIMEOUT_MS');
  }

  const model = setting(env, 'VOKAL_LLM_MODEL') || (provider === 'google' ? GOOGLE_DEFAULT_MODEL : '');
  const pattern = provider === 'google' ? GOOGLE_MODEL_NAME : MODEL_NAME;
  if (model && !pattern.test(model)) throw invalid('VOKAL_LLM_MODEL');

  if (provider === 'google') {
    const apiKey = setting(env, 'GOOGLE_API_KEY');
    return { provider, model, timeoutMs, apiKey, baseUrl: GOOGLE_ENDPOINT, configured: Boolean(apiKey) };
  }

  const baseUrl = readBaseUrl(setting(env, 'VOKAL_LLM_BASE_URL'));
  const apiKey = setting(env, 'VOKAL_LLM_API_KEY');
  return { provider, model: model || null, timeoutMs, apiKey, baseUrl, configured: Boolean(baseUrl && model) };
}

function readBaseUrl(text) {
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalid('VOKAL_LLM_BASE_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalid('VOKAL_LLM_BASE_URL');
  }
  return url.href.replace(/\/+$/, '');
}

// A provider turns instructions plus a data part into the model's answer text.
// Tests pass their own object with the same shape to createServer.
export function createProvider(config, { fetchImpl } = {}) {
  const generate = config.provider === 'google' ? generateGoogle : generateOpenAiCompatible;
  return {
    name: config.provider,
    model: config.model,
    configured: config.configured,
    generate: (request) => generate(config, request, fetchImpl ?? globalThis.fetch),
  };
}

async function generateGoogle(config, { instructions, data, signal }, fetchImpl) {
  if (!config.configured) throw new ApiError('NOT_CONFIGURED');
  const generationConfig = { temperature: 0, maxOutputTokens: 2048 };
  // Gemini models accept a zero thinking budget. Gemma answers 400 to the field, so it only goes to gemini-*.
  if (config.model.startsWith('gemini-')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const result = await postJson(fetchImpl, `${config.baseUrl}${config.model}:generateContent`, {
    headers: { 'x-goog-api-key': config.apiKey },
    body: { contents: [{ role: 'user', parts: [{ text: instructions }, { text: data }] }], generationConfig },
    signal,
  });
  const candidate = result?.candidates?.[0];
  if (result?.promptFeedback?.blockReason || candidate?.finishReason !== 'STOP'
    || !Array.isArray(candidate?.content?.parts)) throw new ApiError('INVALID_MODEL_OUTPUT');
  // Thought parts hold the model's reasoning, not its answer.
  const visible = candidate.content.parts.filter((part) => part.thought !== true && typeof part.text === 'string');
  if (!visible.length) throw new ApiError('INVALID_MODEL_OUTPUT');
  return visible.map((part) => part.text).join('');
}

async function generateOpenAiCompatible(config, { instructions, data, signal }, fetchImpl) {
  if (!config.configured) throw new ApiError('NOT_CONFIGURED');
  const result = await postJson(fetchImpl, `${config.baseUrl}/chat/completions`, {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    body: {
      model: config.model,
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: data }],
      temperature: 0,
      max_tokens: 1024,
    },
    signal,
  });
  const choice = result?.choices?.[0];
  const content = choice?.message?.content;
  // An answer cut off at the token limit, or filtered, is not a usable proposal.
  if (typeof content !== 'string' || (choice.finish_reason != null && choice.finish_reason !== 'stop')) {
    throw new ApiError('INVALID_MODEL_OUTPUT');
  }
  return content;
}

async function postJson(fetchImpl, url, { headers, body, signal }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    throw transportError(error, signal);
  }
  if (!response.ok) {
    // Never read a provider error body: it can echo the request or credential details.
    try {
      await response.body?.cancel();
    } catch {
      // Nothing to clean up.
    }
    throw statusError(response.status);
  }
  try {
    return await readJson(response);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw transportError(error, signal);
  }
}

async function readJson(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ApiError('PROVIDER_UNAVAILABLE');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function transportError(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new ApiError('PROVIDER_TIMEOUT');
  }
  return new ApiError('PROVIDER_UNAVAILABLE');
}

export function statusError(status) {
  if (status === 401 || status === 403) return new ApiError('PROVIDER_AUTH');
  if (status === 429) return new ApiError('PROVIDER_QUOTA');
  if (status === 404) return new ApiError('MODEL_UNAVAILABLE');
  if (status === 408 || status === 504) return new ApiError('PROVIDER_TIMEOUT');
  if (status === 400 || status === 422) return new ApiError('PROVIDER_REJECTED');
  return new ApiError('PROVIDER_UNAVAILABLE');
}

// Races the call against a timer and aborts it when the timer wins. Racing also bounds
// a provider that ignores the abort signal. No retry: a second call would spend quota again.
export async function withTimeout(work, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError('PROVIDER_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
