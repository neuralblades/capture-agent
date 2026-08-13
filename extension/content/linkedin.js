// Content script: injects a .capture-agent-btn into LinkedIn feed posts and
// the job detail view, and sends the extracted post/job data to the
// background service worker as a CAPTURE_POST message (platform: 'linkedin').
//
// Standalone like form_autofill.js -- this is the only script injected on
// linkedin.com, so it can't rely on the CaptureAgent globals the x.com
// content scripts set up.
//
// LinkedIn ships several markup variants across its redesigns and doesn't
// expose stable data-testid hooks the way x.com does, so each lookup below
// tries a short list of known candidate selectors and uses the first match.
(function () {
  'use strict';

  const SCAN_DEBOUNCE_MS = 200;
  const INJECTED_ATTR = 'data-capture-agent-injected';
  const RESET_DELAY_MS = 2500;

  const FEED_POST_SELECTOR = 'div.feed-shared-update-v2[data-urn]';
  const FEED_ACTION_BAR_SELECTORS = ['.feed-shared-social-action-bar', '.social-actions-bar'];
  const FEED_TEXT_SELECTORS = ['.feed-shared-update-v2__description .update-components-text', '.feed-shared-text'];
  const FEED_AUTHOR_SELECTOR = '.update-components-actor__name';

  const JOB_TOP_CARD_SELECTORS = ['.job-details-jobs-unified-top-card', '.jobs-unified-top-card'];
  const JOB_TITLE_SELECTORS = ['.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', 'h1'];
  const JOB_COMPANY_SELECTORS = ['.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name'];
  const JOB_DESCRIPTION_SELECTORS = ['#job-details', '.jobs-description__content', '.jobs-box__html-content'];
  const JOB_ACTIONS_SELECTORS = ['.jobs-unified-top-card__actions', '.job-details-jobs-unified-top-card__container--two-pane'];

  /**
   * @param {ParentNode} root
   * @param {string[]} selectors
   * @returns {Element|null}
   */
  function firstMatch(root, selectors) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  /**
   * @param {Element|null} el
   * @returns {string}
   */
  function cleanText(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * @param {string} label
   * @returns {HTMLButtonElement}
   */
  function createButton(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'capture-agent-btn capture-agent-btn-linkedin';
    button.textContent = label;
    button.setAttribute('data-capture-agent-state', 'idle');
    return button;
  }

  /**
   * Sends a CAPTURE_POST message for the given fields and reflects the
   * result in the button's label/state, mirroring x.com's capture button UX.
   * @param {{platform: string, author: string|null, text: string, url: string, idleLabel: string}} params
   * @param {HTMLButtonElement} button
   */
  function sendCapture({ platform, author, text, url, idleLabel }, button) {
    if (!text || button.disabled) return;

    if (!chrome.runtime?.id) {
      button.textContent = 'Refresh page to capture';
      button.setAttribute('data-capture-agent-state', 'error');
      return;
    }

    button.disabled = true;
    button.textContent = 'Capturing...';
    button.setAttribute('data-capture-agent-state', 'loading');

    chrome.runtime.sendMessage(
      {
        type: 'CAPTURE_POST',
        platform,
        payload: { author, text, url },
        capturedAt: new Date().toISOString(),
      },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || !response?.ok) {
          console.error('[CaptureAgent] LinkedIn capture failed', lastError?.message || response?.error);
          button.textContent = 'Failed -- retry';
          button.setAttribute('data-capture-agent-state', 'error');
          button.disabled = false;
          return;
        }

        button.textContent = '✓ Captured';
        button.setAttribute('data-capture-agent-state', 'success');
        setTimeout(() => {
          button.textContent = idleLabel;
          button.setAttribute('data-capture-agent-state', 'idle');
          button.disabled = false;
        }, RESET_DELAY_MS);
      }
    );
  }

  /**
   * LinkedIn's real, working permalink format for a feed update.
   * @param {string|null} urn - e.g. "urn:li:activity:1234567890"
   * @returns {string}
   */
  function feedPostUrl(urn) {
    return urn ? `https://www.linkedin.com/feed/update/${urn}/` : location.href;
  }

  /**
   * @param {Element} article
   */
  function injectIntoFeedPost(article) {
    if (article.getAttribute(INJECTED_ATTR) === 'true') return;

    const actionBar = firstMatch(article, FEED_ACTION_BAR_SELECTORS);
    if (!actionBar) return;

    const text = cleanText(firstMatch(article, FEED_TEXT_SELECTORS));
    if (!text) return;

    const author = cleanText(article.querySelector(FEED_AUTHOR_SELECTOR)) || null;
    const url = feedPostUrl(article.getAttribute('data-urn'));

    const button = createButton('Capture');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendCapture({ platform: 'linkedin', author, text, url, idleLabel: 'Capture' }, button);
    });

    actionBar.appendChild(button);
    article.setAttribute(INJECTED_ATTR, 'true');
  }

  /**
   * The job id embedded in the current URL, whether viewing a job directly
   * (/jobs/view/{id}) or a job selected within the search results split pane
   * (?currentJobId={id}).
   * @returns {string|null}
   */
  function jobIdFromLocation() {
    const viewMatch = location.pathname.match(/\/jobs\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];
    return new URLSearchParams(location.search).get('currentJobId');
  }

  function injectIntoJobTopCard() {
    const topCard = firstMatch(document, JOB_TOP_CARD_SELECTORS);
    if (!topCard || topCard.getAttribute(INJECTED_ATTR) === 'true') return;

    const description = cleanText(firstMatch(document, JOB_DESCRIPTION_SELECTORS));
    if (!description) return;

    const title = cleanText(firstMatch(topCard, JOB_TITLE_SELECTORS));
    const company = cleanText(firstMatch(topCard, JOB_COMPANY_SELECTORS));
    const author = [title, company].filter(Boolean).join(' @ ') || null;

    const jobId = jobIdFromLocation();
    const url = jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : location.href;

    const actionsContainer = firstMatch(document, JOB_ACTIONS_SELECTORS) || topCard;

    const button = createButton('Capture job');
    button.classList.add('capture-agent-btn-linkedin-job');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendCapture({ platform: 'linkedin', author, text: description, url, idleLabel: 'Capture job' }, button);
    });

    actionsContainer.appendChild(button);
    topCard.setAttribute(INJECTED_ATTR, 'true');
  }

  let observer = null;

  function scan() {
    // The extension can be reloaded/updated while this content script is
    // still attached to an open LinkedIn tab, orphaning it: chrome.runtime
    // no longer has an id, and any chrome.* call throws or resolves against
    // a dead context (surfacing as chrome-extension://invalid/ requests in
    // the network log). Bail out of DOM injection and stop the observer so
    // an orphaned script doesn't keep scanning the feed forever.
    if (!chrome.runtime?.id) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      return;
    }

    document.querySelectorAll(FEED_POST_SELECTOR).forEach(injectIntoFeedPost);
    injectIntoJobTopCard();
  }

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  function init() {
    if (!chrome.runtime?.id) return;

    scan();
    // LinkedIn is a client-routed SPA: feed posts stream in via virtualized
    // scroll and job detail panes swap in without a full navigation, so a
    // single pass at document_idle isn't enough -- rescan on DOM mutations.
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
