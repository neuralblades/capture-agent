// Content script: universal ATS form autofill engine (Lever, Greenhouse,
// Workday, Ashby, and other custom application forms built on the same
// patterns). Extends the approach used by form_autofill.js (which stays
// dedicated to Google Forms) to arbitrary DOM structures:
//
//  1. Heuristic engine -- matches text/email/tel/url/textarea inputs against
//     the stored profile using label text, aria-labels, placeholders, names
//     and ids. Confident matches are filled locally, no network call.
//  2. Resume file upload -- fills input[type=file] fields that look
//     resume-related from a resume file stored in the profile (as a data
//     URL), also local-only.
//  3. AI field-mapper fallback -- everything the heuristic engine can't
//     confidently handle (custom text questions, selects, radio/checkbox
//     groups including EEO screening questions like work authorization,
//     veteran status, disability status, ethnicity) is bucketed as a
//     "candidate" and only ever mapped via the backend's /map-form-fields
//     endpoint from an explicit click on the injected "Autofill with AI"
//     button -- never automatically. This mirrors form_autofill.js's
//     per-click-only network policy, and matters more here: guessing wrong
//     on a legally sensitive EEO answer is worse than leaving it blank.
//
// Consent/certification checkboxes ("I agree to the terms", "I certify this
// is accurate") are never touched by either path -- there's no profile
// signal that makes auto-checking those safe.
//
// Runs standalone, like form_autofill.js -- self-contained on purpose so it
// doesn't depend on load order with other content scripts.
//
// @typedef {Object} CaptureAgentProfile
// @property {string} [fullName]
// @property {string} [email]
// @property {string} [phone]
// @property {string} [linkedinUrl]
// @property {string} [githubUrl]
// @property {string} [resumeText]
// @property {'yes'|'no'|''} [workAuthorized]
// @property {string} [veteranStatus]
// @property {string} [disabilityStatus]
// @property {string} [ethnicity]
// @property {string} [resumeFileName]
// @property {string} [resumeFileType]
// @property {string} [resumeFileData] - data: URL
(function () {
  'use strict';

  const PROFILE_STORAGE_KEY = 'profile';
  // pendingCandidates is rebuilt from scratch every pass, so this is the
  // only marker needed: it's what lets a rescan skip already-filled fields
  // while still re-collecting (harmlessly) anything the AI mapper didn't
  // answer last time.
  const FILLED_MARKER = 'captureAgentFilled';
  const AUTOFILL_DEBOUNCE_MS = 500;
  const AI_BUTTON_ID = 'capture-agent-ai-autofill-button';

  // Never fill or forward these to the AI mapper -- there's no profile
  // signal that makes an automated answer safe here.
  const CONSENT_EXCLUDE_PATTERN =
    /\b(agree|consent|certify|certif(y|ication)|acknowledge|accurate to the best|terms (of|and) (service|use|conditions)|privacy policy)\b/i;

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
   * @param {Array<Object>} fields
   * @param {CaptureAgentProfile} profile
   * @returns {Promise<Array<{index: number, value: string}>>}
   */
  function requestFieldMappings(fields, profile) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) {
        reject(new Error('Extension context invalidated'));
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'MAP_FORM_FIELDS', fields, profile }, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          if (!response || !response.ok) {
            reject(new Error(response?.error || 'Field mapping request failed'));
            return;
          }
          resolve(response.mappings || []);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  // ---------------------------------------------------------------------
  // DOM write helpers -- ATS forms are near-universally React/Vue/Angular
  // apps that track input via overridden setters, so plain `.value =` and
  // `.checked =` writes are invisible to them. Same approach as
  // form_autofill.js / extension/actions/form_filler.js.
  // ---------------------------------------------------------------------

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

  function dispatchChangeSequence(element) {
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  function fillTextLike(element, value) {
    element.focus();
    setNativeValue(element, value);
    dispatchChangeSequence(element);
    element.blur();
    element.dataset[FILLED_MARKER] = '1';
  }

  function fillSelect(element, optionValue) {
    element.focus();
    setNativeValue(element, optionValue);
    dispatchChangeSequence(element);
    element.blur();
    element.dataset[FILLED_MARKER] = '1';
  }

  // click() is preferred over setting `.checked` directly because it also
  // fires the framework-visible pointer/click events react-style listeners
  // expect; falls back to a manual set + dispatch for disconnected/disabled
  // elements where click() is a no-op.
  function selectCheckable(element) {
    if (!element.checked) {
      element.click();
    }
    if (!element.checked) {
      element.checked = true;
      dispatchChangeSequence(element);
    }
    element.dataset[FILLED_MARKER] = '1';
  }

  // ---------------------------------------------------------------------
  // Label resolution
  // ---------------------------------------------------------------------

  function textOf(node) {
    return (node?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Resolves the best-effort question/label text for a single input-like element. */
  function labelTextFor(element) {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .join(' ')
        .trim();
      if (text) return text;
    }

    if (element.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (forLabel && textOf(forLabel)) return textOf(forLabel);
    }

    const wrappingLabel = element.closest('label');
    if (wrappingLabel) {
      // Exclude the element's own rendered value/placeholder text from the
      // label (relevant for e.g. a <select> nested inside its <label>).
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach((el) => el.remove());
      const text = textOf(clone);
      if (text) return text;
    }

    const placeholder = element.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    return '';
  }

  /** Resolves the best-effort question text for a radio/checkbox group. */
  function groupLabelTextFor(inputs) {
    const first = inputs[0];

    const fieldset = first.closest('fieldset');
    const legend = fieldset?.querySelector('legend');
    if (legend && textOf(legend)) return textOf(legend);

    const groupContainer = first.closest('[role="radiogroup"], [role="group"]');
    if (groupContainer) {
      const ariaLabel = groupContainer.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      const labelledBy = groupContainer.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => textOf(document.getElementById(id)))
          .join(' ')
          .trim();
        if (text) return text;
      }
    }

    // Fall back to the first heading-ish element preceding the group inside
    // its nearest reasonably-sized ancestor.
    const container = first.closest('fieldset, [role="radiogroup"], [role="group"], li, div');
    if (container) {
      const heading = container.querySelector('legend, [role="heading"], h1, h2, h3, h4, label');
      if (heading && textOf(heading)) return textOf(heading);
    }

    return '';
  }

  // ---------------------------------------------------------------------
  // Profile-key matching (direct-fill identity fields)
  // ---------------------------------------------------------------------

  // Checked in order so a specific pattern wins over a generic one.
  const LABEL_MATCHERS = [
    { key: 'email', pattern: /e-?mail/i },
    { key: 'phone', pattern: /phone|mobile(?! app)|contact number/i },
    { key: 'linkedinUrl', pattern: /linkedin/i },
    { key: 'githubUrl', pattern: /github/i },
    { key: 'firstName', pattern: /first name|given name/i },
    { key: 'lastName', pattern: /last name|family name|surname/i },
    { key: 'resumeText', pattern: /resume|\bcv\b/i },
    { key: 'fullName', pattern: /full name|your name|first and last name|^name$|applicant'?s? name|candidate'?s? name/i },
  ];

  // Matched against a normalized string of the element's name/id/
  // data-automation-id attributes when the visible label yields nothing --
  // covers ATS platforms (Workday in particular) that render custom widgets
  // where the visible label isn't reliably associated with the input via
  // label/aria. Deliberately narrower than LABEL_MATCHERS to avoid false
  // positives on generic attribute names like "companyName".
  const ATTRIBUTE_MATCHERS = [
    { key: 'email', pattern: /e.?mail/i },
    { key: 'phone', pattern: /phone|mobile|telnumber/i },
    { key: 'linkedinUrl', pattern: /linkedin/i },
    { key: 'githubUrl', pattern: /github/i },
    { key: 'firstName', pattern: /first.?name|fname\b|givenname/i },
    { key: 'lastName', pattern: /last.?name|lname\b|familyname|surname/i },
    { key: 'fullName', pattern: /full.?name|applicantname|candidatename|_name$|\[name\]|^name$/i },
  ];

  function attributeStringFor(element) {
    return [element.getAttribute('name'), element.id, element.getAttribute('data-automation-id')]
      .filter(Boolean)
      .join(' ');
  }

  function matchKey(matchers, text) {
    if (!text) return null;
    for (const { key, pattern } of matchers) {
      if (pattern.test(text)) return key;
    }
    return null;
  }

  /** @returns {string|null} a profile key, possibly the pseudo-keys 'firstName'/'lastName' */
  function matchProfileKey(element, labelText) {
    return matchKey(LABEL_MATCHERS, labelText) || matchKey(ATTRIBUTE_MATCHERS, attributeStringFor(element));
  }

  function splitName(fullName) {
    const trimmed = (fullName || '').trim();
    if (!trimmed) return { firstName: '', lastName: '' };
    const parts = trimmed.split(/\s+/);
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  function resolveProfileValue(key, profile) {
    if (key === 'firstName' || key === 'lastName') {
      return splitName(profile.fullName)[key];
    }
    return profile[key];
  }

  // ---------------------------------------------------------------------
  // Category matching for ambiguous EEO/screening groups. Only used to
  // decide whether a *confident* direct fill is possible (a plain Yes/No
  // work-authorization radio group) -- everything else in these categories
  // goes to the AI mapper, since ATS wording for veteran/disability/
  // ethnicity questions varies too much to guess safely.
  // ---------------------------------------------------------------------

  const WORK_AUTH_PATTERN =
    /work authoriz|authorized to work|legally (?:authorized|entitled|eligible) to work|require.{0,20}sponsorship|need.{0,20}sponsorship/i;

  function tryFillWorkAuthorizationGroup(inputs, groupLabel, profile) {
    if (!WORK_AUTH_PATTERN.test(groupLabel)) return false;
    if (profile.workAuthorized !== 'yes' && profile.workAuthorized !== 'no') return false;
    if (inputs.length !== 2) return false;

    const target = inputs.find((input) => {
      const text = labelTextFor(input).trim().toLowerCase();
      return text === profile.workAuthorized;
    });
    if (!target) return false;

    selectCheckable(target);
    for (const input of inputs) input.dataset[FILLED_MARKER] = '1';
    return true;
  }

  // ---------------------------------------------------------------------
  // Candidate collection (fields sent to the AI mapper on explicit opt-in)
  // ---------------------------------------------------------------------

  /** @type {Array<{descriptor: Object, apply: (value: string) => void}>} */
  let pendingCandidates = [];

  function isTextLikeCandidate(element) {
    if (element.dataset[FILLED_MARKER]) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'email', 'tel', 'url'].includes(type);
    }
    return false;
  }

  function collectTextLikeCandidate(element) {
    const labelText = labelTextFor(element);
    if (!labelText || CONSENT_EXCLUDE_PATTERN.test(labelText)) return;

    const index = pendingCandidates.length;
    pendingCandidates.push({
      descriptor: {
        index,
        type: element.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text',
        label: labelText,
        name: element.getAttribute('name') || undefined,
        placeholder: element.getAttribute('placeholder') || undefined,
      },
      apply: (value) => fillTextLike(element, value),
    });
  }

  function collectSelectCandidate(element) {
    if (element.dataset[FILLED_MARKER]) return;
    const labelText = labelTextFor(element);
    if (!labelText || CONSENT_EXCLUDE_PATTERN.test(labelText)) return;

    const options = Array.from(element.options)
      .filter((option) => option.value && !option.disabled)
      .map((option) => ({ value: option.value, label: textOf(option) || option.value }));
    if (options.length === 0) return;

    const index = pendingCandidates.length;
    pendingCandidates.push({
      descriptor: { index, type: 'select', label: labelText, name: element.getAttribute('name') || undefined, options },
      apply: (value) => fillSelect(element, value),
    });
  }

  function optionValueFor(input, fallbackLabel) {
    const raw = input.value;
    if (raw && raw.toLowerCase() !== 'on') return raw;
    return input.id || fallbackLabel;
  }

  function collectGroupCandidate(inputs, groupLabel, type) {
    if (!groupLabel || CONSENT_EXCLUDE_PATTERN.test(groupLabel)) return;
    if (inputs.some((input) => input.dataset[FILLED_MARKER])) return;

    const options = inputs.map((input) => {
      const label = labelTextFor(input) || textOf(input.closest('label')) || input.value;
      return { value: optionValueFor(input, label), label: label || input.value || '(option)' };
    });

    const index = pendingCandidates.length;
    pendingCandidates.push({
      descriptor: { index, type, label: groupLabel, options },
      apply: (value) => {
        const target = inputs.find((input, i) => options[i].value === value);
        if (target) selectCheckable(target);
      },
    });
  }

  // ---------------------------------------------------------------------
  // File upload (resume)
  // ---------------------------------------------------------------------

  const RESUME_FIELD_PATTERN = /resume|\bcv\b/i;

  function looksLikeResumeInput(element) {
    if (RESUME_FIELD_PATTERN.test(labelTextFor(element))) return true;
    return RESUME_FIELD_PATTERN.test(attributeStringFor(element));
  }

  async function fillResumeFileInput(element, profile) {
    if (element.dataset[FILLED_MARKER]) return;
    if (!profile.resumeFileData || !profile.resumeFileName) return;
    if (!looksLikeResumeInput(element)) return;

    try {
      const response = await fetch(profile.resumeFileData);
      const blob = await response.blob();
      const file = new File([blob], profile.resumeFileName, {
        type: profile.resumeFileType || blob.type || 'application/octet-stream',
      });

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      element.files = dataTransfer.files;
      dispatchChangeSequence(element);
      element.dataset[FILLED_MARKER] = '1';
    } catch (error) {
      console.error('[CaptureAgent] Failed to attach resume file', error);
    }
  }

  // ---------------------------------------------------------------------
  // AI-mapper button
  // ---------------------------------------------------------------------

  function ensureAiButton() {
    let button = document.getElementById(AI_BUTTON_ID);
    if (pendingCandidates.length === 0) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement('button');
      button.id = AI_BUTTON_ID;
      button.type = 'button';
      Object.assign(button.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: '2147483647',
        padding: '10px 16px',
        fontSize: '13px',
        fontWeight: '600',
        color: '#fff',
        background: '#7c5cff',
        border: 'none',
        borderRadius: '8px',
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
        cursor: 'pointer',
      });
      button.addEventListener('click', () => onAiButtonClick(button));
      document.body.appendChild(button);
    }

    button.disabled = false;
    button.textContent = `✨ Autofill ${pendingCandidates.length} field${pendingCandidates.length === 1 ? '' : 's'} with AI`;
  }

  // Re-reads the profile at click time (rather than reusing the one from the
  // pass that created the button) so an edit made in the options page while
  // the button was already showing isn't sent stale.
  async function onAiButtonClick(button) {
    button.disabled = true;
    button.textContent = 'Mapping fields…';

    const candidates = pendingCandidates;
    try {
      const profile = await getProfile();
      const mappings = await requestFieldMappings(
        candidates.map((c) => c.descriptor),
        profile
      );
      const byIndex = new Map(mappings.map((m) => [m.index, m.value]));
      for (const candidate of candidates) {
        const value = byIndex.get(candidate.descriptor.index);
        if (value !== undefined) candidate.apply(value);
      }
    } catch (error) {
      console.error('[CaptureAgent] Field mapping failed', error);
      button.textContent = 'Autofill with AI -- retry';
      button.disabled = false;
      return;
    }

    // Re-scan: filled candidates drop out (FILLED_MARKER), anything the
    // model skipped stays a candidate and is re-collected below.
    scheduleAutofillPass();
  }

  // ---------------------------------------------------------------------
  // Main pass
  // ---------------------------------------------------------------------

  function fillIdentityFields(profile) {
    const candidates = document.querySelectorAll("input[type='text'], input[type='email'], input[type='tel'], input[type='url'], textarea");

    for (const element of candidates) {
      if (element.dataset[FILLED_MARKER]) continue;

      const labelText = labelTextFor(element);
      const key = matchProfileKey(element, labelText);
      const value = key ? resolveProfileValue(key, profile) : null;

      if (value) {
        fillTextLike(element, value);
      } else if (isTextLikeCandidate(element)) {
        collectTextLikeCandidate(element);
      }
    }
  }

  function fillSelects() {
    for (const select of document.querySelectorAll('select')) {
      collectSelectCandidate(select);
    }
  }

  function groupByName(elements) {
    const groups = new Map();
    for (const element of elements) {
      const name = element.getAttribute('name');
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(element);
    }
    return groups;
  }

  function fillRadioAndCheckboxGroups(profile) {
    const radioGroups = groupByName(document.querySelectorAll("input[type='radio']"));
    for (const inputs of radioGroups.values()) {
      if (inputs.some((input) => input.dataset[FILLED_MARKER])) continue;
      const groupLabel = groupLabelTextFor(inputs);
      if (!groupLabel || CONSENT_EXCLUDE_PATTERN.test(groupLabel)) continue;

      if (tryFillWorkAuthorizationGroup(inputs, groupLabel, profile)) continue;
      collectGroupCandidate(inputs, groupLabel, 'radio-group');
    }

    const checkboxGroups = groupByName(document.querySelectorAll("input[type='checkbox']"));
    for (const inputs of checkboxGroups.values()) {
      if (inputs.length < 2) continue; // lone checkboxes are almost always consent/agreement -- never touched
      if (inputs.some((input) => input.dataset[FILLED_MARKER])) continue;
      const groupLabel = groupLabelTextFor(inputs);
      collectGroupCandidate(inputs, groupLabel, 'checkbox-group');
    }
  }

  function fillResumeFiles(profile) {
    for (const input of document.querySelectorAll("input[type='file']")) {
      fillResumeFileInput(input, profile).catch((error) =>
        console.error('[CaptureAgent] Resume file fill failed', error)
      );
    }
  }

  async function runAutofillPass() {
    const profile = await getProfile();
    if (!profile || Object.keys(profile).length === 0) return;

    pendingCandidates = [];

    fillIdentityFields(profile);
    fillSelects();
    fillRadioAndCheckboxGroups(profile);
    fillResumeFiles(profile);

    ensureAiButton();
  }

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

    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && PROFILE_STORAGE_KEY in changes) {
        scheduleAutofillPass();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
