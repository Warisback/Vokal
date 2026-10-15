// Text to speech through the browser's speechSynthesis. Nothing is spoken except
// inside a tap on Speak, and speak() stays synchronous because iOS requires that.

function langOf(voice) {
  return String(voice.lang || '').toLowerCase().replace('_', '-');
}

function isEnglish(voice) {
  const lang = langOf(voice);
  return lang === 'en' || lang.startsWith('en-');
}

// English only; voices on this device first; within each group en-GB first, then
// other English voices, then by name.
export function orderVoices(voices) {
  const rank = (voice) => (voice.localService ? 0 : 2) + (langOf(voice) === 'en-gb' ? 0 : 1);
  return [...voices]
    .filter(isEnglish)
    .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
}

export function voiceLabel(voice) {
  return voice.localService ? voice.name : `${voice.name} (sends text online to speak)`;
}

export function createSpeech({
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  audioSession = globalThis.navigator?.audioSession,
} = {}) {
  const available = Boolean(synth && Utterance);
  let last = null;

  function voices() {
    if (!available) return [];
    try {
      return orderVoices(synth.getVoices());
    } catch {
      return [];
    }
  }

  function speak(text, { voiceURI = '', rate = 1, onStart, onEnd, onError } = {}) {
    if (!available) {
      if (onError) onError('unavailable');
      return;
    }
    last = { text, options: { voiceURI, rate, onStart, onEnd, onError } };
    try {
      // Keeps output on the loudspeaker after recording on iOS.
      if (audioSession) audioSession.type = 'playback';
    } catch {
      // Not supported here.
    }
    synth.cancel();
    const list = voices();
    const chosen = (voiceURI && list.find((voice) => voice.voiceURI === voiceURI)) || list[0] || null;

    const attempt = (voice, retried) => {
      const utterance = new Utterance(text);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = 'en-GB';
      }
      utterance.rate = rate;
      utterance.onstart = () => {
        if (onStart) onStart(voice);
      };
      utterance.onend = () => {
        if (onEnd) onEnd();
      };
      utterance.onerror = (event) => {
        const code = event && event.error ? event.error : 'unknown';
        if (code === 'interrupted' || code === 'canceled') {
          if (onEnd) onEnd(); // stopped on purpose, not a failure
          return;
        }
        if (!retried && (code === 'network' || code === 'synthesis-failed')) {
          const local = list.find((candidate) => candidate.localService);
          if (local && local !== voice) {
            attempt(local, true);
            return;
          }
        }
        if (onError) onError(code);
      };
      synth.speak(utterance);
    };
    attempt(chosen, false);
  }

  return {
    available,
    voices,
    speak,
    stop() {
      if (available) synth.cancel();
    },
    sayAgain() {
      if (last) speak(last.text, last.options);
    },
    get lastText() {
      return last ? last.text : '';
    },
  };
}
