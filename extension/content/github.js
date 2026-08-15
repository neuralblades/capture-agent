// Content script: injects a .capture-agent-btn into a GitHub repo's
// Star/Watch/Fork action row on the repo ROOT page only, and sends the
// repo's description + README text to the background service worker as a
// CAPTURE_POST message (platform: 'github').
//
// Standalone like linkedin.js -- this is the only script injected on
// github.com, so it can't rely on the CaptureAgent globals the x.com
// content scripts set up.
//
// The manifest's match pattern (https://github.com/*/*) can't distinguish a
// repo root ("/owner/repo") from repo subpages ("/owner/repo/issues",
// "/owner/repo/pulls", etc.) or other two-segment paths -- Chrome match
// patterns have no path-segment-count operator. So every scan re-checks the
// DOM for a repo-root-only landmark before doing anything else (see
// isRepoRootPage below), rather than trusting the URL shape.
//
// GitHub's repo page also ships hashed/atomic CSS module classes for most of
// its layout (e.g. "OverviewRepoFiles-module__Box_2__zsLGk") that regenerate
// on deploy, same problem linkedin.js documents for LinkedIn's markup. Where
// possible this file anchors on things that have stayed stable for years
// instead: real semantic elements (the file-listing <table>, the rendered
// <article class="markdown-body">), a11y-only landmarks (a visually-hidden
// h2 whose text names the region, same trick linkedin.js uses for "Feed
// post"), and long-standing non-hashed Primer classes (.pagehead-actions,
// .btn). Verified live against github.com/torvalds/linux and
// github.com/react/react (2026-08-15) -- re-derive by inspecting a live repo
// page if these stop matching, rather than guessing at new class names.
(function () {
  'use strict';

  const INJECTED_ATTR = 'data-capture-agent-injected';
  const RESET_DELAY_MS = 2500;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * @param {Element|null} el
   * @returns {string}
   */
  function cleanText(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * GitHub marks the file-browser + readme region with a visually-hidden h2
   * for screen readers ("Repository files navigation") that only renders on
   * the repo root -- confirmed absent on /issues, /pulls, and other repo
   * subpages, even though those subpages share the same header chrome
   * (including the Star/Watch/Fork row) as the root page. This is the
   * primary repo-root signal; everything else on the page persists across
   * subpages and can't be used to tell root apart from, say, /pulls.
   * @returns {boolean}
   */
  function isRepoRootPage() {
    return Array.from(document.querySelectorAll('h2')).some(
      (h2) => cleanText(h2) === 'Repository files navigation'
    );
  }

  /**
   * Derived from the URL path rather than scraped from breadcrumb DOM --
   * simpler and unaffected by markup churn. Only called after
   * isRepoRootPage() confirms a two-segment repo path.
   * @returns {{owner: string, repo: string}|null}
   */
  function getOwnerRepo() {
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return { owner: segments[0], repo: segments[1] };
  }

  /**
   * The About sidebar's "About" heading sits directly above the repo
   * description paragraph (when one is set) -- `h2.nextElementSibling` is
   * the <p>. Repos without a description just don't have that <p>, so this
   * returns '' rather than picking up unrelated sidebar text.
   * @returns {string}
   */
  function getRepoDescription() {
    const aboutHeading = Array.from(document.querySelectorAll('h2')).find(
      (h2) => cleanText(h2) === 'About'
    );
    const sibling = aboutHeading?.nextElementSibling;
    return sibling && sibling.tagName === 'P' ? cleanText(sibling) : '';
  }

  /**
   * GitHub renders a repo's README two different ways depending on the
   * file's name: recognized markdown extensions (README.md) render as
   * sanitized HTML inside `<article class="markdown-body">` (a plain,
   * non-hashed class GitHub has used for years); a README with no
   * recognized extension (e.g. the Linux kernel's plain "README" file)
   * renders as preformatted text instead, verified live as
   * `<pre>` inside a `<div class="plain">`. Only one of the two exists on
   * any given repo root, and both are unique on the page, so a direct
   * querySelector is enough -- no need to disambiguate against other
   * markdown-body-like content elsewhere on the page.
   * @returns {string}
   */
  function getReadmeText() {
    const rendered = document.querySelector('article.markdown-body');
    if (rendered) return rendered.innerText.trim();

    const plain = document.querySelector('div.plain > pre');
    if (plain) return plain.textContent.trim();

    return '';
  }

  /**
   * Same mark used on x.com/LinkedIn, built with the SVG DOM API rather than
   * an innerHTML string for consistency with linkedin.js (GitHub doesn't
   * enforce Trusted Types the way LinkedIn does, but there's no reason for
   * this file's icon construction to differ from its sibling).
   * @returns {SVGSVGElement}
   */
  function createCaptureIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'capture-agent-btn-github-icon');
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
   * @returns {HTMLLIElement}
   */
  function createButton() {
    const li = document.createElement('li');
    li.className = 'capture-agent-btn-github-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'capture-agent-btn capture-agent-btn-github';
    button.appendChild(createCaptureIcon());

    const labelSpan = document.createElement('span');
    labelSpan.className = 'capture-agent-btn-github-label';
    labelSpan.textContent = 'Capture';
    button.appendChild(labelSpan);

    button.setAttribute('data-capture-agent-state', 'idle');
    li.appendChild(button);
    return li;
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {string} text
   */
  function setButtonLabel(button, text) {
    button.querySelector('.capture-agent-btn-github-label').textContent = text;
  }

  /**
   * Mirrors linkedin.js's sendCapture -- same CAPTURE_POST message shape and
   * idle/loading/success/error button lifecycle.
   * @param {{author: string, text: string, url: string}} params
   * @param {HTMLButtonElement} button
   */
  function sendCapture({ author, text, url }, button) {
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
        platform: 'github',
        payload: { author, text, url, postedAt: null },
        capturedAt: new Date().toISOString(),
      },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || !response?.ok) {
          console.error('[CaptureAgent] GitHub capture failed', lastError?.message || response?.error);
          setButtonLabel(button, 'Failed -- retry');
          button.setAttribute('data-capture-agent-state', 'error');
          button.disabled = false;
          return;
        }

        setButtonLabel(button, '✓ Captured');
        button.setAttribute('data-capture-agent-state', 'success');
        setTimeout(() => {
          setButtonLabel(button, 'Capture');
          button.setAttribute('data-capture-agent-state', 'idle');
          button.disabled = false;
        }, RESET_DELAY_MS);
      }
    );
  }

  /**
   * `.pagehead-actions` is the Star/Watch/Fork <ul> in the repo header --
   * unlike the root-only h2 landmark, this list persists across every repo
   * subpage, which is exactly why isRepoRootPage() (not this) gates
   * injection.
   * @returns {Element|null}
   */
  function findActionsBar() {
    return document.querySelector('ul.pagehead-actions');
  }

  function injectButton() {
    if (!isRepoRootPage()) return;

    const actionsBar = findActionsBar();
    if (!actionsBar || actionsBar.getAttribute(INJECTED_ATTR) === 'true') return;

    const ownerRepo = getOwnerRepo();
    if (!ownerRepo) return;

    const description = getRepoDescription();
    const readme = getReadmeText();
    const text = [description, readme].filter(Boolean).join('\n\n---\n\n');
    if (!text) return;

    const url = `${location.origin}/${ownerRepo.owner}/${ownerRepo.repo}`;
    const li = createButton();
    const button = li.querySelector('button');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendCapture({ author: ownerRepo.owner, text, url }, button);
    });

    actionsBar.appendChild(li);
    actionsBar.setAttribute(INJECTED_ATTR, 'true');
  }

  /**
   * Removes a stale injected button (and the root-page injected marker) when
   * navigation lands on a non-root page, so returning to root later
   * re-evaluates cleanly instead of finding a stale `INJECTED_ATTR`.
   */
  function cleanupIfNotRoot() {
    if (isRepoRootPage()) return;
    const actionsBar = findActionsBar();
    if (!actionsBar) return;
    actionsBar.removeAttribute(INJECTED_ATTR);
    actionsBar.querySelectorAll('.capture-agent-btn-github-item').forEach((el) => el.remove());
  }

  function scan() {
    // Mirrors linkedin.js's orphaned-content-script guard: bail out if the
    // extension was reloaded/updated while this script is still attached to
    // an open tab.
    if (!chrome.runtime?.id) return;

    cleanupIfNotRoot();
    injectButton();
  }

  function init() {
    if (!chrome.runtime?.id) return;

    scan();

    // GitHub's repo browser is a Turbo (PJAX) app: navigating between the
    // repo root and its subpages (or between repos, via the file tree)
    // swaps the DOM in place without a full page load, so document_idle's
    // single pass isn't enough. Verified live: window.Turbo is present, and
    // clicking an in-app repo link fires turbo:load with the new DOM already
    // in place (no MutationObserver needed -- unlike LinkedIn's virtualized
    // feed, GitHub's content isn't streamed in incrementally after the
    // navigation event).
    document.addEventListener('turbo:load', scan);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
