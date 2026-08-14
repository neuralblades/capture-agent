// Shared helper for submitting a captured post to the backend and notifying
// any open sidepanel to refresh. Used by both the content-script message
// handlers (background.js) and the context-menu capture flow (context_menu.js)
// so the two entry points don't duplicate the fetch + notify logic.

import { incrementMetric, MetricName } from '../sidepanel/metrics.js';

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

  const result = await response.json();

  // Funnel metrics count captured events, not live post rows, so a later
  // dismiss (which deletes the post) doesn't retroactively shrink this total.
  // Only job/application-type opportunities count toward the funnel -- books,
  // articles, and other general captures aren't something the user "applies"
  // to, so including them would understate the real conversion rate.
  if (result.is_opportunity) {
    await incrementMetric(MetricName.CAPTURES_TOTAL).catch((error) =>
      console.error('[CaptureAgent] Failed to record capture metric', error)
    );
  }

  // Let the sidepanel know new data is available so it can refresh. This is
  // a no-op if the sidepanel isn't currently open to receive it.
  chrome.runtime.sendMessage({ type: 'REFRESH_POSTS' }).catch(() => {});

  return result;
}
