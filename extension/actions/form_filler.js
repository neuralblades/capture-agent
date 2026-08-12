/**
 * JARVIS action: form_filler
 *
 * Fills web forms by dispatching synthetic DOM events, so frameworks that
 * track input via React/Vue's internal value trackers (not just the raw
 * `.value` property) still observe the change. Runs as a content script —
 * it needs direct DOM access, which the MV3 service worker doesn't have.
 *
 * @typedef {Object} FormField
 * @property {string} selector - CSS selector identifying the target element.
 * @property {string} value - Value to enter. For 'checkbox'/'radio', any of
 *   "true"/"false"/"1"/"0" (case-insensitive) is treated as a boolean.
 * @property {'text'|'textarea'|'select'|'checkbox'|'radio'} [type] - Field
 *   kind. Inferred from the element's tag/type when omitted.
 *
 * @typedef {Object} FormFillRequest
 * @property {FormField[]} fields
 *
 * @typedef {Object} FieldFillError
 * @property {string} selector
 * @property {string} error
 *
 * @typedef {Object} FormFillResult
 * @property {boolean} success - True only if every field was filled.
 * @property {number} filled - Count of fields successfully filled.
 * @property {FieldFillError[]} errors
 */

(function (root) {
  'use strict';

  const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

  function inferType(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'input') {
      const inputType = (element.getAttribute('type') || 'text').toLowerCase();
      if (inputType === 'checkbox' || inputType === 'radio') return inputType;
    }
    return 'text';
  }

  // Bypasses React's/Vue's overridden `value` setter by calling the native
  // HTMLInputElement/HTMLTextAreaElement prototype setter directly, so the
  // framework's change-detection still fires on the subsequent input event.
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

  function fillTextLike(element, value) {
    element.focus();
    setNativeValue(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.blur();
  }

  function fillSelect(element, value) {
    setNativeValue(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  function fillCheckable(element, value) {
    const shouldCheck = TRUE_VALUES.has(String(value).toLowerCase());
    if (element.checked !== shouldCheck) {
      element.click();
    }
    if (element.checked !== shouldCheck) {
      // click() can be a no-op for disconnected/disabled elements; fall back
      // to setting the property directly and firing events by hand.
      element.checked = shouldCheck;
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
  }

  /**
   * @param {FormField} field
   * @returns {{ok: true}|{ok: false, error: string}}
   */
  function fillField(field) {
    if (!field || typeof field.selector !== 'string' || !field.selector) {
      return { ok: false, error: 'Field is missing a "selector" string.' };
    }

    let element;
    try {
      element = document.querySelector(field.selector);
    } catch (err) {
      return { ok: false, error: `Invalid selector "${field.selector}": ${err.message}` };
    }

    if (!element) {
      return { ok: false, error: `No element matched selector: ${field.selector}` };
    }

    const type = field.type || inferType(element);

    try {
      switch (type) {
        case 'checkbox':
        case 'radio':
          fillCheckable(element, field.value);
          break;
        case 'select':
          fillSelect(element, field.value);
          break;
        case 'textarea':
        case 'text':
        default:
          fillTextLike(element, field.value);
          break;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /**
   * @param {FormFillRequest} request
   * @returns {FormFillResult}
   */
  function fillForm(request) {
    const fields = (request && Array.isArray(request.fields)) ? request.fields : [];
    const errors = [];
    let filled = 0;

    for (const field of fields) {
      const result = fillField(field);
      if (result.ok) {
        filled += 1;
      } else {
        errors.push({ selector: field && field.selector, error: result.error });
      }
    }

    return { success: errors.length === 0 && fields.length > 0, filled, errors };
  }

  const formFiller = { fillForm, fillField };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = formFiller;
  } else {
    root.JarvisFormFiller = formFiller;
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.action !== 'FILL_FORM') {
        return undefined;
      }
      const result = fillForm(message.payload);
      sendResponse(result);
      return true;
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
