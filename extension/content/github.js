// Content script: shows a floating capture button on GitHub repo root pages
// and organization pages, and sends the extracted content to the background
// service worker as a CAPTURE_POST message (platform: 'github').
//
// Standalone like linkedin.js -- this is the only script injected on
// github.com, so it can't rely on the CaptureAgent globals the x.com
// content scripts set up.
//
// A floating button (fixed-position, appended once to <body>) was chosen
// over injecting into GitHub's own header row deliberately: an earlier
// version anchored on the Star/Watch/Fork action bar, which turned out to
// look different enough between logged-out and logged-in sessions that the
// injection point couldn't be found reliably in both. A floating button
// doesn't need an anchor in GitHub's own layout at all, so it's unaffected
// by that (or by any future header redesign) -- all it needs is a reliable
// way to tell "is this page capturable", which is a DOM check regardless.
//
// The manifest matches all of https://github.com/*, since repo pages
// ("/owner/repo"), org pages ("/owner"), and plenty of non-capturable pages
// (settings, marketing pages, a user's own profile) all share overlapping
// URL shapes that Chrome match patterns can't distinguish. So every scan
// re-checks the DOM for a page-type-specific landmark before showing
// anything (see detectPageType below), rather than trusting the URL shape.
//
// GitHub's repo page ships hashed/atomic CSS module classes for most of its
// layout (e.g. "OverviewRepoFiles-module__Box_2__zsLGk") that regenerate on
// deploy, same problem linkedin.js documents for LinkedIn's markup. Where
// possible this file anchors on things that have stayed stable for years
// instead: real semantic elements (the file-listing <table>, the rendered
// <article class="markdown-body">), a11y-only landmarks (a visually-hidden
// h2 whose text names the region, same trick linkedin.js uses for "Feed
// post"), schema.org microdata (organizations carry itemtype="...Organization"),
// and long-standing non-hashed/"js-" prefixed classes (.text-bold, .orghead,
// .js-pinned-items-reorder-list). Verified live against
// github.com/torvalds/linux, github.com/react/react, github.com/facebook
// (an org page) and github.com/torvalds (a user profile, to confirm it's
// correctly excluded) on 2026-08-15 -- re-derive by inspecting a live page
// if these stop matching, rather than guessing at new class names.
(function () {
  'use strict';

  const FAB_ID = 'capture-agent-github-fab';
  const RESET_DELAY_MS = 2500;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * @param {Element|null} el
   * @returns {string}
   */
  function cleanText(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  // ---- Repo root page ----

  /**
   * GitHub marks the file-browser + readme region with a visually-hidden h2
   * for screen readers ("Repository files navigation") that only renders on
   * the repo root -- confirmed absent on /issues, /pulls, and other repo
   * subpages, even though those subpages share the same header chrome as
   * the root page. This is the repo-root signal; everything else on the
   * page persists across subpages and can't be used to tell root apart
   * from, say, /pulls.
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
   * The About sidebar's optional "Website" field (often a live demo / project
   * homepage link, e.g. react.dev for facebook/react) is the only link in
   * that sidebar that both points off github.com and carries the `.text-bold`
   * utility class (a plain, non-hashed GitHub class) -- topic tags and the
   * Readme/License/Activity resource links share the same sidebar container
   * but match neither signal. Verified live against github.com/react/react;
   * returns '' for repos that don't set a website (most repos, e.g. the
   * Linux kernel).
   * @returns {string}
   */
  function getRepoWebsite() {
    const aboutHeading = Array.from(document.querySelectorAll('h2')).find(
      (h2) => cleanText(h2) === 'About'
    );
    const container = aboutHeading?.parentElement;
    if (!container) return '';

    const link = Array.from(container.querySelectorAll('a.text-bold[href]')).find((a) => {
      try {
        return new URL(a.href).hostname !== 'github.com';
      } catch {
        return false;
      }
    });
    return link ? link.href : '';
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
   * @returns {{author: string, text: string, url: string}|null}
   */
  function buildRepoCapture() {
    const ownerRepo = getOwnerRepo();
    if (!ownerRepo) return null;

    const description = getRepoDescription();
    const website = getRepoWebsite();
    const readme = getReadmeText();
    // The website line sits with the description (not its own '---' section)
    // so it reads as part of the "about" summary rather than a third,
    // separate block. Plain-text "Website: <url>" so the sidepanel's
    // existing regex link-scan (extractExternalUrls in sidepanel.js) picks
    // it up as a link pill for free -- no sidepanel changes needed for that.
    const about = [description, website ? `Website: ${website}` : ''].filter(Boolean).join('\n');
    const text = [about, readme].filter(Boolean).join('\n\n---\n\n');
    if (!text) return null;

    return {
      author: ownerRepo.owner,
      text,
      url: `${location.origin}/${ownerRepo.owner}/${ownerRepo.repo}`,
    };
  }

  // ---- Organization page ----

  /**
   * Organization pages carry schema.org Organization microdata on a wrapper
   * div (itemtype ending in ".../Organization") -- verified live on
   * github.com/facebook. User profiles use "...Person" instead (verified on
   * github.com/torvalds), so this cleanly excludes them; the floating button
   * is repo/org only, per scope.
   * @returns {Element|null}
   */
  function findOrgContainer() {
    return document.querySelector('[itemtype*="Organization"]');
  }

  function isOrgPage() {
    return !!findOrgContainer();
  }

  /**
   * `.orghead` is GitHub's own (non-hashed) class for the profile header
   * block -- scoping to it keeps the bio lookup below from matching
   * `.color-fg-muted` text elsewhere on the page (that utility class is used
   * all over repo-card metadata further down the same page).
   * @returns {Element|null}
   */
  function findOrgHeader() {
    return document.querySelector('.orghead');
  }

  /**
   * @returns {{name: string, bio: string, website: string}}
   */
  function getOrgProfile() {
    const header = findOrgHeader();
    if (!header) return { name: '', bio: '', website: '' };

    const name = cleanText(header.querySelector('h1'));
    const bio = cleanText(header.querySelector('div.color-fg-muted'));
    const websiteLink = header.querySelector('[itemprop="url"]');
    return { name, bio, website: websiteLink ? websiteLink.href : '' };
  }

  /**
   * Pinned repos sit in an `<ol class="...js-pinned-items-reorder-list">`
   * under the "Pinned" heading -- "js-" prefixed classes are GitHub's own
   * behavior hooks (this one drives pinned-repo drag-to-reorder), which
   * tend to stay stable since removing them would break that feature, not
   * just its styling. Returns each pinned repo as "name -- description"
   * (description omitted when a repo doesn't have one).
   * @returns {string[]}
   */
  function getPinnedRepos() {
    const heading = Array.from(document.querySelectorAll('h2')).find((h2) =>
      cleanText(h2).startsWith('Pinned')
    );
    const list = heading?.parentElement?.querySelector('ol.js-pinned-items-reorder-list');
    if (!list) return [];

    return Array.from(list.children)
      .map((item) => {
        const link = item.querySelector('a[href^="/"]');
        if (!link) return null;
        const name = link.getAttribute('href').replace(/^\//, '');
        const description = cleanText(item.querySelector('p'));
        return description ? `${name} -- ${description}` : name;
      })
      .filter(Boolean);
  }

  /**
   * @returns {{author: string, text: string, url: string}|null}
   */
  function buildOrgCapture() {
    const segments = location.pathname.split('/').filter(Boolean);
    const login = segments[0];
    if (!login) return null;

    const { name, bio, website } = getOrgProfile();
    const pinned = getPinnedRepos();

    const parts = [bio];
    if (website) parts.push(`Website: ${website}`);
    if (pinned.length > 0) parts.push(`Pinned repositories:\n${pinned.map((p) => `- ${p}`).join('\n')}`);
    const text = parts.filter(Boolean).join('\n\n');
    if (!text) return null;

    return { author: name || login, text, url: `${location.origin}/${login}` };
  }

  // ---- Page type ----

  /**
   * @returns {'repo'|'org'|null}
   */
  function detectPageType() {
    if (isRepoRootPage()) return 'repo';
    if (isOrgPage()) return 'org';
    return null;
  }

  const IDLE_LABELS = { repo: 'Capture repo', org: 'Capture org' };

  // ---- Floating button ----

  /**
   * Same mark used on x.com/LinkedIn, built with the SVG DOM API rather than
   * an innerHTML string for consistency with linkedin.js (GitHub doesn't
   * enforce Trusted Types the way LinkedIn does, but there's no reason for
   * this file's icon construction to differ from its sibling).
   * @returns {SVGSVGElement}
   */
  function createCaptureIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'capture-agent-github-fab-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
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
   * @param {HTMLButtonElement} fab
   * @param {string} text
   */
  function setFabLabel(fab, text) {
    fab.querySelector('.capture-agent-github-fab-label').textContent = text;
  }

  /**
   * Computes the capture payload fresh from the live DOM at click time
   * (rather than at button-creation time), so the single persistent fab
   * never needs rebinding after a Turbo navigation swaps the page under it.
   * @param {Event} event
   */
  function handleFabClick(event) {
    event.preventDefault();
    const fab = event.currentTarget;
    if (fab.disabled) return;

    const pageType = detectPageType();
    const data = pageType === 'repo' ? buildRepoCapture() : pageType === 'org' ? buildOrgCapture() : null;
    if (!data) return;

    if (!chrome.runtime?.id) {
      setFabLabel(fab, 'Refresh page to capture');
      fab.setAttribute('data-capture-agent-state', 'error');
      return;
    }

    fab.disabled = true;
    setFabLabel(fab, 'Capturing...');
    fab.setAttribute('data-capture-agent-state', 'loading');

    chrome.runtime.sendMessage(
      {
        type: 'CAPTURE_POST',
        platform: 'github',
        payload: { author: data.author, text: data.text, url: data.url, postedAt: null },
        capturedAt: new Date().toISOString(),
      },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || !response?.ok) {
          console.error('[CaptureAgent] GitHub capture failed', lastError?.message || response?.error);
          setFabLabel(fab, 'Failed -- retry');
          fab.setAttribute('data-capture-agent-state', 'error');
          fab.disabled = false;
          return;
        }

        setFabLabel(fab, '✓ Captured');
        fab.setAttribute('data-capture-agent-state', 'success');
        setTimeout(() => {
          // Recomputed rather than reusing the pageType captured at click
          // time: a Turbo navigation to a different page type could land
          // during this delay, and the label should reflect where the fab
          // actually is now, not where it was clicked.
          const currentType = detectPageType();
          setFabLabel(fab, currentType ? IDLE_LABELS[currentType] : 'Capture');
          fab.setAttribute('data-capture-agent-state', 'idle');
          fab.disabled = false;
        }, RESET_DELAY_MS);
      }
    );
  }

  /**
   * Created once and reused across the whole page lifetime (including
   * Turbo navigations) -- `#capture-agent-github-fab` makes creation
   * idempotent, and the click handler reads live DOM state rather than
   * anything captured at creation time, so there's nothing to rebind.
   * @returns {HTMLButtonElement}
   */
  function getOrCreateFab() {
    let fab = document.getElementById(FAB_ID);
    if (fab) return fab;

    fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.type = 'button';
    fab.className = 'capture-agent-github-fab';
    fab.appendChild(createCaptureIcon());

    const labelSpan = document.createElement('span');
    labelSpan.className = 'capture-agent-github-fab-label';
    fab.appendChild(labelSpan);

    fab.setAttribute('data-capture-agent-state', 'idle');
    fab.addEventListener('click', handleFabClick);
    document.body.appendChild(fab);
    return fab;
  }

  function scan() {
    // Mirrors linkedin.js's orphaned-content-script guard: bail out if the
    // extension was reloaded/updated while this script is still attached to
    // an open tab.
    if (!chrome.runtime?.id) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      return;
    }

    const pageType = detectPageType();
    const existingFab = document.getElementById(FAB_ID);

    if (!pageType) {
      existingFab?.remove();
      return;
    }

    const fab = getOrCreateFab();
    // Don't clobber a label mid-capture (loading/success/error) just
    // because a mutation elsewhere triggered a rescan.
    if (fab.getAttribute('data-capture-agent-state') === 'idle') {
      setFabLabel(fab, IDLE_LABELS[pageType]);
    }
  }

  let observer = null;

  const SCAN_DEBOUNCE_MS = 200;
  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  function init() {
    if (!chrome.runtime?.id) return;

    scan();

    // GitHub's repo/org pages are a Turbo (PJAX) app: navigating between
    // them swaps the DOM in place without a full page load, so
    // document_idle's single pass isn't enough. Verified live: window.Turbo
    // is present, and clicking an in-app link fires turbo:load with the new
    // DOM already in place.
    document.addEventListener('turbo:load', scan);

    // The file listing + README (and org profile header) themselves render
    // via a client-side React app that can still be hydrating when
    // document_idle fires, especially on a cold load of a large repo -- the
    // page-type landmarks simply aren't in the DOM yet at that point.
    // turbo:load doesn't cover this case (it only fires on subsequent
    // in-app navigations), so a MutationObserver -- debounced, same as
    // linkedin.js -- rescans while that initial render is still settling.
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
