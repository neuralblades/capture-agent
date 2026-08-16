// Power Mode's persistent floating capture button. Dynamically registered
// via chrome.scripting.registerContentScripts() (see background.js) once the
// user grants the optional <all_urls> host permission from the options
// page -- never present in manifest.json's static content_scripts, and
// injects nowhere until that permission is actually held.
//
// Loaded right after generic_extract.js (same registerContentScripts() call,
// same isolated world), so window.__captureAgent is already defined here.
//
// Unlike github.js's floating button, this can't assume any particular SPA
// router (Turbo, React Router, whatever) since it runs on arbitrary sites --
// so instead of a framework-specific navigation event, it uses a debounced
// MutationObserver on document.body as the one generic re-check mechanism,
// same technique linkedin.js uses for its virtualized feed.
(function () {
  'use strict';

  const FAB_ID = 'capture-agent-generic-fab';
  const RESET_DELAY_MS = 2500;
  const SCAN_DEBOUNCE_MS = 400;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function createCaptureIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'capture-agent-generic-fab-icon');
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

  function setFabLabel(fab, text) {
    fab.querySelector('.capture-agent-generic-fab-label').textContent = text;
  }

  function getOrCreateFab() {
    let fab = document.getElementById(FAB_ID);
    if (fab) return fab;

    fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.type = 'button';
    fab.className = 'capture-agent-generic-fab';
    fab.appendChild(createCaptureIcon());

    const labelSpan = document.createElement('span');
    labelSpan.className = 'capture-agent-generic-fab-label';
    labelSpan.textContent = 'Capture this page';
    fab.appendChild(labelSpan);

    fab.setAttribute('data-capture-agent-state', 'idle');
    fab.addEventListener('click', handleFabClick);
    document.body.appendChild(fab);
    return fab;
  }

  /**
   * Extracts fresh at click time (not cached from whenever the button
   * appeared) and submits via the existing CAPTURE_POST message -- the same
   * generic handler linkedin.js/github.js already use, so no new background
   * message type is needed here.
   * @param {Event} event
   */
  function handleFabClick(event) {
    event.preventDefault();
    const fab = event.currentTarget;
    if (fab.disabled) return;

    if (!window.__captureAgent.isPageLikelyCapturable()) return;
    const { title, description, author, bodyText, url } = window.__captureAgent.extractGenericPage();
    const content = [title, description, bodyText].filter(Boolean).join('\n\n');
    if (!content) return;

    if (!chrome.runtime?.id) {
      setFabLabel(fab, 'Refresh page to capture');
      fab.setAttribute('data-capture-agent-state', 'error');
      return;
    }

    let platform = 'web_selection';
    try {
      platform = new URL(url || location.href).hostname.replace(/^www\./, '');
    } catch {
      // Leaves the generic fallback bucket in place.
    }

    fab.disabled = true;
    setFabLabel(fab, 'Capturing...');
    fab.setAttribute('data-capture-agent-state', 'loading');

    chrome.runtime.sendMessage(
      {
        type: 'CAPTURE_POST',
        platform,
        payload: { author, text: content, url: url || location.href, postedAt: null },
        capturedAt: new Date().toISOString(),
      },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || !response?.ok) {
          console.error('[CaptureAgent] Power Mode capture failed', lastError?.message || response?.error);
          setFabLabel(fab, 'Failed -- retry');
          fab.setAttribute('data-capture-agent-state', 'error');
          fab.disabled = false;
          return;
        }

        setFabLabel(fab, '✓ Captured');
        fab.setAttribute('data-capture-agent-state', 'success');
        setTimeout(() => {
          setFabLabel(fab, 'Capture this page');
          fab.setAttribute('data-capture-agent-state', 'idle');
          fab.disabled = false;
        }, RESET_DELAY_MS);
      }
    );
  }

  function scan() {
    if (!chrome.runtime?.id) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      return;
    }

    const existingFab = document.getElementById(FAB_ID);
    if (!window.__captureAgent.isPageLikelyCapturable()) {
      existingFab?.remove();
      return;
    }

    const fab = getOrCreateFab();
    // Don't clobber a label mid-capture (loading/success/error) just because
    // a mutation elsewhere triggered a rescan.
    if (fab.getAttribute('data-capture-agent-state') === 'idle') {
      setFabLabel(fab, 'Capture this page');
    }
  }

  let observer = null;
  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  // Disabling Power Mode from the options page broadcasts this so an
  // already-open tab's button disappears immediately, rather than lingering
  // until the next navigation (unregisterContentScripts() only prevents
  // *future* injections, it doesn't reach into tabs the script is already
  // running in).
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'POWER_MODE_DISABLED') {
      observer?.disconnect();
      observer = null;
      document.getElementById(FAB_ID)?.remove();
    }
  });

  function init() {
    if (!chrome.runtime?.id) return;
    scan();
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
