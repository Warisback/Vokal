// Audio path: microphone capture, the level meter, file checks, and decoding to the
// 16 kHz mono samples Whisper expects. Nothing here touches a browser global at import
// time; browser objects are passed in or resolved inside the functions.

export const TARGET_RATE = 16000;
export const MAX_SECONDS = 30; // one Whisper window; the no-speech probe reads one score per window
export const MAX_SAMPLES = TARGET_RATE * MAX_SECONDS;
export const MAX_DECODED_SECONDS = 30.05; // container rounding can add a few milliseconds
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_UNKNOWN_LENGTH_BYTES = 6 * 1024 * 1024;
export const AUDIO_BITS_PER_SECOND = 128000;
export const MIME_ORDER = Object.freeze(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']);
export const FILE_ACCEPT = 'audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac';

export const FILE_MESSAGES = Object.freeze({
  TOO_BIG: 'This file is over 10 MB.',
  TOO_LONG: 'This file is longer than 30 seconds. Vokal transcribes up to 30 seconds at a time.',
  UNKNOWN_LENGTH: 'Vokal could not read the length of this file. Use a WAV file or a file under 6 MB.',
});

// --- pure helpers ---

// First supported type that has not failed to decode this session, else '' (browser default).
export function pickMimeType(isTypeSupported, skip = new Set()) {
  for (const type of MIME_ORDER) {
    if (skip.has(type)) continue;
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // A browser that throws here simply does not support the type.
    }
  }
  return '';
}

function fourCC(view, offset) {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

// Reads a WAV header without decoding, so a long file is refused before it costs memory.
export function wavInfo(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 12 || fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') return null;
  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset + 8 <= view.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 24 <= view.byteLength) {
      format = { channels: view.getUint16(offset + 10, true), rate: view.getUint32(offset + 12, true), bits: view.getUint16(offset + 22, true) };
    } else if (id === 'data') {
      // Streamed WAV files can carry a placeholder size; use what is actually there.
      dataBytes = Math.min(size, view.byteLength - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || dataBytes === null || !format.rate || !format.channels || !format.bits) return null;
  const bytesPerSecond = format.rate * format.channels * (format.bits / 8);
  return { rate: format.rate, channels: format.channels, bits: format.bits, durationS: dataBytes / bytesPerSecond };
}

// Checks a file before it is decoded. durationS is null when it could not be read.
export function checkFile({ sizeBytes, durationS }) {
  if (sizeBytes > MAX_FILE_BYTES) return 'TOO_BIG';
  const known = typeof durationS === 'number' && Number.isFinite(durationS);
  if (known && durationS > MAX_SECONDS) return 'TOO_LONG';
  if (!known && sizeBytes > MAX_UNKNOWN_LENGTH_BYTES) return 'UNKNOWN_LENGTH';
  return null;
}

export function checkDecodedLength(samples) {
  return samples.length > MAX_DECODED_SECONDS * TARGET_RATE ? 'TOO_LONG' : null;
}

export function averageChannels(channels) {
  if (channels.length === 1) return new Float32Array(channels[0]);
  const length = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i];
  }
  for (let i = 0; i < length; i++) mono[i] /= channels.length;
  return mono;
}

export function clipSamples(samples, max = MAX_SAMPLES) {
  return samples.length > max ? samples.slice(0, max) : samples;
}

// --- decoding ---

function channelsOf(buffer) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return channels;
}

// Decodes any format the browser reads to 16 kHz mono. The primary path lets the
// decoder resample into a 16 kHz context, which filters before it downsamples.
// The fallback renders through a buffer source, which aliases (a 10 kHz tone folds to
// 6 kHz), so it is reported as 'fallback' in the details panel.
export async function decodeTo16k(arrayBuffer, { OfflineCtx } = {}) {
  const Ctx = OfflineCtx || globalThis.OfflineAudioContext;
  try {
    const decoded = await new Ctx(1, 1, TARGET_RATE).decodeAudioData(arrayBuffer.slice(0));
    return { samples: averageChannels(channelsOf(decoded)), resampler: 'decoder' };
  } catch {
    const source = await new Ctx(1, 1, 48000).decodeAudioData(arrayBuffer.slice(0));
    const length = Math.max(1, Math.ceil(source.duration * TARGET_RATE));
    const render = new Ctx(1, length, TARGET_RATE);
    const node = render.createBufferSource();
    node.buffer = source;
    node.connect(render.destination);
    node.start();
    const rendered = await render.startRendering();
    return { samples: new Float32Array(rendered.getChannelData(0)), resampler: 'fallback' };
  }
}

