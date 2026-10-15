// Speech model catalogue and the model spec the worker loads.
// Built-in models are pinned to a commit. A custom model is either a public Hugging Face
// repo (resolved to a commit hash at download time) or a folder under <app>/models/.
// This is the seam for a fine-tuned export: no code change, only a setting.

export const HUB_API = 'https://huggingface.co/api/models/';

export const MODELS = Object.freeze({
  'tiny.en': { repo: 'onnx-community/whisper-tiny.en', revision: '2575352d61be1bf7225cf8f8b268a4678025fc58' },
  'base.en': { repo: 'onnx-community/whisper-base.en', revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe' },
});

// Bytes per file at the pinned revisions, read from the Hub API on 2026-10-14.
// "common" is config.json, generation_config.json, preprocessor_config.json,
// tokenizer.json and tokenizer_config.json together.
export const FILE_BYTES = Object.freeze({
  'tiny.en': {
    common: 2692523,
    encoder_model: { fp32: 32904992, fp16: 16519192, q8: 10124993, q4: 9020667 },
    decoder_model_merged: { fp32: 118552291, fp16: 59589240, q8: 30718858, q4: 86712166 },
  },
  'base.en': {
    common: 2692433,
    encoder_model: { fp32: 82468078, fp16: 41332612, q8: 23201320, q4: 18772451 },
    decoder_model_merged: { fp32: 208519480, fp16: 104721330, q8: 53692803, q4: 123600371 },
  },
});

export const DEVICES = Object.freeze(['wasm', 'webgpu']);

export const DTYPE_BY_DEVICE = Object.freeze({
  wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
});

// Precision choices in Settings: [encoder, decoder]. 'auto' follows the device.
export const DTYPE_CHOICES = Object.freeze({
  auto: null,
  q8: ['q8', 'q8'],
  fp16: ['fp16', 'fp16'],
  fp32: ['fp32', 'fp32'],
  q4: ['q4', 'q4'],
  'fp32+q8': ['fp32', 'q8'],
});

// File name suffix for each precision, as in onnx/encoder_model<suffix>.onnx.
export const SUFFIX = Object.freeze({ q8: '_quantized', fp16: '_fp16', fp32: '', q4: '_q4' });

const HUB_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,96}(@[\w.-]{1,64})?$/;
const LOCAL_ID = /^models\/([\w.-]{1,64})\/?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ONLY_DOTS = /^\.+$/;

export function resolveDtype(dtypeSetting, device) {
  const choice = DTYPE_CHOICES[dtypeSetting];
  if (!choice) return { ...(DTYPE_BY_DEVICE[device] || DTYPE_BY_DEVICE.wasm) };
  return { encoder_model: choice[0], decoder_model_merged: choice[1] };
}

// Precision for the WASM fallback after WebGPU fails.
export function fallbackDtype(dtypeSetting) {
  return resolveDtype(dtypeSetting, 'wasm');
}

export function parseCustomModel(text) {
  const value = String(text ?? '').trim();
  if (!value || value.length > 200) return { error: 'INVALID_CUSTOM' };
  const local = LOCAL_ID.exec(value);
  if (local) {
    if (ONLY_DOTS.test(local[1])) return { error: 'INVALID_CUSTOM' };
    return { source: 'local', id: local[1] };
  }
  if (!HUB_ID.test(value)) return { error: 'INVALID_CUSTOM' };
  const [id, ref = 'main'] = value.split('@');
  const name = id.split('/')[1];
  if (ONLY_DOTS.test(name)) return { error: 'INVALID_CUSTOM' };
  return { source: 'hub', id, ref };
}

// Turns a branch or tag into a commit hash, so a device never keeps stale weights
// from a moving branch. A 40-hex ref is already a commit and needs no request.
export async function resolveRevision(id, ref, fetchImpl) {
  if (COMMIT.test(ref)) return { sha: ref };
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  let response;
  try {
    response = await doFetch(`${HUB_API}${id}/revision/${encodeURIComponent(ref)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (response.status === 401 || response.status === 404) return { error: 'MODEL_NOT_FOUND' };
  if (!response.ok) return { error: 'NETWORK' };
  try {
    const body = await response.json();
    if (body && typeof body.sha === 'string' && COMMIT.test(body.sha)) return { sha: body.sha };
  } catch {
    // Fall through: an unreadable body is treated like a network failure.
  }
  return { error: 'NETWORK' };
}

// Builds the ModelSpec the worker loads. appBaseUrl is the page's base URL; the local
// model path is root-relative because an absolute URL breaks the library's file lookup.
export function modelSpec(settings, { appBaseUrl }) {
  const device = DEVICES.includes(settings.device) ? settings.device : 'wasm';
  const dtype = resolveDtype(settings.dtype, device);
  const builtIn = MODELS[settings.model];
  if (builtIn) {
    return { key: settings.model, source: 'hub', id: builtIn.repo, revision: builtIn.revision, localPath: null, device, dtype };
  }
  const parsed = parseCustomModel(settings.customModel);
  if (parsed.error) return { error: 'INVALID_CUSTOM' };
  if (parsed.source === 'local') {
    const localPath = new URL('models/', appBaseUrl).pathname;
    return { key: 'custom', source: 'local', id: parsed.id, revision: 'main', localPath, device, dtype };
  }
  const resolved = settings.customResolved;
  if (!resolved || resolved.id !== parsed.id || resolved.ref !== parsed.ref || !COMMIT.test(resolved.sha || '')) {
    return { error: 'NOT_RESOLVED' };
  }
  return { key: 'custom', source: 'hub', id: parsed.id, revision: resolved.sha, localPath: null, device, dtype };
}

// Approximate download size in MB for a built-in model, or null when unknown.
export function approxDownloadMb(spec) {
  if (!spec || spec.error || spec.source !== 'hub') return null;
  const builtIn = MODELS[spec.key];
  if (!builtIn || builtIn.repo !== spec.id) return null;
  const sizes = FILE_BYTES[spec.key];
  const encoder = sizes.encoder_model[spec.dtype.encoder_model];
  const decoder = sizes.decoder_model_merged[spec.dtype.decoder_model_merged];
  if (encoder === undefined || decoder === undefined) return null;
  return Math.round((sizes.common + encoder + decoder) / 100000) / 10;
}

// The files a model folder needs for a spec's precision; used in help text and docs.
export function modelFiles(dtype) {
  return [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    `onnx/encoder_model${SUFFIX[dtype.encoder_model] ?? ''}.onnx`,
    `onnx/decoder_model_merged${SUFFIX[dtype.decoder_model_merged] ?? ''}.onnx`,
  ];
}

export function sameSpec(a, b) {
  if (!a || !b || a.error || b.error) return false;
  return a.key === b.key && a.source === b.source && a.id === b.id && a.revision === b.revision &&
    a.localPath === b.localPath && a.device === b.device &&
    a.dtype.encoder_model === b.dtype.encoder_model && a.dtype.decoder_model_merged === b.dtype.decoder_model_merged;
}
