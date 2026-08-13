// Content script: injects a .capture-agent-btn into LinkedIn feed posts and
// the job detail view, and sends the extracted post/job data to the
// background service worker as a CAPTURE_POST message (platform: 'linkedin').
//
// Standalone like form_autofill.js -- this is the only script injected on
// linkedin.com, so it can't rely on the CaptureAgent globals the x.com
// content scripts set up.
//
// LinkedIn's feed and job-detail markup now ships as atomic/hashed CSS
// classes (e.g. "d3e5c957") that are meaningless and regenerate on every
// deploy, so there is nothing stable to hang a CSS selector off. Instead,
// every lookup below anchors on ARIA landmarks (aria-label / role), which
// are part of LinkedIn's own accessibility contract and change far less
// often than presentational class names. If these stop matching in the
// future, re-derive them by inspecting a live page's aria-label attributes
// rather than guessing at new class names.
(function () {
  'use strict';

  const SCAN_DEBOUNCE_MS = 200;
  const INJECTED_ATTR = 'data-capture-agent-injected';
  const RESET_DELAY_MS = 2500;

  const POST_CONTROL_MENU_PREFIX = 'Open control menu for post by ';
  const REACTION_BUTTON_PREFIX = 'Reaction button state:';
  const COMPANY_ARIA_PREFIX = 'Company, ';

  // UI chrome that shows up as <p> text alongside the real post body (reaction
  // counts, "Promoted", connection-degree badges, etc.) -- filtered out when
  // hunting for the actual post text among a card's paragraphs.
  const POST_TEXT_DENYLIST = [
    /^•?\s*(1st|2nd|3rd)\+?$/i,
    /^(promoted|suggested)$/i,
    /\blikes? this$/i,
    /\bcommented(\s+on\s+this)?$/i,
    /^\d[\d,]*\s*(reaction|comment|repost)/i,
    /^(see|load|view)\s+.*(comment|repost|reaction)/i,
    /^\+\d+$/,
    /\band\s+\d+\s+others?$/i,
    /^\s*•\s*$/,
    /^[\d,]+\s+followers?$/i,
    /^\d+\s*(h|d|w|mo|y)\s*(•|·)?\s*(edited)?\s*•?\s*$/i,
  ];

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * @param {Element|null} el
   * @returns {string}
   */
  function cleanText(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Same mark used for the idle icon on x.com -- kept identical so the two
   * platforms read as the same product, and left in place across all button
   * states here (unlike x.com's icon-only idle button) since the LinkedIn
   * button always shows a text label.
   *
   * Built with the SVG DOM API rather than an innerHTML string: LinkedIn
   * enforces a Trusted Types default policy that silently strips markup
   * (including <svg>) out of any innerHTML assignment, so a string-based
   * icon would just disappear here.
   * @returns {SVGSVGElement}
   */
  function createCaptureIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'capture-agent-btn-linkedin-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const polygon = document.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute('points', '13 2 3 14 12 14 11 22 21 10 12 10 13 2');
    svg.appendChild(polygon);

    return svg;
  }

  /**
   * @param {string} label
   * @returns {HTMLButtonElement}
   */
  function createButton(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'capture-agent-btn capture-agent-btn-linkedin';
    button.appendChild(createCaptureIcon());

    const labelSpan = document.createElement('span');
    labelSpan.className = 'capture-agent-btn-linkedin-label';
    labelSpan.textContent = label;
    button.appendChild(labelSpan);

    button.setAttribute('data-capture-agent-state', 'idle');
    return button;
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {string} text
   */
  function setButtonLabel(button, text) {
    button.querySelector('.capture-agent-btn-linkedin-label').textContent = text;
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
      setButtonLabel(button, 'Refresh page to capture');
      button.setAttribute('data-capture-agent-state', 'error');
      return;
    }

    button.disabled = true;
    setButtonLabel(button, 'Capturing...');
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
          setButtonLabel(button, 'Failed -- retry');
          button.setAttribute('data-capture-agent-state', 'error');
          button.disabled = false;
          return;
        }

        setButtonLabel(button, '✓ Captured');
        button.setAttribute('data-capture-agent-state', 'success');
        setTimeout(() => {
          setButtonLabel(button, idleLabel);
          button.setAttribute('data-capture-agent-state', 'idle');
          button.disabled = false;
        }, RESET_DELAY_MS);
      }
    );
  }

  /**
   * Climbs from a known descendant and returns the nearest ancestor matching
   * `matcher` -- e.g. the actual flex row holding a set of action buttons,
   * rather than some larger wrapper further out that also happens to
   * contain them.
   * @param {Element} start
   * @param {(el: Element) => boolean} matcher
   * @param {number} maxLevels
   * @returns {Element|null}
   */
  function climbUntil(start, matcher, maxLevels) {
    let current = start;
    for (let i = 0; i < maxLevels && current; i++) {
      if (matcher(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  // ---- Feed posts ----

  /**
   * Each feed post is a div[role="listitem"] carrying a visually-hidden
   * "Feed post" <h2> for screen readers -- the most stable per-post boundary
   * left in the current markup.
   * @returns {Element[]}
   */
  function findPostCards() {
    return Array.from(document.querySelectorAll('div[role="listitem"]')).filter((card) =>
      Array.from(card.querySelectorAll('h2')).some((h2) => cleanText(h2).startsWith('Feed post'))
    );
  }

  /**
   * @param {Element} card
   * @returns {string|null}
   */
  function getPostAuthor(card) {
    const control = card.querySelector(`[aria-label^="${POST_CONTROL_MENU_PREFIX}"]`);
    if (!control) return null;
    return control.getAttribute('aria-label').slice(POST_CONTROL_MENU_PREFIX.length).trim() || null;
  }

  /**
   * The post body has no dedicated container anymore, so this picks the
   * longest paragraph in the card that isn't a piece of known UI chrome
   * (author name, reaction counts, "Promoted", etc.) -- in practice the
   * actual post text is reliably the longest surviving candidate.
   * @param {Element} card
   * @param {string|null} author
   * @returns {string}
   */
  function getPostText(card, author) {
    const candidates = Array.from(card.querySelectorAll('p'))
      .map((p) => cleanText(p))
      .filter((text) => text && text !== author && !POST_TEXT_DENYLIST.some((re) => re.test(text)));

    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  }

  /**
   * The action row (Like/Comment/Repost/Send) is found by climbing from the
   * Like button until the ancestor holds all of them.
   * @param {Element} card
   * @returns {Element|null}
   */
  function findFeedActionBar(card) {
    const likeButton = card.querySelector(`[aria-label^="${REACTION_BUTTON_PREFIX}"]`);
    if (!likeButton) return null;
    return climbUntil(likeButton, (el) => el.querySelectorAll('button, [role="button"], a').length >= 3, 10);
  }

  /**
   * Not every post exposes a permalink in the DOM (promoted posts especially),
   * so this falls back to the feed URL itself when one can't be found.
   * @param {Element} card
   * @returns {string}
   */
  function getPostUrl(card) {
    const permalink = card.querySelector('a[href*="/feed/update/urn:li:"]');
    return permalink ? permalink.href : location.href;
  }

  /**
   * @param {Element} card
   */
  function injectIntoFeedPost(card) {
    if (card.getAttribute(INJECTED_ATTR) === 'true') return;

    const actionBar = findFeedActionBar(card);
    if (!actionBar) return;

    const author = getPostAuthor(card);
    const text = getPostText(card, author);
    if (!text) return;

    const url = getPostUrl(card);

    const button = createButton('Capture');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendCapture({ platform: 'linkedin', author, text, url, idleLabel: 'Capture' }, button);
    });

    actionBar.appendChild(button);
    card.setAttribute(INJECTED_ATTR, 'true');
  }

  // ---- Job detail view ----

  /**
   * The Apply/Easy-Apply and Save buttons share a common wrapper a couple of
   * levels up -- that wrapper is also where the capture button gets appended.
   * @returns {Element|null}
   */
  function findJobActionsBar() {
    const applyButton = document.querySelector('button[aria-label*="Apply" i], a[aria-label*="Apply" i]');
    if (!applyButton) return null;
    return climbUntil(applyButton, (el) => el.querySelectorAll('button, a').length >= 2, 10);
  }

  /**
   * The description lives in the sibling right after the "About the job"
   * heading's wrapper.
   * @returns {string}
   */
  function getJobDescription() {
    const heading = Array.from(document.querySelectorAll('h2')).find((h2) => cleanText(h2) === 'About the job');
    const container = heading?.parentElement?.nextElementSibling;
    return container ? cleanText(container) : '';
  }

  function injectIntoJobTopCard() {
    const actionsBar = findJobActionsBar();
    if (!actionsBar || actionsBar.getAttribute(INJECTED_ATTR) === 'true') return;

    const description = getJobDescription();
    if (!description) return;

    // The split-pane job search view only ever renders one job's own detail
    // pane at a time (its "similar jobs" widgets link elsewhere, not via
    // /jobs/view/), so an unscoped lookup for these two landmarks reliably
    // lands on the currently-open job rather than a neighboring list card.
    const titleLink = document.querySelector('a[href*="/jobs/view/"]');
    const title = cleanText(titleLink);
    const company = cleanText(document.querySelector(`[aria-label^="${COMPANY_ARIA_PREFIX}"]`));
    const author = [title, company].filter(Boolean).join(' @ ') || null;
    const url = titleLink ? titleLink.href : location.href;

    const button = createButton('Capture job');
    button.classList.add('capture-agent-btn-linkedin-job');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendCapture({ platform: 'linkedin', author, text: description, url, idleLabel: 'Capture job' }, button);
    });

    actionsBar.appendChild(button);
    actionsBar.setAttribute(INJECTED_ATTR, 'true');
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

    findPostCards().forEach(injectIntoFeedPost);
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
