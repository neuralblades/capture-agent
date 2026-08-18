// Shared extraction core for the generic "capture any site" feature, used by
// both Standard Mode (one-shot chrome.scripting.executeScript, triggered by
// background.js) and Power Mode (the persistent generic_capture.js content
// script). Written once here so the heuristic logic isn't duplicated between
// the two entry points.
//
// Deliberately NOT an ES module -- both entry points load this via
// executeScript's/registerContentScripts' `files` option, which runs plain
// scripts in the page's isolated world, not modules. Exposes its functions
// on window.__captureAgent so callers (an inline `func`, or
// generic_capture.js loaded right after this file) can reach them.
//
// This is a Readability-lite heuristic, not comparable in fidelity to the
// hand-verified per-platform integrations (linkedin.js, github.js) -- a
// deliberate tradeoff for covering arbitrary sites without per-site
// selectors. Extraction quality varies site to site; that's expected.
(function () {
  'use strict';

  const MAX_BODY_CHARS = 20000;
  const MIN_SEMANTIC_CONTAINER_CHARS = 200;
  const MIN_CAPTURABLE_CONTAINER_CHARS = 500;
  const MIN_PARAGRAPH_CHARS = 40;

  // Excludes common chrome/noise containers from the density-scoring
  // fallback -- checked against a container's class + id together.
  const EXCLUDE_CONTAINER_RE = /nav|footer|sidebar|comment|advert|cookie|banner|header/i;

  // Pages where a capture button (or one-shot capture) makes little sense --
  // account flows, search results, checkout -- checked against the path only,
  // not query string, so e.g. "?search=foo" on a real content page doesn't
  // false-positive.
  const EXCLUDED_PATH_RE = /\/(login|signin|signup|register|settings|checkout|cart|search)(\/|$)/i;

  /**
   * @param {string} str
   * @returns {string}
   */
  function escapeRegExp(str) {
    return str.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Converts a Chrome extension match pattern (the same syntax
   * manifest.json's content_scripts use, e.g. "https://*.linkedin.com/*")
   * into a RegExp. Handles the subset actually used in this manifest --
   * http/https/* schemes, an optional "*." subdomain-wildcard host prefix,
   * and "*" path wildcards -- not the full match-pattern spec (no <all_urls>,
   * no non-http schemes), which is all that's needed here.
   * @param {string} pattern
   * @returns {RegExp|null}
   */
  function matchPatternToRegExp(pattern) {
    const parsed = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
    if (!parsed) return null;
    const [, scheme, host, path] = parsed;

    const schemeRe = scheme === '*' ? 'https?' : scheme;
    const hostRe =
      host === '*' ? '[^/]+' : host.startsWith('*.') ? `(?:[^/]+\\.)?${escapeRegExp(host.slice(2))}` : escapeRegExp(host);
    const pathRe = path.split('*').map(escapeRegExp).join('.*');

    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
  }

  /**
   * Whether the current page is already covered by one of this extension's
   * own dedicated content scripts (linkedin.js, github.js, x.com's...) --
   * read straight from manifest.json's content_scripts at runtime rather
   * than a hand-maintained hostname list, so a future dedicated integration
   * is automatically excluded here the moment its matches entry is added to
   * the manifest, with no second list to remember to update. Power Mode's
   * own script is dynamically registered (chrome.scripting.registerContentScripts),
   * not part of the static manifest, so it can't accidentally match itself here.
   * @returns {boolean}
   */
  function isDedicatedIntegrationSite() {
    const manifest = chrome.runtime.getManifest();
    return (manifest.content_scripts || []).some((script) =>
      (script.matches || []).some((pattern) => {
        const re = matchPatternToRegExp(pattern);
        return re ? re.test(location.href) : false;
      })
    );
  }

  /**
   * The semantic containers GitHub/most modern content sites use for their
   * actual body copy, checked in order of specificity. `article` first since
   * it's the most common real-world signal (Medium, Substack, WordPress
   * themes, Dev.to all wrap post bodies in it); `main` last since it's often
   * broader than just the post body but still better than nothing.
   */
  const SEMANTIC_SELECTORS = ['article', '[itemprop="articleBody"]', '[role="article"]', 'main'];

  /**
   * @param {number} minChars
   * @returns {Element|null}
   */
  function findSemanticContainer(minChars) {
    for (const selector of SEMANTIC_SELECTORS) {
      const el = document.querySelector(selector);
      if (el && el.innerText.trim().length > minChars) return el;
    }
    return null;
  }

  /**
   * Fallback for sites with no semantic container: scores every element that
   * directly holds substantial <p> tags by paragraphCount * totalLength,
   * excluding obvious chrome (nav/footer/sidebar/etc.) -- the same
   * "find the densest text block" approach github.js documents avoiding by
   * having real landmarks to anchor on; arbitrary sites don't offer that, so
   * this is the necessary fallback here.
   * @returns {Element|null}
   */
  function findDensestContainer() {
    const candidates = new Map();

    document.querySelectorAll('p').forEach((p) => {
      const text = p.innerText.trim();
      if (text.length < MIN_PARAGRAPH_CHARS) return;

      const container = p.parentElement;
      if (!container) return;
      const identity = `${container.className} ${container.id}`;
      if (EXCLUDE_CONTAINER_RE.test(identity)) return;

      const entry = candidates.get(container) || { count: 0, length: 0 };
      entry.count += 1;
      entry.length += text.length;
      candidates.set(container, entry);
    });

    let best = null;
    let bestScore = 0;
    for (const [container, { count, length }] of candidates) {
      const score = count * length;
      if (score > bestScore) {
        bestScore = score;
        best = container;
      }
    }
    return best;
  }

  /**
   * @param {number} minChars
   * @returns {Element|null}
   */
  function findContentContainer(minChars) {
    return findSemanticContainer(minChars) || findDensestContainer();
  }

  /**
   * @returns {{title: string, description: string, author: string|null, bodyText: string, url: string, imageUrl: string|null}}
   */
  function extractGenericPage() {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
    const title = (ogTitle || document.title || '').trim();

    const description =
      document.querySelector('meta[property="og:description"]')?.content ||
      document.querySelector('meta[name="description"]')?.content ||
      '';

    const author = document.querySelector('meta[name="author"]')?.content || null;

    // og:image -- the standard "share card" image most sites already declare
    // -- rather than a heuristic DOM scrape, which would be far less reliable
    // across arbitrary sites than it is for the hand-verified platforms.
    const imageUrl = document.querySelector('meta[property="og:image"]')?.content || null;

    const container = findContentContainer(MIN_SEMANTIC_CONTAINER_CHARS);
    const bodyText = container ? container.innerText.trim().slice(0, MAX_BODY_CHARS) : '';

    return { title, description: description.trim(), author, bodyText, url: location.href, imageUrl };
  }

  /**
   * Capturability gate, used two ways: Power Mode's floating button uses the
   * boolean form to decide whether to show itself at all; Standard Mode's
   * three explicit triggers (right-click page/icon, keyboard shortcut) use
   * the reason form to bail out before submitting a capture *and* to pick a
   * specific, human-readable reason for the failure -- a page can have
   * enough incidental text (e.g. a login page's marketing copy) to pass a
   * bare "is there content" check while still being junk, so the caller
   * needs to know *why* it was blocked, not just that it was. Deliberately
   * conservative and separate from extraction quality -- judges only "does
   * this look like an article/announcement", never "is this a valuable
   * opportunity" -- that classification stays the backend LLM's job, run
   * only after a capture is actually submitted.
   * @returns {'dedicated-integration'|'password'|'excluded-path'|'no-title'|'thin-content'|null} null means capturable
   */
  function getCapturabilityBlockReason() {
    if (isDedicatedIntegrationSite()) return 'dedicated-integration';
    if (document.querySelector('input[type="password"]')) return 'password';
    if (EXCLUDED_PATH_RE.test(location.pathname)) return 'excluded-path';
    if (!document.title.trim()) return 'no-title';

    const container = findContentContainer(MIN_CAPTURABLE_CONTAINER_CHARS);
    return container ? null : 'thin-content';
  }

  /**
   * @returns {boolean}
   */
  function isPageLikelyCapturable() {
    return getCapturabilityBlockReason() === null;
  }

  window.__captureAgent = { extractGenericPage, isPageLikelyCapturable, getCapturabilityBlockReason };
})();
