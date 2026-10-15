// Hallucination guard. Whisper invents text on silence and noise ("you", "Thank you.",
// subtitle credits, [Music]). This module removes known inventions before anything is
// shown or spoken. It only ever removes; only the person can add words back.
// The rules and constants match python/vokal/guard.py and shared/guard_cases.json.

export const FILLER_PHRASES = Object.freeze([
  'thank you',
  'thanks for watching',
  'please subscribe',
  'you',
  'bye',
  'thanks',
  'thank you for watching',
  'subscribe',
  'goodbye',
]);
export const CREDIT_SUBSTRINGS = Object.freeze(['subtitles by', 'amara.org', 'www.']);
export const NO_SPEECH_PROB_MAX = 0.6;
export const MIN_SECONDS = 0.3;
export const MIN_LEVEL_DBFS = -60;
export const SILENCE_LEVEL_DBFS = -120;
export const LEVEL_FRAME_MS = 30;
// App only: below this score, a result that was only filler is offered back as a question.
export const FILLER_CONFIRM_BELOW = 0.2;

// JavaScript's \s, written out so the Python guard can use exactly the same set.
const WS = '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const WS_RUN = new RegExp(`[${WS}]+`, 'g');
const SENTENCE_END = new RegExp(`([.!?\\u2026])[${WS}]+`, 'g');
const TAG_SOURCE = '\\[[^\\[\\]]*\\]|\\([^()]*\\)|[\\u266a\\u266b\\u266c]+';
const TAG = new RegExp(TAG_SOURCE, 'g');
// The whitespace before a tag is removed with it, so "water [Music]." becomes "water.".
const TAG_WITH_SPACE = new RegExp(`[${WS}]*(?:${TAG_SOURCE})`, 'g');
const NOT_LETTER_OR_NUMBER = /[^\p{L}\p{N}]/gu;
const FILLER = new Set(FILLER_PHRASES);

function trimSpaces(text) {
  return text.replace(/^ +| +$/g, '');
}

// NFC, every whitespace run becomes one space, then trimmed.
export function tidy(text) {
  return trimSpaces(String(text ?? '').normalize('NFC').replace(WS_RUN, ' '));
}

// Lower case, letters and numbers only, single spaces. Used for comparisons only.
export function normalise(text) {
  return trimSpaces(String(text ?? '').toLowerCase().replace(NOT_LETTER_OR_NUMBER, ' ').replace(/ +/g, ' '));
}

// Sentences end at . ! ? or an ellipsis followed by whitespace, or at a line break.
// Split by replacement rather than lookbehind, which older Safari cannot parse.
function splitPieces(text) {
  const pieces = [];
  for (const line of text.split(/[\r\n]+/)) {
    for (const part of line.replace(SENTENCE_END, '$1\n').split('\n')) {
      const piece = trimSpaces(part.replace(WS_RUN, ' '));
      if (piece) pieces.push(piece);
    }
  }
  return pieces;
}

export function guardText(text) {
  const kept = [];
  const removed = [];
  splitPieces(String(text ?? '').normalize('NFC')).forEach((piece, index) => {
    if (!normalise(piece)) {
      removed.push({ index, text: piece, rule: 'no_words' });
      return;
    }
    const tags = Array.from(piece.matchAll(TAG), (match) => match[0]);
    const rest = tags.length ? trimSpaces(piece.replace(TAG_WITH_SPACE, '').replace(WS_RUN, ' ')) : piece;
    if (!normalise(rest)) {
      removed.push({ index, text: piece, rule: 'annotation' });
      return;
    }
    for (const tag of tags) removed.push({ index, text: tag, rule: 'annotation' });
    const lower = rest.toLowerCase();
    if (CREDIT_SUBSTRINGS.some((credit) => lower.includes(credit))) {
      removed.push({ index, text: rest, rule: 'credit_line' });
      return;
    }
    kept.push({ index, text: rest });
  });
  // Filler is only removed at the end, where Whisper adds it on trailing silence.
  while (kept.length && FILLER.has(normalise(kept[kept.length - 1].text))) {
    const last = kept.pop();
    removed.push({ index: last.index, text: last.text, rule: 'filler' });
  }
  // Stable sort: by sentence, then in the order found within a sentence.
  removed.sort((a, b) => a.index - b.index);
  return {
    text: kept.map((piece) => piece.text).join(' '),
    removed: removed.map(({ text: removedText, rule }) => ({ text: removedText, rule })),
  };
}

export function guardUtterance({ text, noSpeechProb }, { noSpeechMax = NO_SPEECH_PROB_MAX } = {}) {
  if (typeof noSpeechProb === 'number' && noSpeechProb > noSpeechMax) {
    const tidied = tidy(text);
    return { text: '', removed: tidied ? [{ text: tidied, rule: 'no_speech' }] : [] };
  }
  return guardText(text);
}

// What to offer when the guard left nothing to speak.
export function emptyOutcome(result, noSpeechProb) {
  if (result.text) return null;
  if (!result.removed.length) return 'nothing';
  const onlyFiller = result.removed.every((entry) => entry.rule === 'filler');
  if (onlyFiller && typeof noSpeechProb === 'number' && noSpeechProb < FILLER_CONFIRM_BELOW) return 'confirm';
  return 'offer';
}

// Level of the loudest fixed 30 ms frame, in dBFS. Not voice activity detection:
// it only catches a muted microphone or a near-silent take before a model call.
export function levelDbfs(samples, rate) {
  const count = samples.length;
  if (count === 0) return SILENCE_LEVEL_DBFS;
  const frame = Math.max(1, Math.floor((rate * LEVEL_FRAME_MS) / 1000));
  let loudest = 0;
  for (let start = 0; start < count; start += frame) {
    const end = Math.min(count, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const meanSquare = sum / (end - start);
    if (meanSquare > loudest) loudest = meanSquare;
  }
  return 10 * Math.log10(loudest + 1e-12);
}

export function preCheck({ durationS, levelDbfs: level }) {
  if (durationS < MIN_SECONDS) return 'too_short';
  if (level <= SILENCE_LEVEL_DBFS) return 'no_signal';
  if (level < MIN_LEVEL_DBFS) return 'too_quiet';
  return null;
}
