// Minimal MV3 service worker: relays CAPTURE_TWEET messages from the content
// script to the AI backend, and opens the side panel on the toolbar icon
// click. Intentionally thin -- structured extraction and JARVIS actions
// belong to those modules, not extension core.

const MESSAGE_TYPES = Object.freeze({
  CAPTURE_TWEET: 'CAPTURE_TWEET',
});

const CAPTURE_ENDPOINT = 'http://localhost:8000/capture';

// Runs every time the (non-persistent) service worker starts up. The setting
// itself persists across restarts once made, but re-asserting it on every
// startup keeps behavior correct even before the first successful call.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[CaptureAgent] Failed to set side panel behavior', error));

/**
 * @param {import('../content/types.js').CaptureMessage} message
 * @returns {Promise<unknown>}
 */
async function capturePost(message) {
  const { payload, capturedAt } = message;

  const response = await fetch(CAPTURE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'twitter',
      author: payload.author?.displayName || payload.author?.handle || null,
      content: payload.text,
      url: payload.url,
      captured_at: capturedAt,
    }),
  });

  if (!response.ok) {
    throw new Error(`Capture request failed with status ${response.status}`);
  }

  // Let the sidepanel know new data is available so it can refresh. This is
  // a no-op if the sidepanel isn't currently open to receive it.
  chrome.runtime.sendMessage({ type: 'REFRESH_POSTS' }).catch(() => {});

  return response.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TYPES.CAPTURE_TWEET) {
    return false;
  }

  capturePost(message)
    .then((post) => sendResponse({ ok: true, post }))
    .catch((error) => {
      console.error('[CaptureAgent] Capture failed', error);
      sendResponse({ ok: false, error: error.message });
    });

  // Keep the message channel open: capturePost() resolves/rejects
  // asynchronously, and sendResponse() above runs after this listener returns.
  return true;
});
