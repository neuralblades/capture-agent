// Typed JSON contract shared with the background service worker.
// Keep this in sync with any consumer outside /extension/content/ --
// it is the wire format for messages dispatched via chrome.runtime.sendMessage.
(function (global) {
  const CONTRACT_VERSION = 1;

  const MESSAGE_TYPES = Object.freeze({
    CAPTURE_TWEET: 'CAPTURE_TWEET',
  });

  /**
   * @typedef {Object} CaptureAuthor
   * @property {string|null} handle - "@handle" without the leading "@", or null if unresolved
   * @property {string|null} displayName
   *
   * @typedef {Object} CaptureMedia
   * @property {'photo'|'video'} type
   * @property {string} url
   *
   * @typedef {Object} CaptureTweetPayload
   * @property {string|null} tweetId
   * @property {CaptureAuthor} author
   * @property {string} text
   * @property {string|null} url - absolute status URL
   * @property {string|null} timestamp - ISO 8601 datetime from the tweet's <time> element
   * @property {CaptureMedia[]} media
   * @property {string|null} imageUrl - the tweet's primary image, if any (first photo, or a video's poster frame)
   *
   * @typedef {Object} CaptureMessage
   * @property {string} type - one of MESSAGE_TYPES
   * @property {number} version - CONTRACT_VERSION
   * @property {CaptureTweetPayload} payload
   * @property {string} capturedAt - ISO 8601 datetime, when the user clicked capture
   */

  global.CaptureAgent = global.CaptureAgent || {};
  global.CaptureAgent.CONTRACT_VERSION = CONTRACT_VERSION;
  global.CaptureAgent.MESSAGE_TYPES = MESSAGE_TYPES;
})(window);
