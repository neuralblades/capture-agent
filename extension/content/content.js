// Entry point: boots the DOM observer once the page is interactive.
(function (global) {
  function init() {
    global.CaptureAgent.startObserving(document.body);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(window);
