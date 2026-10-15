import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeech, orderVoices, voiceLabel } from '../js/speech.js';

const voice = (name, lang, localService, voiceURI = name) => ({ name, lang, localService, voiceURI });

const VOICES = [
  voice('Zed online', 'en-GB', false),
  voice('Amy', 'en-US', true),
  voice('Hazel', 'en-GB', true),
  voice('Marie', 'fr-FR', true),
  voice('Libby online', 'en-GB', false),
  voice('Aria online', 'en-US', false),
  voice('Kate', 'en_GB', true),
];

class FakeUtterance {
  constructor(text) {
    this.text = text;
  }
}

function fakeSynth(voices = VOICES) {
  const log = [];
  return {
    log,
    spoken: [],
    getVoices: () => voices,
    cancel() {
      log.push('cancel');
    },
    speak(utterance) {
      log.push('speak');
      this.spoken.push(utterance);
    },
  };
}

test('orderVoices keeps English, local first, en-GB first within each group', () => {
  assert.deepEqual(orderVoices(VOICES).map((v) => v.name), ['Hazel', 'Kate', 'Amy', 'Libby online', 'Zed online', 'Aria online']);
});

test('voiceLabel marks voices that send text online', () => {
  assert.equal(voiceLabel(voice('Hazel', 'en-GB', true)), 'Hazel');
  assert.equal(voiceLabel(voice('Libby online', 'en-GB', false)), 'Libby online (sends text online to speak)');
});

test('speak cancels first, then speaks with the chosen voice and rate', () => {
  const synth = fakeSynth();
  const speech = createSpeech({ synth, Utterance: FakeUtterance, audioSession: null });
  speech.speak('I want water.', { voiceURI: 'Amy', rate: 1.2 });
  assert.deepEqual(synth.log, ['cancel', 'speak']);
  const [utterance] = synth.spoken;
  assert.equal(utterance.text, 'I want water.');
  assert.equal(utterance.voice.name, 'Amy');
  assert.equal(utterance.rate, 1.2);
});

test('without a chosen voice it uses the first local English voice', () => {
  const synth = fakeSynth();
  createSpeech({ synth, Utterance: FakeUtterance, audioSession: null }).speak('Hello.');
  assert.equal(synth.spoken[0].voice.name, 'Hazel');
  const missing = fakeSynth();
  createSpeech({ synth: missing, Utterance: FakeUtterance, audioSession: null }).speak('Hello.', { voiceURI: 'Gone' });
  assert.equal(missing.spoken[0].voice.name, 'Hazel');
});

test('with no voices at all the voice is left unset', () => {
  const synth = fakeSynth([]);
  createSpeech({ synth, Utterance: FakeUtterance, audioSession: null }).speak('Hello.');
  assert.equal(synth.spoken[0].voice, undefined);
  assert.equal(synth.spoken[0].lang, 'en-GB');
});

test('the iOS audio session is set to playback', () => {
  const session = { type: 'auto' };
  createSpeech({ synth: fakeSynth(), Utterance: FakeUtterance, audioSession: session }).speak('Hello.');
  assert.equal(session.type, 'playback');
});

test('a network error retries once with a local voice, then reports once', () => {
  const synth = fakeSynth();
  const errors = [];
  createSpeech({ synth, Utterance: FakeUtterance, audioSession: null })
    .speak('Hello.', { voiceURI: 'Libby online', onError: (code) => errors.push(code) });
  assert.equal(synth.spoken[0].voice.name, 'Libby online');
  synth.spoken[0].onerror({ error: 'network' });
  assert.equal(synth.spoken.length, 2);
  assert.equal(synth.spoken[1].voice.name, 'Hazel');
  assert.deepEqual(errors, []);
  synth.spoken[1].onerror({ error: 'synthesis-failed' });
  assert.equal(synth.spoken.length, 2, 'no third attempt');
  assert.deepEqual(errors, ['synthesis-failed']);
});

test('no retry when the failed voice is already the local one', () => {
  const synth = fakeSynth();
  const errors = [];
  createSpeech({ synth, Utterance: FakeUtterance, audioSession: null }).speak('Hello.', { onError: (code) => errors.push(code) });
  synth.spoken[0].onerror({ error: 'synthesis-failed' });
  assert.equal(synth.spoken.length, 1);
  assert.deepEqual(errors, ['synthesis-failed']);
});

test('interrupted and canceled are not errors', () => {
  const synth = fakeSynth();
  const errors = [];
  let ended = 0;
  createSpeech({ synth, Utterance: FakeUtterance, audioSession: null })
    .speak('Hello.', { onError: (code) => errors.push(code), onEnd: () => { ended++; } });
  synth.spoken[0].onerror({ error: 'interrupted' });
  synth.spoken[0].onerror({ error: 'canceled' });
  assert.deepEqual(errors, []);
  assert.equal(ended, 2);
});

test('start and end callbacks fire', () => {
  const synth = fakeSynth();
  const events = [];
  createSpeech({ synth, Utterance: FakeUtterance, audioSession: null })
    .speak('Hello.', { onStart: () => events.push('start'), onEnd: () => events.push('end') });
  synth.spoken[0].onstart();
  synth.spoken[0].onend();
  assert.deepEqual(events, ['start', 'end']);
});

test('say again repeats the last words; stop cancels', () => {
  const synth = fakeSynth();
  const speech = createSpeech({ synth, Utterance: FakeUtterance, audioSession: null });
  speech.speak('First.');
  speech.sayAgain();
  assert.deepEqual(synth.spoken.map((u) => u.text), ['First.', 'First.']);
  assert.equal(speech.lastText, 'First.');
  speech.stop();
  assert.equal(synth.log.at(-1), 'cancel');
});

test('without speechSynthesis it reports unavailable and speaks nothing', () => {
  const speech = createSpeech({ synth: undefined, Utterance: undefined, audioSession: null });
  const errors = [];
  assert.equal(speech.available, false);
  assert.deepEqual(speech.voices(), []);
  speech.speak('Hello.', { onError: (code) => errors.push(code) });
  assert.deepEqual(errors, ['unavailable']);
});