// Duration from the media element's metadata, for formats without a readable header.
export function readMediaDuration(file, { timeoutMs = 5000, doc = globalThis.document, urls = globalThis.URL } = {}) {
  return new Promise((resolve) => {
    const audio = doc.createElement('audio');
    const url = urls.createObjectURL(file);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      urls.revokeObjectURL(url);
      resolve(typeof value === 'number' && Number.isFinite(value) ? value : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => done(audio.duration));
    audio.addEventListener('error', () => done(null));
    audio.src = url;
  });
}

// --- microphone ---

export function micConstraints(processing) {
  return { audio: { channelCount: 1, echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing } };
}

export function setAudioSessionType(audioSession, type) {
  try {
    if (audioSession) audioSession.type = type;
  } catch {
    // Only some Safari versions have audioSession; nothing to do elsewhere.
  }
}

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

export function micErrorCode(error) {
  const name = error && error.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'MIC_BLOCKED';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'NO_MIC';
  if (name === 'NotReadableError' || name === 'AbortError') return 'MIC_BUSY';
  return 'MIC_FAILED';
}

// 'granted', 'denied', 'prompt' or 'unknown'. onChange fires when the person changes it.
export async function micPermission({ permissions = globalThis.navigator?.permissions, onChange } = {}) {
  try {
    const status = await permissions.query({ name: 'microphone' });
    if (onChange) status.addEventListener('change', () => onChange(status.state));
    return status.state;
  } catch {
    return 'unknown';
  }
}

// Turns the microphone on and straight off again, so the permission prompt happens
// on a press that is not a recording.
export async function warmMicrophone({ processing = true, mediaDevices = globalThis.navigator?.mediaDevices, audioSession = globalThis.navigator?.audioSession } = {}) {
  setAudioSessionType(audioSession, 'auto');
  try {
    const stream = await mediaDevices.getUserMedia(micConstraints(processing));
    stopStream(stream);
    return null;
  } catch (error) {
    return micErrorCode(error);
  }
}

