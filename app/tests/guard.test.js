import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as guard from '../js/guard.js';

const cases = JSON.parse(readFileSync(new URL('../../shared/guard_cases.json', import.meta.url), 'utf8'));

// Zeros, with +amplitude at even indices and -amplitude at odd ones inside each burst.
function buildSignal({ samples, bursts }) {
  const signal = new Float32Array(samples);
  for (const burst of bursts) {
    for (let i = burst.start; i < burst.start + burst.length; i++) {
      signal[i] = i % 2 === 0 ? burst.amplitude : -burst.amplitude;
    }
  }
  return signal;
}

test('constants equal the shared case file', () => {
  const c = cases.constants;
  assert.deepEqual([...guard.FILLER_PHRASES], c.filler_phrases);
  assert.deepEqual([...guard.CREDIT_SUBSTRINGS], c.credit_substrings);
  assert.equal(guard.NO_SPEECH_PROB_MAX, c.no_speech_prob_max);
  assert.equal(guard.MIN_SECONDS, c.min_seconds);
  assert.equal(guard.MIN_LEVEL_DBFS, c.min_level_dbfs);
  assert.equal(guard.SILENCE_LEVEL_DBFS, c.silence_level_dbfs);
  assert.equal(guard.LEVEL_FRAME_MS, c.level_frame_ms);
});

for (const c of cases.text_cases) {
  test(`text case ${c.id}`, () => {
    const result = guard.guardText(c.input);
    assert.equal(result.text, c.expected);
    assert.deepEqual(result.removed, c.removed);
  });
}

for (const c of cases.utterance_cases) {
  test(`utterance case ${c.id}`, () => {
    const result = guard.guardUtterance({ text: c.text, noSpeechProb: c.no_speech_prob });
    assert.equal(result.text, c.expected);
    assert.deepEqual(result.removed, c.removed);
  });
}

for (const c of cases.level_cases) {
  test(`level case ${c.id}`, () => {
    const level = guard.levelDbfs(buildSignal(c), c.rate);
    assert.ok(Math.abs(level - c.expected_dbfs) <= 0.01, `${level} is not within 0.01 dB of ${c.expected_dbfs}`);
  });
}

for (const c of cases.precheck_cases) {
  test(`pre-check case ${c.id}`, () => {
    assert.equal(guard.preCheck({ durationS: c.duration_s, levelDbfs: c.level_dbfs }), c.expected);
  });
}

test('the case file has every section the design lists', () => {
  assert.equal(cases.version, 2);
  assert.ok(cases.text_cases.length >= 72);
  assert.ok(cases.utterance_cases.length >= 10);
  assert.ok(cases.level_cases.length >= 7);
  assert.ok(cases.precheck_cases.length >= 11);
});

test('emptyOutcome decides what to offer when nothing is left', () => {
  const filler = { text: '', removed: [{ text: 'Thank you.', rule: 'filler' }] };
  assert.equal(guard.emptyOutcome(filler, 0.1), 'confirm');
  assert.equal(guard.emptyOutcome(filler, 0.2), 'offer');
  assert.equal(guard.emptyOutcome(filler, null), 'offer');
  assert.equal(guard.emptyOutcome({ text: '', removed: [{ text: '[Music]', rule: 'annotation' }] }, 0.01), 'offer');
  assert.equal(guard.emptyOutcome({ text: '', removed: [] }, 0.9), 'nothing');
  assert.equal(guard.emptyOutcome({ text: 'I want water.', removed: [] }, 0.01), null);
  const mixed = { text: '', removed: [{ text: '[Music]', rule: 'annotation' }, { text: 'Bye.', rule: 'filler' }] };
  assert.equal(guard.emptyOutcome(mixed, 0.01), 'offer');
});

test('guardUtterance takes a custom threshold', () => {
  const result = guard.guardUtterance({ text: 'I want water.', noSpeechProb: 0.5 }, { noSpeechMax: 0.4 });
  assert.deepEqual(result, { text: '', removed: [{ text: 'I want water.', rule: 'no_speech' }] });
});

test('tidy collapses line breaks and no-break spaces', () => {
  assert.equal(guard.tidy(' I want\r\nwater\u00a0now. '), 'I want water now.');
  assert.equal(guard.tidy('Cafe\u0301'), 'Caf\u00e9');
  assert.equal(guard.tidy(undefined), '');
});

test('normalise keeps letters and numbers only', () => {
  assert.equal(guard.normalise('Thank-you!!!'), 'thank you');
  assert.equal(guard.normalise('Room 12, please.'), 'room 12 please');
  assert.equal(guard.normalise('...'), '');
});
