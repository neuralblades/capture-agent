// Shared helper for submitting a captured post to the backend and notifying
// any open sidepanel to refresh. Used by both the content-script message
// handlers (background.js) and the context-menu capture flow (context_menu.js)
// so the two entry points don't duplicate the fetch + notify logic.

const CAPTURE_ENDPOINT = 'http://localhost:8000/capture';

/**
 * @param {{platform: string, author?: string|null, content: string, url?: string|null, capturedAt?: string|null}} post
 * @returns {Promise<unknown>}
 */
export async function submitCapture(post) {
  const response = await fetch(CAPTURE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: post.platform,
      author: post.author ?? null,
      content: post.content,
      url: post.url ?? null,
      captured_at: post.capturedAt ?? null,
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
