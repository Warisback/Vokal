import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as audio from '../js/audio.js';

// --- helpers ---

function wavHeader({ rate, channels, bits, dataBytes, extraChunk = false, declaredBytes = dataBytes }) {
  const extra = extraChunk ? 12 : 0;
  const buffer = new ArrayBuffer(44 + extra + dataBytes);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + extra + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  let offset = 36;
  if (extraChunk) {
    write(offset, 'LIST');
    view.setUint32(offset + 4, 4, true);
    write(offset + 8, 'INFO');
    offset += 12;
  }
  write(offset, 'data');
  view.setUint32(offset + 4, declaredBytes, true);
  return buffer;
}

function fakeBuffer(channels, { duration = channels[0].length / 16000 } = {}) {
  return {
    numberOfChannels: channels.length,
    duration,
    getChannelData: (index) => channels[index],
  };
}

// Records how decodeTo16k uses OfflineAudioContext, without any Web Audio.
function fakeOfflineContext({ primaryFails = false, decoded, rendered }) {
  const log = [];
  class FakeOffline {
    constructor(channels, length, rate) {
      this.args = { channels, length, rate };
      log.push({ made: this.args });
    }
    async decodeAudioData(buffer) {
      log.push({ decodeAt: this.args.rate, bytes: buffer.byteLength, buffer });
      if (primaryFails && this.args.rate === 16000) throw new DOMException('cannot decode', 'EncodingError');
      return decoded;
    }
    createBufferSource() {
      const node = { connect: (destination) => log.push({ connect: destination }), start: () => log.push({ start: true }) };
      return node;
    }
    get destination() {
      return 'destination';
    }
    async startRendering() {
      log.push({ render: this.args });
      return rendered;
    }
  }
  return { FakeOffline, log };
}

// --- MIME choice ---

test('pickMimeType follows the order and skips failed types', () => {
  const all = () => true;
  assert.equal(audio.pickMimeType(all), 'audio/webm;codecs=opus');
  assert.equal(audio.pickMimeType(all, new Set(['audio/webm;codecs=opus'])), 'audio/webm');
  const safari = (type) => type === 'audio/mp4';
  assert.equal(audio.pickMimeType(safari), 'audio/mp4');
  assert.equal(audio.pickMimeType(safari, new Set(['audio/mp4'])), '');
  assert.equal(audio.pickMimeType(() => { throw new Error('no'); }), '');
});

// --- WAV header ---

test('wavInfo reads 16 kHz mono and 48 kHz stereo headers', () => {
  assert.deepEqual(audio.wavInfo(wavHeader({ rate: 16000, channels: 1, bits: 16, dataBytes: 32000 })), { rate: 16000, channels: 1, bits: 16, durationS: 1 });
  const stereo = audio.wavInfo(wavHeader({ rate: 48000, channels: 2, bits: 16, dataBytes: 48000 * 4 * 2, extraChunk: true }));
  assert.deepEqual(stereo, { rate: 48000, channels: 2, bits: 16, durationS: 2 });
});

test('wavInfo uses the bytes present when the declared size is a placeholder', () => {
  const info = audio.wavInfo(wavHeader({ rate: 16000, channels: 1, bits: 16, dataBytes: 16000, declaredBytes: 0xffffffff }));
  assert.equal(info.durationS, 0.5);
});

test('wavInfo returns null for anything that is not a WAV file', () => {
  assert.equal(audio.wavInfo(new TextEncoder().encode('OggS not a wav file at all').buffer), null);
  assert.equal(audio.wavInfo(new ArrayBuffer(4)), null);
  const noData = wavHeader({ rate: 16000, channels: 1, bits: 16, dataBytes: 0 }).slice(0, 36);
  assert.equal(audio.wavInfo(noData), null);
});

// --- file checks ---

test('file checks: size, length, and unknown length', () => {
  assert.equal(audio.checkFile({ sizeBytes: 10 * 1024 * 1024 + 1, durationS: 5 }), 'TOO_BIG');
  assert.equal(audio.checkFile({ sizeBytes: 1000, durationS: 30.5 }), 'TOO_LONG');
  assert.equal(audio.checkFile({ sizeBytes: 1000, durationS: 30 }), null);
  assert.equal(audio.checkFile({ sizeBytes: 6 * 1024 * 1024 + 1, durationS: null }), 'UNKNOWN_LENGTH');
  assert.equal(audio.checkFile({ sizeBytes: 6 * 1024 * 1024 + 1, durationS: Infinity }), 'UNKNOWN_LENGTH');
  assert.equal(audio.checkFile({ sizeBytes: 6 * 1024 * 1024 - 1, durationS: null }), null);
  assert.equal(audio.FILE_MESSAGES.TOO_BIG, 'This file is over 10 MB.');
});

