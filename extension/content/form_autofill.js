// Content script: auto-fills Google Forms from the user's stored profile
// (extension/sidepanel is expected to write to this key), and offers to draft
// answers for open-ended questions it can't match directly.
//
// Only the profile fill is automatic -- it's a local read + DOM write, no
// network call. Drafting an open-ended answer sends the question (and the
// user's profile, including resume text) to the backend, and Google Forms
// URLs aren't limited to job applications, so that step is opt-in per field:
// a "Draft with AI" button is attached next to each unmatched textarea
// instead of firing automatically. This also means there's no unattended
// retry loop -- each backend request is tied to a single user click.
//
// Runs standalone -- unlike the x.com content scripts, this is the only file
// injected on docs.google.com/forms/*, so it can't rely on the CaptureAgent
// globals those files set up.
//
// @typedef {Object} CaptureAgentProfile
// @property {string} [fullName]
// @property {string} [email]
// @property {string} [phone]
// @property {string} [linkedinUrl]
// @property {string} [githubUrl]
// @property {string} [resumeText]
(function () {
  'use strict';

  const PROFILE_STORAGE_KEY = 'profile';
  const FILLED_MARKER = 'captureAgentFilled';
  const DRAFT_BUTTON_MARKER = 'captureAgentDraftButton';
  const AUTOFILL_DEBOUNCE_MS = 400;

  // Checked in order, so a specific pattern (e.g. "linkedin") wins over a
  // generic one (e.g. "name") when a label could match more than one field.
  const FIELD_MATCHERS = [
    { key: 'email', pattern: /e-?mail/i },
    { key: 'phone', pattern: /phone|mobile(?! app)|contact number/i },
    { key: 'linkedinUrl', pattern: /linkedin/i },
    { key: 'githubUrl', pattern: /github/i },
    { key: 'resumeText', pattern: /resume|\bcv\b/i },
    { key: 'fullName', pattern: /full name|your name|first and last name|^name$/i },
  ];

  /** @returns {Promise<CaptureAgentProfile>} */
  function getProfile() {
    return new Promise((resolve) => {
      if (!chrome.runtime?.id || !chrome.storage?.local) {
        resolve({});
        return;
      }
      chrome.storage.local.get(PROFILE_STORAGE_KEY, (result) => {
        resolve(result[PROFILE_STORAGE_KEY] || {});
      });
    });
  }

  /**
   * @param {string} question
   * @param {CaptureAgentProfile} profile
   * @returns {Promise<string>}
   */
  function requestFormAnswer(question, profile) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) {
        reject(new Error('Extension context invalidated'));
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { type: 'GENERATE_FORM_ANSWER', question, profile },
          (response) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              reject(new Error(lastError.message));
              return;
            }
            if (!response || !response.ok) {
              reject(new Error(response?.error || 'Form answer request failed'));
              return;
            }
            resolve(response.answer);
          }
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  // Google Forms' input widgets track their own value via React-style
  // overridden setters, so plain `element.value = x` is invisible to them.
  // Calling the native prototype setter directly bypasses that, and the
  // subsequent 'input' event is then observed the same way a keystroke would be.
  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const descriptor =
      Object.getOwnPropertyDescriptor(proto, 'value') ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(proto), 'value');

    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function fillField(element, value) {
    element.focus();
    setNativeValue(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.blur();
    element.dataset[FILLED_MARKER] = '1';
  }

  // Resolves the question text for a field: prefers aria-label/aria-labelledby
  // (what Google Forms sets on the input itself), then falls back to the
  // question heading in the enclosing listitem container.
  function labelTextFor(element) {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim();
      if (text) return text;
    }

    const container = element.closest('[role="listitem"]');
    const heading = container?.querySelector('[role="heading"]');
    if (heading && heading.textContent.trim()) return heading.textContent.trim();

    return '';
  }

  function matchProfileKey(labelText) {
    for (const { key, pattern } of FIELD_MATCHERS) {
      if (pattern.test(labelText)) return key;
    }
    return null;
  }

  function isCandidateInput(element) {
    if (element.dataset[FILLED_MARKER]) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return type === 'text' || type === 'email';
    }
    return false;
  }

  /**
   * Attaches a "Draft with AI" button next to an unmatched open-ended
   * textarea. The backend call only ever happens from this button's click
   * handler -- never automatically -- so a failed request just leaves the
   * button re-clickable instead of retrying on its own.
   */
  function attachDraftButton(element, labelText, profile) {
    if (element.dataset[DRAFT_BUTTON_MARKER]) return;
    element.dataset[DRAFT_BUTTON_MARKER] = '1';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '✨ Draft with AI';
    Object.assign(button.style, {
      display: 'inline-block',
      marginTop: '6px',
      padding: '4px 10px',
      fontSize: '12px',
      color: '#1a73e8',
      background: '#fff',
      border: '1px solid #1a73e8',
      borderRadius: '4px',
      cursor: 'pointer',
    });

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      button.disabled = true;
      button.textContent = 'Drafting…';
      try {
        const answer = await requestFormAnswer(labelText, profile);
        if (answer) fillField(element, answer);
        button.textContent = '✨ Draft with AI';
        button.disabled = false;
      } catch (error) {
        console.error('[CaptureAgent] Failed to generate form answer', error);
        button.textContent = 'Draft failed -- retry';
        button.disabled = false;
      }
    });

    element.insertAdjacentElement('afterend', button);
  }

  /**
   * Fills every field that matches a known profile key directly (a local
   * read + DOM write, no network call), and attaches an opt-in "Draft with
   * AI" button to unmatched open-ended textareas.
   */
  function fillStandardFields(profile) {
    const candidates = document.querySelectorAll("input[type='text'], input[type='email'], textarea");

    for (const element of candidates) {
      const labelText = labelTextFor(element);
      const key = matchProfileKey(labelText);
      const value = key && profile[key];

      if (value && isCandidateInput(element)) {
        fillField(element, value);
        continue;
      }

      if (!value && element.tagName.toLowerCase() === 'textarea' && labelText) {
        attachDraftButton(element, labelText, profile);
      }
    }
  }

  async function runAutofillPass() {
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) return;

    fillStandardFields(profile);
  }

  // Google Forms renders its questions asynchronously after the initial page
  // load (and can reveal more via branching logic), so a single pass at
  // document_idle can run before any inputs exist. Debounce and rescan on DOM
  // mutations to catch fields that show up later. This rescanning is cheap and
  // side-effect-free: it only touches local storage and the DOM (FILLED_MARKER/
  // DRAFT_BUTTON_MARKER make each field's fill/button-attach idempotent), and
  // never itself triggers a backend call -- that only happens from a user's
  // own click on a "Draft with AI" button.
  let debounceTimer = null;
  function scheduleAutofillPass() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runAutofillPass().catch((error) => console.error('[CaptureAgent] Autofill pass failed', error));
    }, AUTOFILL_DEBOUNCE_MS);
  }

  function init() {
    scheduleAutofillPass();
    new MutationObserver(scheduleAutofillPass).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
