// Runs before the module script, as a classic script with no imports, so it still
// works on browsers that cannot load the rest. If speech to text cannot run here,
// it marks the page and shows a notice; typing, Speak and Show on screen still work.
(function () {
  'use strict';

  function moduleWorkers() {
    var ok = false;
    try {
      // The URL cannot be parsed, so nothing is fetched. Browsers that know the
      // type option read it before they fail.
      new Worker('http://[', {
        get type() {
          ok = true;
          return 'module';
        },
      });
    } catch (e) {
      // Expected.
    }
    return ok;
  }

  function wasmSimd() {
    try {
      // A tiny module that uses a SIMD instruction. Validation compiles nothing.
      return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3,
        2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch (e) {
      return false;
    }
  }

  var supported = typeof Worker === 'function' && moduleWorkers() &&
    typeof WebAssembly === 'object' && wasmSimd() &&
    typeof OfflineAudioContext === 'function' &&
    typeof MediaRecorder === 'function' &&
    typeof caches === 'object';

  document.documentElement.dataset.asr = supported ? 'on' : 'off';
  if (!supported) {
    var show = function () {
      var notice = document.getElementById('unsupported');
      if (notice) notice.hidden = false;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
    else show();
  }
})();
