// Minimal MV3 service worker: acknowledges CAPTURE_TWEET messages from the
// content script. Intentionally thin -- routing captures into the AI backend
// and JARVIS actions belongs to those modules, not extension core.

const MESSAGE_TYPES = Object.freeze({
  CAPTURE_TWEET: 'CAPTURE_TWEET',
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TYPES.CAPTURE_TWEET) {
    return false;
  }

  console.log('[CaptureAgent] Received capture payload', message);
  sendResponse({ ok: true, received: message.type });
  return true;
});