// One recording, from press to blob. getUserMedia is called before anything is awaited.
// onStreamReady passes the live stream to the meter; onListening fires on the recorder's
// start event; onEnd fires exactly once, after every track has stopped, with
// { blob, ... } or { error } or { cancelled: true }.
export function startTake({
  processing = true,
  skip = new Set(),
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
  audioSession = globalThis.navigator?.audioSession,
  now = () => globalThis.performance.now(),
  onStreamReady,
  onListening,
  onEnd,
} = {}) {
  const pressedAt = now();
  let state = 'starting'; // starting, listening, stopping, ended
  let stream = null;
  let recorder = null;
  let mimeType = '';
  let nativeRate = null;
  let listeningAt = null;
  const chunks = [];

  function release() {
    stopStream(stream);
  }

  function end(outcome) {
    if (state === 'ended') return;
    state = 'ended';
    release();
    if (onEnd) onEnd(outcome);
  }

  function onRecorderStop() {
    if (state !== 'stopping') return;
    release();
    const type = (recorder && recorder.mimeType) || mimeType || '';
    const blob = new Blob(chunks, type ? { type } : {});
    if (!blob.size) {
      end({ error: 'EMPTY' });
      return;
    }
    end({
      blob,
      mimeType: type,
      bitsPerSecond: recorder && typeof recorder.audioBitsPerSecond === 'number' ? recorder.audioBitsPerSecond : null,
      nativeRate,
      processing,
      pressToListeningMs: listeningAt === null ? null : Math.round(listeningAt - pressedAt),
      heldMs: listeningAt === null ? null : Math.round(now() - listeningAt),
    });
  }

  function onStream(newStream) {
    stream = newStream;
    if (state !== 'starting') {
      release(); // released or cancelled before the stream arrived
      return;
    }
    const track = stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
    try {
      const rate = track && track.getSettings ? track.getSettings().sampleRate : null;
      nativeRate = typeof rate === 'number' ? rate : null;
    } catch {
      nativeRate = null;
    }
    try {
      mimeType = pickMimeType((type) => MediaRecorderImpl.isTypeSupported(type), skip);
      const options = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
      if (mimeType) options.mimeType = mimeType;
      recorder = new MediaRecorderImpl(stream, options);
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('start', () => {
        if (state !== 'starting') return;
        state = 'listening';
        listeningAt = now();
        if (onListening) onListening({ pressToListeningMs: Math.round(listeningAt - pressedAt) });
      });
      recorder.addEventListener('stop', onRecorderStop);
      recorder.addEventListener('error', () => end({ error: 'RECORDER_FAILED' }));
      recorder.start();
    } catch {
      // Construction or start() threw: the stream must not stay open.
      end({ error: 'RECORDER_FAILED' });
      return;
    }
    if (onStreamReady) onStreamReady(stream);
  }

  setAudioSessionType(audioSession, 'auto');
  let request;
  try {
    request = mediaDevices.getUserMedia(micConstraints(processing));
  } catch (error) {
    request = Promise.reject(error);
  }
  request.then(onStream, (error) => end({ error: micErrorCode(error) }));

  function stopRecorder() {
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch {
      // Already stopped.
    }
  }

  return {
    get state() {
      return state;
    },
    // Release, tap or auto-stop. Before Listening there is nothing worth keeping.
    stop() {
      if (state === 'starting') {
        stopRecorder();
        end({ error: 'RELEASED_EARLY' });
      } else if (state === 'listening') {
        state = 'stopping';
        stopRecorder();
        if (!recorder) end({ error: 'EMPTY' });
      }
    },
    cancel() {
      if (state === 'ended') return;
      stopRecorder();
      end({ cancelled: true });
    },
  };
}

// --- level meter (decoration only, never on the capture path) ---

// One AudioContext for the page. ensure() must run in a click or keydown handler:
// those are user activations on every browser, while a touch pointerdown is not.
export function createAudioContextHolder({ disabled = false, AudioContextImpl } = {}) {
  let context = null;
  return {
    ensure() {
      if (context || disabled) return;
      const Impl = AudioContextImpl || globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Impl) return;
      try {
        context = new Impl();
      } catch {
        context = null;
      }
    },
    get context() {
      return context;
    },
  };
}

// Draws the recent input level as bars. The context is resumed without waiting and
// the meter connects once it is running, so capture never waits for the meter.
export function createMeter({ canvas, holder }) {
  let stream = null;
  let source = null;
  let analyser = null;
  let frame = 0;
  let watching = null;
  const history = [];

  function draw() {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    history.push(Math.sqrt(sum / data.length));
    if (history.length > 48) history.shift();
    const g = canvas.getContext('2d');
    const { width, height } = canvas;
    g.clearRect(0, 0, width, height);
    g.fillStyle = getComputedStyle(canvas).color;
    const step = width / 48;
    history.forEach((level, i) => {
      const h = Math.max(3, Math.min(height, level * height * 5));
      g.fillRect(i * step + step * 0.25, (height - h) / 2, step * 0.5, h);
    });
    frame = requestAnimationFrame(draw);
  }

  function connect() {
    const context = holder.context;
    if (!stream || source || !context || context.state !== 'running') return;
    try {
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      frame = requestAnimationFrame(draw);
    } catch {
      source = null;
    }
  }

  return {
    attach(newStream) {
      const context = holder.context;
      if (!context || !canvas) return;
      stream = newStream;
      if (watching !== context) {
        context.addEventListener('statechange', connect);
        watching = context;
      }
      context.resume().catch(() => {});
      connect();
    },
    detach() {
      stream = null;
      cancelAnimationFrame(frame);
      history.length = 0;
      if (source) {
        try {
          source.disconnect();
        } catch {
          // Already disconnected.
        }
      }
      source = null;
      analyser = null;
      if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      const context = holder.context;
      if (context && context.state === 'running') context.suspend().catch(() => {});
    },
  };
}
