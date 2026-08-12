// Reads a tweet <article> element and produces a CaptureTweetPayload.
(function (global) {
  const { SELECTORS } = global.CaptureAgent;

  /**
   * @param {Element} article
   * @returns {string|null}
   */
  function extractTweetIdAndUrl(article) {
    const statusLinks = article.querySelectorAll(SELECTORS.statusLink);
    for (const link of statusLinks) {
      const match = link.getAttribute('href')?.match(/\/status\/(\d+)/);
      if (match) {
        return { tweetId: match[1], url: new URL(link.getAttribute('href'), location.origin).href };
      }
    }
    return { tweetId: null, url: null };
  }

  /**
   * @param {Element} article
   * @returns {{handle: string|null, displayName: string|null}}
   */
  function extractAuthor(article) {
    const nameContainer = article.querySelector(SELECTORS.userNameContainer);
    if (!nameContainer) {
      return { handle: null, displayName: null };
    }

    const handleLink = Array.from(nameContainer.querySelectorAll('a[role="link"]')).find((a) =>
      a.getAttribute('href')?.startsWith('/')
    );
    const handle = handleLink ? handleLink.getAttribute('href').replace(/^\//, '').split('/')[0] : null;

    const displayNameSpan = nameContainer.querySelector('span');
    const displayName = displayNameSpan ? displayNameSpan.textContent.trim() : null;

    return { handle, displayName };
  }

  /**
   * @param {Element} article
   * @returns {string}
   */
  function extractText(article) {
    const textNode = article.querySelector(SELECTORS.tweetText);
    return textNode ? textNode.textContent.trim() : '';
  }

  /**
   * @param {Element} article
   * @returns {string|null}
   */
  function extractTimestamp(article) {
    const timeNode = article.querySelector(SELECTORS.time);
    return timeNode ? timeNode.getAttribute('datetime') : null;
  }

  /**
   * @param {Element} article
   * @returns {import('./types.js').CaptureMedia[]}
   */
  function extractMedia(article) {
    const media = [];

    article.querySelectorAll(SELECTORS.photo).forEach((img) => {
      if (img.src) {
        media.push({ type: 'photo', url: img.src });
      }
    });

    article.querySelectorAll(SELECTORS.video).forEach((video) => {
      const src = video.currentSrc || video.src;
      if (src) {
        media.push({ type: 'video', url: src });
      }
    });

    return media;
  }

  /**
   * @param {Element} article
   * @returns {import('./types.js').CaptureTweetPayload}
   */
  function extractTweetPayload(article) {
    const { tweetId, url } = extractTweetIdAndUrl(article);

    return {
      tweetId,
      url,
      author: extractAuthor(article),
      text: extractText(article),
      timestamp: extractTimestamp(article),
      media: extractMedia(article),
    };
  }

  global.CaptureAgent.extractTweetPayload = extractTweetPayload;
})(window);
