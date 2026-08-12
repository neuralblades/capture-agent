// Builds and dispatches the typed CaptureMessage to the background service worker.
(function (global) {
  const { MESSAGE_TYPES, CONTRACT_VERSION } = global.CaptureAgent;

  /**
   * @param {import('./types.js').CaptureTweetPayload} payload
   * @returns {import('./types.js').CaptureMessage}
   */
  function buildCaptureMessage(payload) {
    return {
      type: MESSAGE_TYPES.CAPTURE_TWEET,
      version: CONTRACT_VERSION,
      payload,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * @param {import('./types.js').CaptureTweetPayload} payload
   * @returns {Promise<any>}
   */
  function sendCapturePayload(payload) {
    const message = buildCaptureMessage(payload);

    return new Promise((resolve, reject) => {
      // chrome.runtime.id disappears once the extension is reloaded/updated,
      // even though the old content script (and its chrome.runtime reference)
      // is still alive on the page. Calling sendMessage in that state throws
      // synchronously in some browsers and hangs silently in others, so check
      // up front and fail with a consistent, catchable error either way.
      if (!chrome.runtime?.id) {
        reject(new Error('Extension context invalidated'));
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  global.CaptureAgent.sendCapturePayload = sendCapturePayload;
})(window);
