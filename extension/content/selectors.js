// Centralized DOM selectors for X.com's tweet markup.
// X.com ships obfuscated class names but keeps stable data-testid hooks;
// isolating them here means markup drift only needs a change in one place.
(function (global) {
  const SELECTORS = {
    tweetArticle: 'article[data-testid="tweet"]',
    tweetText: '[data-testid="tweetText"]',
    userNameContainer: '[data-testid="User-Name"]',
    statusLink: 'a[href*="/status/"]',
    time: 'time',
    actionBar: '[role="group"]',
    photo: '[data-testid="tweetPhoto"] img',
    video: 'video',
    // A quote-tweeted card renders as a self-contained "mini tweet" nested
    // inside the outer article: a clickable div wrapping its own time and
    // tweetText. It reuses the same data-testid hooks as the outer tweet,
    // so extraction must exclude anything inside this container.
    quoteTweetContainer: 'div[role="link"][tabindex="0"]:has(time):has([data-testid="tweetText"])',
  };

  global.CaptureAgent = global.CaptureAgent || {};
  global.CaptureAgent.SELECTORS = SELECTORS;
})(window);
