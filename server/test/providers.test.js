import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ApiError } from '../lib/errors.js';
import {
  createProvider,
  DEFAULT_TIMEOUT_MS,
  GOOGLE_DEFAULT_MODEL,
  MAX_RESPONSE_BYTES,
  readLlmConfig,
  statusError,
  withTimeout,
} from '../lib/providers.js';

const isCode = (code) => (error) => error instanceof ApiError && error.code === code;
const request = { instructions: 'the instructions', data: '{"transcript":"Hello","examples":[]}' };

function googleAnswer(parts, finishReason = 'STOP') {
  return { candidates: [{ finishReason, content: { parts } }] };
}

function openAiAnswer(content, finishReason = 'stop') {
  return { choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }] };
}

// Records each call and answers with a real Response, as fetch would.
function fakeFetch(answer, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function google(env = {}, fetchImpl) {
  return createProvider(readLlmConfig({ GOOGLE_API_KEY: 'test-google-key', ...env }), { fetchImpl });
}

function openAi(env = {}, fetchImpl) {
  return createProvider(readLlmConfig({
    VOKAL_LLM_PROVIDER: 'openai-compatible',
    VOKAL_LLM_BASE_URL: 'http://127.0.0.1:8080/v1',
    VOKAL_LLM_MODEL: 'qwen2.5:7b-instruct',
    ...env,
  }), { fetchImpl });
}

test('defaults: google, gemma-4-26b-a4b-it, a 45 s timeout, and not configured without a key', () => {
  const config = readLlmConfig({});
  assert.equal(config.provider, 'google');
  assert.equal(config.model, GOOGLE_DEFAULT_MODEL);
  assert.equal(config.model, 'gemma-4-26b-a4b-it');
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 45000);
  assert.equal(config.configured, false);
  assert.equal(readLlmConfig({ GOOGLE_API_KEY: '  key  ' }).configured, true);
  assert.equal(readLlmConfig({ VOKAL_LLM_TIMEOUT_MS: '1000' }).timeoutMs, 1000);
  assert.equal(readLlmConfig({ VOKAL_LLM_TIMEOUT_MS: '45000' }).timeoutMs, 45000);
});

test('bad provider, model name, timeout or base URL give INVALID_CONFIGURATION naming the variable', () => {
  const cases = [
    [{ VOKAL_LLM_PROVIDER: 'openai' }, 'VOKAL_LLM_PROVIDER'],
    [{ VOKAL_LLM_MODEL: '../bad?key=x' }, 'VOKAL_LLM_MODEL'],
    [{ VOKAL_LLM_MODEL: 'models/gemma' }, 'VOKAL_LLM_MODEL'],
    [{ VOKAL_LLM_MODEL: 'gemma:latest' }, 'VOKAL_LLM_MODEL'],
    [{ VOKAL_LLM_MODEL: `m${'x'.repeat(128)}` }, 'VOKAL_LLM_MODEL'],
    [{ VOKAL_LLM_PROVIDER: 'openai-compatible', VOKAL_LLM_MODEL: 'has space' }, 'VOKAL_LLM_MODEL'],
    [{ VOKAL_LLM_TIMEOUT_MS: '999' }, 'VOKAL_LLM_TIMEOUT_MS'],
    [{ VOKAL_LLM_TIMEOUT_MS: '45001' }, 'VOKAL_LLM_TIMEOUT_MS'],
    [{ VOKAL_LLM_TIMEOUT_MS: '10s' }, 'VOKAL_LLM_TIMEOUT_MS'],
    [{ VOKAL_LLM_TIMEOUT_MS: '-5000' }, 'VOKAL_LLM_TIMEOUT_MS'],
    [{ VOKAL_LLM_PROVIDER: 'openai-compatible', VOKAL_LLM_BASE_URL: 'not a url' }, 'VOKAL_LLM_BASE_URL'],
    [{ VOKAL_LLM_PROVIDER: 'openai-compatible', VOKAL_LLM_BASE_URL: 'ftp://host/v1' }, 'VOKAL_LLM_BASE_URL'],
    [{ VOKAL_LLM_PROVIDER: 'openai-compatible', VOKAL_LLM_BASE_URL: 'https://user:pw@host/v1' }, 'VOKAL_LLM_BASE_URL'],
  ];
  for (const [env, field] of cases) {
    assert.throws(() => readLlmConfig(env), (error) => isCode('INVALID_CONFIGURATION')(error) && error.field === field, JSON.stringify(env));
  }
  // Slashes and colons are fine for an openai-compatible model name (Ollama tags, Hub ids).
  assert.equal(openAi({ VOKAL_LLM_MODEL: 'org/model-7b:q4_K_M' }).model, 'org/model-7b:q4_K_M');
});