test('decoded length is refused just over 30.05 s', () => {
  assert.equal(audio.checkDecodedLength(new Float32Array(Math.round(30.05 * 16000))), null);
  assert.equal(audio.checkDecodedLength(new Float32Array(Math.round(30.05 * 16000) + 1)), 'TOO_LONG');
});

// --- samples ---

test('averageChannels mixes to mono and copies a single channel', () => {
  const mono = new Float32Array([0.5, -0.5]);
  const copy = audio.averageChannels([mono]);
  assert.deepEqual([...copy], [0.5, -0.5]);
  assert.notEqual(copy, mono);
  assert.deepEqual([...audio.averageChannels([new Float32Array([1, 0.5, 0]), new Float32Array([0, 0.5, 1])])], [0.5, 0.5, 0.5]);
  assert.equal(audio.averageChannels([new Float32Array(5), new Float32Array(3)]).length, 3);
});

test('clipSamples caps a recording at 480,000 samples', () => {
  const long = new Float32Array(480010);
  assert.equal(audio.clipSamples(long).length, 480000);
  const short = new Float32Array(100);
  assert.equal(audio.clipSamples(short), short);
  assert.equal(audio.MAX_SAMPLES, 480000);
});

// --- resampling to 16 kHz ---

test('decodeTo16k lets the decoder resample into a 16 kHz context and averages channels', async () => {
  const decoded = fakeBuffer([new Float32Array([1, 1, 1, 1]), new Float32Array([0, 0, 0, 0])]);
  const { FakeOffline, log } = fakeOfflineContext({ decoded });
  const input = new ArrayBuffer(64);
  const result = await audio.decodeTo16k(input, { OfflineCtx: FakeOffline });
  assert.equal(result.resampler, 'decoder');
  assert.deepEqual([...result.samples], [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(log[0], { made: { channels: 1, length: 1, rate: 16000 } });
  assert.equal(log[1].decodeAt, 16000);
  assert.notEqual(log[1].buffer, input, 'decodeAudioData gets a copy, so the input stays usable');
  assert.equal(input.byteLength, 64);
});

test('decodeTo16k falls back to a buffer-source render and says so', async () => {
  const decoded = fakeBuffer([new Float32Array(24000), new Float32Array(24000)], { duration: 0.5 });
  const rendered = fakeBuffer([new Float32Array(8000).fill(0.25)]);
  const { FakeOffline, log } = fakeOfflineContext({ primaryFails: true, decoded, rendered });
  const result = await audio.decodeTo16k(new ArrayBuffer(64), { OfflineCtx: FakeOffline });
  assert.equal(result.resampler, 'fallback');
  assert.equal(result.samples.length, 8000);
  assert.equal(result.samples[0], 0.25);
  const decodes = log.filter((entry) => entry.decodeAt).map((entry) => entry.decodeAt);
  assert.deepEqual(decodes, [16000, 48000]);
  assert.deepEqual(log.find((entry) => entry.render).render, { channels: 1, length: 8000, rate: 16000 });
  assert.ok(log.some((entry) => entry.start));
});

test('decodeTo16k rejects when neither path can decode', async () => {
  class Broken {
    async decodeAudioData() {
      throw new DOMException('cannot decode', 'EncodingError');
    }
  }
  await assert.rejects(audio.decodeTo16k(new ArrayBuffer(8), { OfflineCtx: Broken }), { name: 'EncodingError' });
});

// --- microphone ---

test('micErrorCode maps getUserMedia errors', () => {
  assert.equal(audio.micErrorCode({ name: 'NotAllowedError' }), 'MIC_BLOCKED');
  assert.equal(audio.micErrorCode({ name: 'NotFoundError' }), 'NO_MIC');
  assert.equal(audio.micErrorCode({ name: 'NotReadableError' }), 'MIC_BUSY');
  assert.equal(audio.micErrorCode(new Error('odd')), 'MIC_FAILED');
});

function fakeMic({ fail = null } = {}) {
  const track = {
    readyState: 'live',
    stop() { this.readyState = 'ended'; },
    getSettings: () => ({ sampleRate: 48000 }),
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let release;
  const calls = [];
  const mediaDevices = {
    getUserMedia(constraints) {
      calls.push(constraints);
      if (fail) return Promise.reject(Object.assign(new Error('denied'), { name: fail }));
      return new Promise((resolve) => { release = () => resolve(stream); });
    },
  };
  return { track, stream, mediaDevices, calls, grant: () => release() };
}

function fakeRecorder({ throwOnCreate = false } = {}) {
  return class FakeRecorder extends EventTarget {
    static isTypeSupported(type) {
      return type === 'audio/webm;codecs=opus';
    }
    constructor(stream, options) {
      super();
      if (throwOnCreate) throw new Error('NotSupportedError');
      this.options = options;
      this.mimeType = options.mimeType;
      this.audioBitsPerSecond = options.audioBitsPerSecond;
      this.state = 'inactive';
    }
    start() {
      this.state = 'recording';
      queueMicrotask(() => this.dispatchEvent(new Event('start')));
    }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        const data = new Event('dataavailable');
        data.data = new Blob([new Uint8Array([1, 2, 3])]);
        this.dispatchEvent(data);
        this.dispatchEvent(new Event('stop'));
      });
    }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a take asks for the microphone straight away and stops tracks before onEnd', async () => {
  const mic = fakeMic();
  let ended = null;
  let listening = null;
  let clock = 1000;
  const take = audio.startTake({
    processing: false,
    mediaDevices: mic.mediaDevices,
    MediaRecorderImpl: fakeRecorder(),
    audioSession: null,
    now: () => clock,
    onListening: (info) => { listening = info; },
    onEnd: (outcome) => { ended = { outcome, trackState: mic.track.readyState }; },
  });
  assert.equal(mic.calls.length, 1, 'getUserMedia was called before anything was awaited');
  assert.deepEqual(mic.calls[0], { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  clock = 1180;
  mic.grant();
  await flush();
  assert.deepEqual(listening, { pressToListeningMs: 180 });
  assert.equal(take.state, 'listening');
  clock = 3180;
  take.stop();
  await flush();
  assert.equal(ended.trackState, 'ended', 'tracks stopped before onEnd');
  const { outcome } = ended;
  assert.equal(outcome.blob.size, 3);
  assert.equal(outcome.mimeType, 'audio/webm;codecs=opus');
  assert.equal(outcome.bitsPerSecond, 128000);
  assert.equal(outcome.nativeRate, 48000);
  assert.equal(outcome.processing, false);
  assert.equal(outcome.pressToListeningMs, 180);
});

test('released before the stream arrives: discarded, and the late stream is stopped', async () => {
  const mic = fakeMic();
  let outcome = null;
  const take = audio.startTake({ mediaDevices: mic.mediaDevices, MediaRecorderImpl: fakeRecorder(), audioSession: null, now: () => 0, onEnd: (o) => { outcome = o; } });
  take.stop();
  assert.deepEqual(outcome, { error: 'RELEASED_EARLY' });
  mic.grant();
  await flush();
  assert.equal(mic.track.readyState, 'ended');
});

test('a recorder that cannot be created releases the microphone', async () => {
  const mic = fakeMic();
  let outcome = null;
  audio.startTake({ mediaDevices: mic.mediaDevices, MediaRecorderImpl: fakeRecorder({ throwOnCreate: true }), audioSession: null, now: () => 0, onEnd: (o) => { outcome = o; } });
  mic.grant();
  await flush();
  assert.deepEqual(outcome, { error: 'RECORDER_FAILED' });
  assert.equal(mic.track.readyState, 'ended');
});

test('cancel discards the take and releases the microphone', async () => {
  const mic = fakeMic();
  let outcome = null;
  const take = audio.startTake({ mediaDevices: mic.mediaDevices, MediaRecorderImpl: fakeRecorder(), audioSession: null, now: () => 0, onEnd: (o) => { outcome = o; } });
  mic.grant();
  await flush();
  take.cancel();
  await flush();
  assert.deepEqual(outcome, { cancelled: true });
  assert.equal(mic.track.readyState, 'ended');
});

test('a blocked microphone ends the take with MIC_BLOCKED', async () => {
  const mic = fakeMic({ fail: 'NotAllowedError' });
  let outcome = null;
  audio.startTake({ mediaDevices: mic.mediaDevices, MediaRecorderImpl: fakeRecorder(), audioSession: null, now: () => 0, onEnd: (o) => { outcome = o; } });
  await flush();
  assert.deepEqual(outcome, { error: 'MIC_BLOCKED' });
});

test('the iOS audio session is set to auto before recording', () => {
  const mic = fakeMic();
  const session = { type: 'playback' };
  audio.startTake({ mediaDevices: mic.mediaDevices, MediaRecorderImpl: fakeRecorder(), audioSession: session, now: () => 0, onEnd: () => {} });
  assert.equal(session.type, 'auto');
});
