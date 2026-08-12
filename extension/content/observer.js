// Watches X.com's timeline for tweet cards streamed in via client-side
// routing/virtualized scroll and injects the capture button into each.
(function (global) {
  const { SELECTORS } = global.CaptureAgent;

  const SCAN_DEBOUNCE_MS = 150;

  let debounceTimer = null;

  function scanForTweets(root) {
    root.querySelectorAll(SELECTORS.tweetArticle).forEach((article) => {
      global.CaptureAgent.injectIntoTweet(article);
    });
  }

  function scheduleScan(root) {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scanForTweets(root);
    }, SCAN_DEBOUNCE_MS);
  }

  /**
   * @param {Element} root - node to observe (defaults to document.body)
   */
  function startObserving(root = document.body) {
    scanForTweets(root);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          scheduleScan(root);
          return;
        }
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    return observer;
  }

  global.CaptureAgent.startObserving = startObserving;
})(window);
