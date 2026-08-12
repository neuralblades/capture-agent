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
  };

  global.CaptureAgent = global.CaptureAgent || {};
  global.CaptureAgent.SELECTORS = SELECTORS;
})(window);