test('google request shape: key in a header, fixed endpoint, no redirects, prompt and data as two parts', async () => {
  const key = randomUUID();
  const { fetchImpl, calls } = fakeFetch(googleAnswer([{ text: 'private reasoning', thought: true }, { text: 'visible' }]));
  const signal = new AbortController().signal;
  const text = await google({ GOOGLE_API_KEY: key }, fetchImpl).generate({ ...request, signal });

  assert.equal(text, 'visible');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent');
  assert.equal(url.includes(key), false);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], key);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.redirect, 'error');
  assert.equal(init.signal, signal);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: request.instructions }, { text: request.data }] }]);
  assert.equal(body.generationConfig.temperature, 0);
  // Gemma answers 400 to a thinking budget, so it never gets one.
  assert.equal(body.generationConfig.thinkingConfig, undefined);
});

test('google sends a zero thinking budget to gemini-* models only', async () => {
  const { fetchImpl, calls } = fakeFetch(googleAnswer([{ text: 'ok' }]));
  await google({ VOKAL_LLM_MODEL: 'gemini-3.6-flash' }, fetchImpl).generate(request);
  await google({ VOKAL_LLM_MODEL: 'gemma-4-31b-it' }, fetchImpl).generate(request);
  assert.match(calls[0].url, /models\/gemini-3\.6-flash:generateContent$/);
  assert.deepEqual(JSON.parse(calls[0].init.body).generationConfig.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(JSON.parse(calls[1].init.body).generationConfig.thinkingConfig, undefined);
});

test('google answers that are blocked, cut off or have no visible text are INVALID_MODEL_OUTPUT', async () => {
  const answers = [
    {},
    { promptFeedback: { blockReason: 'SAFETY' } },
    googleAnswer([{ text: 'partial' }], 'MAX_TOKENS'),
    googleAnswer([{ text: 'reasoning', thought: true }]),
    googleAnswer([{ inlineData: {} }]),
    { candidates: [{ finishReason: 'STOP', content: {} }] },
  ];
  for (const answer of answers) {
    await assert.rejects(google({}, fakeFetch(answer).fetchImpl).generate(request), isCode('INVALID_MODEL_OUTPUT'));
  }
});

test('openai-compatible request shape: chat completions, system and user messages, temperature 0, 1024 tokens', async () => {
  const { fetchImpl, calls } = fakeFetch(openAiAnswer('{"suggested":"Hello","uncertain":false}'));
  const signal = new AbortController().signal;
  const text = await openAi({ VOKAL_LLM_BASE_URL: 'http://127.0.0.1:8080/v1/' }, fetchImpl).generate({ ...request, signal });

  assert.equal(text, '{"suggested":"Hello","uncertain":false}');
  const { url, init } = calls[0];
  assert.equal(url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.signal, signal);
  assert.equal(init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(init.body), {
    model: 'qwen2.5:7b-instruct',
    messages: [{ role: 'system', content: request.instructions }, { role: 'user', content: request.data }],
    temperature: 0,
    max_tokens: 1024,
  });

  const key = randomUUID();
  const withKey = fakeFetch(openAiAnswer('ok'));
  await openAi({ VOKAL_LLM_API_KEY: key }, withKey.fetchImpl).generate(request);
  assert.equal(withKey.calls[0].init.headers.Authorization, `Bearer ${key}`);
});

test('openai-compatible answers without text, or cut off, are INVALID_MODEL_OUTPUT', async () => {
  const answers = [{}, { choices: [] }, openAiAnswer(null), openAiAnswer('partial', 'length'), openAiAnswer('x', 'content_filter')];
  for (const answer of answers) {
    await assert.rejects(openAi({}, fakeFetch(answer).fetchImpl).generate(request), isCode('INVALID_MODEL_OUTPUT'));
  }
  // Some local servers leave finish_reason out.
  assert.equal(await openAi({}, fakeFetch(openAiAnswer('ok', null)).fetchImpl).generate(request), 'ok');
});

test('status mapping is the same for both providers', () => {
  const table = [
    [401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [429, 'PROVIDER_QUOTA'], [404, 'MODEL_UNAVAILABLE'],
    [408, 'PROVIDER_TIMEOUT'], [504, 'PROVIDER_TIMEOUT'], [400, 'PROVIDER_REJECTED'], [422, 'PROVIDER_REJECTED'],
    [500, 'PROVIDER_UNAVAILABLE'], [502, 'PROVIDER_UNAVAILABLE'], [503, 'PROVIDER_UNAVAILABLE'], [418, 'PROVIDER_UNAVAILABLE'],
  ];
  for (const [status, code] of table) assert.equal(statusError(status).code, code, String(status));
});

test('an error status never reads the provider body, for either provider', async () => {
  for (const make of [google, openAi]) {
    for (const [status, code] of [[401, 'PROVIDER_AUTH'], [429, 'PROVIDER_QUOTA'], [404, 'MODEL_UNAVAILABLE'], [400, 'PROVIDER_REJECTED'], [503, 'PROVIDER_UNAVAILABLE'], [504, 'PROVIDER_TIMEOUT']]) {
      let bodyRead = false;
      let cancelled = false;
      const response = {
        ok: false,
        status,
        body: { cancel: async () => { cancelled = true; }, getReader: () => { bodyRead = true; } },
        json: async () => { bodyRead = true; },
        text: async () => { bodyRead = true; },
      };
      await assert.rejects(make({}, async () => response).generate(request), isCode(code));
      assert.equal(bodyRead, false);
      assert.equal(cancelled, true);
    }
  }
});

test('network failures are PROVIDER_UNAVAILABLE and aborts are PROVIDER_TIMEOUT', async () => {
  const offline = async () => { throw new TypeError('fetch failed: private transport details'); };
  await assert.rejects(google({}, offline).generate(request), isCode('PROVIDER_UNAVAILABLE'));
  await assert.rejects(openAi({}, offline).generate(request), isCode('PROVIDER_UNAVAILABLE'));

  const controller = new AbortController();
  controller.abort();
  const aborted = async () => { throw new DOMException('The operation was aborted.', 'AbortError'); };
  await assert.rejects(google({}, aborted).generate({ ...request, signal: controller.signal }), isCode('PROVIDER_TIMEOUT'));
});

test('withTimeout aborts the call and rejects PROVIDER_TIMEOUT; a fast call passes through', async () => {
  let signal;
  await assert.rejects(withTimeout((value) => { signal = value; return new Promise(() => {}); }, 5), isCode('PROVIDER_TIMEOUT'));
  assert.equal(signal.aborted, true);
  assert.equal(await withTimeout(async () => 'done', 1000), 'done');

  // A real abort reaching fetch surfaces as a timeout too.
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const provider = google({}, hanging);
  await assert.rejects(withTimeout((value) => provider.generate({ ...request, signal: value }), 5), isCode('PROVIDER_TIMEOUT'));
});

test('a missing key or base URL is NOT_CONFIGURED and never fetches', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  const noKey = createProvider(readLlmConfig({}), { fetchImpl });
  assert.equal(noKey.configured, false);
  await assert.rejects(noKey.generate(request), isCode('NOT_CONFIGURED'));

  const noBase = openAi({ VOKAL_LLM_BASE_URL: '' }, fetchImpl);
  assert.equal(noBase.configured, false);
  await assert.rejects(noBase.generate(request), isCode('NOT_CONFIGURED'));

  const noModel = openAi({ VOKAL_LLM_MODEL: '' }, fetchImpl);
  assert.equal(noModel.configured, false);
  assert.equal(noModel.model, null);
  await assert.rejects(noModel.generate(request), isCode('NOT_CONFIGURED'));
  assert.equal(calls, 0);
});

test('a reply that is not JSON, or larger than the limit, is PROVIDER_UNAVAILABLE', async () => {
  const notJson = async () => new Response('<html>busy</html>', { status: 200 });
  await assert.rejects(google({}, notJson).generate(request), isCode('PROVIDER_UNAVAILABLE'));
  const huge = async () => new Response(`"${'x'.repeat(MAX_RESPONSE_BYTES)}"`, { status: 200 });
  await assert.rejects(openAi({}, huge).generate(request), isCode('PROVIDER_UNAVAILABLE'));
});
