// Setup: home screen (iOS only), speech model, microphone, phrase bank.
// Every step can be skipped and "Finish for now" is always there. Suggestions are
// never requested during setup.

import { tidy } from './guard.js';

const byId = (id) => document.getElementById(id);

const STEP_IDS = { home: 'setup-step-home', model: 'setup-step-model', mic: 'setup-step-mic', phrases: 'setup-step-phrases' };

// iOS Safari outside a home-screen app. iPadOS reports itself as a Mac with touch.
export function isIosBrowserTab(nav = globalThis.navigator, matchMediaImpl = globalThis.matchMedia) {
  const ios = /iP(hone|ad|od)/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  if (!ios) return false;
  const standalone = nav.standalone === true || (matchMediaImpl && matchMediaImpl('(display-mode: standalone)').matches);
  return !standalone;
}

export function createOnboarding(ctx) {
  let steps = [];
  let index = 0;
  let phrase = null; // { target, own }
  let heard = null; // { text, usedAnyway, capture }
  let pending = null; // a result whose words were removed, waiting for "Yes" or "Use it anyway"
  let requestId = 0;

  // --- navigation ---

  function render() {
    const current = steps[index];
    for (const [name, id] of Object.entries(STEP_IDS)) byId(id).hidden = name !== current;
    byId('setup-progress').textContent = `Step ${index + 1} of ${steps.length}`;
    const last = index === steps.length - 1;
    byId('setup-next').hidden = last;
    byId('setup-skip').hidden = last;
    byId('setup-finish').textContent = last ? 'Finish' : 'Finish for now';
    if (current === 'model') renderModel(ctx.model.get());
    if (current === 'mic') renderMic();
    if (current === 'phrases') renderPhrases();
  }

  function focusStep() {
    const heading = byId(STEP_IDS[steps[index]]).querySelector('h2');
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }

  function go(next) {
    phraseControl.discard();
    micTest.stop();
    index = Math.min(steps.length - 1, Math.max(0, next));
    render();
    focusStep();
  }

  function finish() {
    phraseControl.discard();
    micTest.stop();
    ctx.finish();
  }

  // --- step 1: speech model ---

  function renderModel(model) {
    const settings = ctx.getSettings();
    for (const [key, id] of [['tiny.en', 'setup-model-tiny'], ['base.en', 'setup-model-base']]) {
      byId(id).checked = settings.model === key;
      const size = ctx.model.sizeMb(key);
      byId(`${id}-size`).textContent = size ? `${size} MB` : '';
    }
    const busy = ['checking', 'downloading', 'loading'].includes(model.status);
    const download = byId('setup-download');
    download.hidden = model.status === 'ready' || model.status === 'unsupported';
    download.disabled = busy || model.status === 'invalid';
    const progress = ctx.model.progress();
    byId('setup-progress-block').hidden = !progress.active;
    const bar = byId('setup-model-progress');
    if (progress.value === null) bar.removeAttribute('value');
    else bar.value = progress.value;
    byId('setup-model-progress-text').textContent = progress.text;
    const status = {
      unsupported: 'This browser cannot run the speech model. You can still type.',
      invalid: 'The custom model name in Settings is not valid.',
      checking: 'Checking for the speech model.',
      missing: 'Not downloaded yet.',
      downloading: 'Downloading. Keep this page open.',
      loading: 'Loading the speech model.',
      paused: 'Choose how to load the speech model at the top of the page.',
      error: model.error ? model.error.message : 'The speech model could not start.',
      ready: model.note || 'The speech model is ready on this device.',
    }[model.status] || '';
    byId('setup-model-status').textContent = settings.model === 'custom' && model.status !== 'ready'
      ? `Custom model: ${settings.customModel}. ${status}` : status;
  }

  // --- step 2: microphone ---

  const micTest = (() => {
    const button = byId('setup-mic-test');
    const label = byId('setup-mic-test-label');
    const meter = ctx.microphone.createMeter(byId('setup-mic-meter'));
    let take = null;
    const tapMode = () => ctx.getSettings().captureMode === 'tap';
    const idle = () => (tapMode() ? 'Tap to test' : 'Hold to test');

    function reset() {
      button.setAttribute('aria-pressed', 'false');
      label.textContent = idle();
    }

    function begin() {
      if (take) return;
      ctx.announcer.hold();
      button.setAttribute('aria-pressed', 'true');
      label.textContent = 'Starting';
      take = ctx.microphone.startTake({
        onStreamReady: (stream) => meter.attach(stream),
        onListening: () => {
          label.textContent = tapMode() ? 'Listening. Tap to stop' : 'Listening. Release to stop';
        },
        onEnd: (outcome) => {
          take = null;
          meter.detach();
          reset();
          ctx.announcer.release();
          if (outcome.error && outcome.error !== 'RELEASED_EARLY') {
            byId('setup-mic-status').textContent = 'The microphone could not start. Check it is not in use by another app.';
          }
        },
      });
    }

    // The test keeps nothing: the take is always discarded.
    function stop() {
      if (take) take.cancel();
    }

    button.addEventListener('pointerdown', (event) => {
      if (tapMode() || event.button !== 0) return;
      event.preventDefault();
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Release still arrives without capture.
      }
      begin();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, () => {
        if (!tapMode()) stop();
      });
    }
    button.addEventListener('click', () => {
      if (!tapMode()) return;
      if (take) stop();
      else begin();
    });
    button.addEventListener('keydown', (event) => {
      if (tapMode() || (event.key !== ' ' && event.key !== 'Enter')) return;
      event.preventDefault();
      if (!event.repeat) begin();
    });
    button.addEventListener('keyup', (event) => {
      if (tapMode() || (event.key !== ' ' && event.key !== 'Enter')) return;
      event.preventDefault();
      stop();
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    reset();
    return { stop, reset };
  })();

  function renderMic() {
    const ready = ctx.microphone.isReady();
    byId('setup-mic-try').hidden = !ready;
    byId('setup-mic-allow').hidden = ready;
    if (ready) byId('setup-mic-status').textContent = 'The microphone is on for Vokal.';
    micTest.reset();
  }

  async function allowMicrophone() {
    const status = byId('setup-mic-status');
    status.textContent = 'Asking for the microphone.';
    const problem = await ctx.microphone.warm();
    status.textContent = problem || 'Microphone on.';
    ctx.announcer.say(status.textContent);
    if (!problem) renderMic();
  }

  // --- step 3: phrase bank ---

  function setPhraseStatus(text, { announce = true } = {}) {
    byId('setup-phrase-status').textContent = text;
    if (announce && text) ctx.announcer.say(text);
  }

  function renderPhrases(saved = '') {
    const count = `${ctx.phrases.count()} of ${ctx.phrases.max} phrases saved.`;
    byId('setup-phrase-count').textContent = saved ? `Saved \u201c${saved}\u201d. ${count}` : count;
  }

  function hideResult() {
    heard = null;
    pending = null;
    byId('setup-heard').hidden = true;
    byId('setup-empty').hidden = true;
  }

  function choosePhrase(target) {
    phrase = { target, own: target === '' };
    hideResult();
    byId('setup-phrase-panel').hidden = false;
    byId('setup-phrase-prompt').textContent = phrase.own ? 'Say your own phrase' : 'Say this phrase';
    byId('setup-phrase-target').hidden = phrase.own;
    byId('setup-phrase-target').textContent = target;
    setPhraseStatus(ctx.model.get().status === 'ready' ? '' : 'Download the speech model first, in the speech model step or in Settings.', { announce: false });
    byId('setup-phrase-prompt').setAttribute('tabindex', '-1');
    byId('setup-phrase-prompt').focus();
  }

  function showHeard(text, usedAnyway, capture) {
    heard = { text, usedAnyway, capture };
    byId('setup-empty').hidden = true;
    byId('setup-heard').hidden = false;
    byId('setup-heard-text').textContent = text;
    byId('setup-meant').value = phrase.own ? text : phrase.target;
    byId('setup-confirm').checked = false;
    byId('setup-save').disabled = true;
    setPhraseStatus('Check the words you meant, then save.', { announce: false });
    ctx.announcer.say(`Heard: \u201c${text}\u201d Check the words you meant, then save.`);
    byId('setup-confirm').focus();
  }

  function showEmpty(out) {
    pending = { raw: tidy(out.raw), capture: out.capture };
    const confirm = out.outcome === 'confirm';
    byId('setup-empty').hidden = false;
    byId('setup-empty-message').textContent = confirm ? `Did you say \u201c${pending.raw}\u201d?` : ctx.messages.didntCatch;
    byId('setup-empty-yes').hidden = !confirm;
    byId('setup-empty-no').hidden = !confirm;
    byId('setup-use-anyway').hidden = confirm || out.outcome !== 'offer';
    setPhraseStatus(byId('setup-empty-message').textContent);
    if (confirm) byId('setup-empty-yes').focus();
  }

  async function onPhraseTake(recording) {
    const id = ++requestId;
    ctx.bumpRequest();
    setPhraseStatus('Working', { announce: false });
    const out = await ctx.transcribeRecording(recording);
    if (id !== requestId) return;
    if (out.kind === 'decode') return setPhraseStatus(out.message);
    if (out.kind === 'precheck') return setPhraseStatus(ctx.messages.precheck[out.code]);
    if (out.kind === 'error') {
      if (out.error.code !== 'SUPERSEDED') setPhraseStatus(out.error.message);
      return;
    }
    if (out.guarded.text) showHeard(out.guarded.text, false, out.capture);
    else if (out.outcome === 'nothing') setPhraseStatus(ctx.messages.didntCatch);
    else showEmpty(out);
  }

  // "Use it anyway" and "Yes, use it": the tidied raw text becomes what was heard.
  function usePending() {
    if (pending && pending.raw) showHeard(pending.raw, true, pending.capture);
  }

  function updateSave() {
    byId('setup-save').disabled = !(byId('setup-confirm').checked && byId('setup-meant').value.trim());
  }

  function savePhrase() {
    const identity = ctx.model.identity();
    if (!heard || !identity) {
      setPhraseStatus('Load the speech model before saving phrases.');
      return;
    }
    const intended = tidy(byId('setup-meant').value);
    const result = ctx.phrases.add({
      intended,
      heard: heard.text,
      usedAnyway: heard.usedAnyway,
      model: identity,
      capture: heard.capture,
    });
    const errors = {
      FULL: `You have ${ctx.phrases.max} phrases, the most Vokal keeps. Remove one in Settings first.`,
      INTENDED_INVALID: 'Write the words you meant, up to 300 characters.',
      HEARD_INVALID: 'Nothing usable was heard. Record the phrase again.',
    };
    if (result.error) {
      setPhraseStatus(errors[result.error] || 'This phrase could not be saved.');
      return;
    }
    hideResult();
    byId('setup-phrase-panel').hidden = true;
    renderPhrases(intended);
    ctx.announcer.say(byId('setup-phrase-count').textContent);
    document.querySelector('.phrase-choice').focus();
  }

  const phraseControl = ctx.createRecordControl({
    button: byId('setup-record'),
    label: byId('setup-record-label'),
    timer: byId('setup-record-timer'),
    cancel: byId('setup-record-cancel'),
    canvas: byId('setup-phrase-meter'),
    onStart: () => {
      requestId++;
      hideResult();
      setPhraseStatus('Starting', { announce: false });
    },
    onListening: () => setPhraseStatus('Listening', { announce: false }),
    onTake: onPhraseTake,
    onMessage: (message) => setPhraseStatus(message),
  });

  // --- wiring ---

  byId('setup-next').addEventListener('click', () => go(index + 1));
  byId('setup-skip').addEventListener('click', () => go(index + 1));
  byId('setup-finish').addEventListener('click', finish);
  byId('setup-home-continue').addEventListener('click', () => go(index + 1));
  for (const id of ['setup-model-tiny', 'setup-model-base']) {
    byId(id).addEventListener('change', (event) => ctx.model.select(event.target.value));
  }
  byId('setup-download').addEventListener('click', () => ctx.model.download());
  byId('setup-mic-allow').addEventListener('click', allowMicrophone);
  for (const button of document.querySelectorAll('.phrase-choice')) {
    button.addEventListener('click', () => choosePhrase(button.dataset.phrase));
  }
  byId('setup-empty-yes').addEventListener('click', usePending);
  byId('setup-use-anyway').addEventListener('click', usePending);
  byId('setup-empty-no').addEventListener('click', () => {
    hideResult();
    setPhraseStatus('Not used. Record the phrase again.');
  });
  byId('setup-confirm').addEventListener('change', updateSave);
  byId('setup-meant').addEventListener('input', updateSave);
  byId('setup-save').addEventListener('click', savePhrase);
  ctx.model.subscribe((model) => {
    if (steps[index] === 'model') renderModel(model);
  });

  return {
    start(stepName) {
      ctx.bumpRequest();
      steps = [...(isIosBrowserTab() ? ['home'] : []), 'model', 'mic', 'phrases'];
      index = stepName ? Math.max(0, steps.indexOf(stepName)) : 0;
      byId('setup-phrase-panel').hidden = true;
      hideResult();
      ctx.showScreen('setup');
      render();
    },
  };
}
