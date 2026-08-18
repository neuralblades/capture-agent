// Reads a tweet <article> element and produces a CaptureTweetPayload.
(function (global) {
  const { SELECTORS } = global.CaptureAgent;

  /**
   * True if `node` sits inside a quote-tweet card nested within `article`
   * (but is not `article` itself).
   * @param {Element} node
   * @param {Element} article
   * @returns {boolean}
   */
  function isInsideQuoteTweet(node, article) {
    const container = node.closest(SELECTORS.quoteTweetContainer);
    return Boolean(container) && container !== article && article.contains(container);
  }

  /**
   * querySelectorAll scoped to `article`'s own content, excluding anything
   * nested inside a quote-tweet card.
   * @param {Element} article
   * @param {string} selector
   * @returns {Element[]}
   */
  function queryOwn(article, selector) {
    return Array.from(article.querySelectorAll(selector)).filter((node) => !isInsideQuoteTweet(node, article));
  }

  /**
   * @param {Element} article
   * @param {string} selector
   * @returns {Element|null}
   */
  function queryOwnFirst(article, selector) {
    return queryOwn(article, selector)[0] ?? null;
  }

  /**
   * @param {Element} article
   * @returns {{tweetId: string|null, url: string|null}}
   */
  function extractTweetIdAndUrl(article) {
    const statusLinks = queryOwn(article, SELECTORS.statusLink);
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
    const nameContainer = queryOwnFirst(article, SELECTORS.userNameContainer);
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
    const textNode = queryOwnFirst(article, SELECTORS.tweetText);
    if (!textNode) return '';

    // X routes every external link through its own t.co redirect: the
    // anchor's href attribute is always the opaque t.co URL, never the real
    // destination -- it's the *visible* text that holds the real URL,
    // truncated with a trailing ellipsis for long ones (e.g.
    // "docs.google.com/forms/d/e/…"). A complete visible URL is strictly
    // more useful than the opaque t.co redirect, so only fall back to the
    // anchor's href (t.co -- still a working link, just not a readable one)
    // when the visible text was actually truncated. Mentions/hashtags use
    // relative hrefs ("/handle", "/hashtag/x") and are left as their visible
    // text either way.
    const clone = textNode.cloneNode(true);
    clone.querySelectorAll('a[href]').forEach((anchor) => {
      if (/^https?:\/\//i.test(anchor.getAttribute('href') || '') && anchor.textContent.includes('…')) {
        anchor.textContent = anchor.href;
      }
    });

    return clone.textContent.trim();
  }

  /**
   * @param {Element} article
   * @returns {string|null}
   */
  function extractTimestamp(article) {
    const timeNode = queryOwnFirst(article, SELECTORS.time);
    return timeNode ? timeNode.getAttribute('datetime') : null;
  }

  /**
   * @param {Element} article
   * @returns {import('./types.js').CaptureMedia[]}
   */
  function extractMedia(article) {
    const media = [];

    queryOwn(article, SELECTORS.photo).forEach((img) => {
      if (img.src) {
        media.push({ type: 'photo', url: img.src });
      }
    });

    queryOwn(article, SELECTORS.video).forEach((video) => {
      const src = video.currentSrc || video.src;
      if (src) {
        media.push({ type: 'video', url: src });
      }
    });

    return media;
  }

  /**
   * The tweet's primary image, for use as a representative thumbnail: the
   * first photo if the tweet has one, else a video's poster frame (the still
   * image X shows before playback), else null for text-only tweets.
   * @param {import('./types.js').CaptureMedia[]} media
   * @returns {string|null}
   */
  function extractImageUrl(article, media) {
    const photo = media.find((item) => item.type === 'photo');
    if (photo) return photo.url;

    const video = queryOwnFirst(article, SELECTORS.video);
    return video?.poster || null;
  }

  /**
   * @param {Element} article
   * @returns {import('./types.js').CaptureTweetPayload}
   */
  function extractTweetPayload(article) {
    const { tweetId, url } = extractTweetIdAndUrl(article);
    const media = extractMedia(article);

    return {
      tweetId,
      url,
      author: extractAuthor(article),
      text: extractText(article),
      timestamp: extractTimestamp(article),
      media,
      imageUrl: extractImageUrl(article, media),
    };
  }

  global.CaptureAgent.extractTweetPayload = extractTweetPayload;
})(window);
