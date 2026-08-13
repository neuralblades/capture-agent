// Minimal MV3 service worker: relays CAPTURE_TWEET/CAPTURE_POST messages
// from content scripts to the AI backend, and opens the side panel on the
// toolbar icon click. Intentionally thin -- structured extraction and
// JARVIS actions belong to those modules, not extension core.

import { submitCapture } from './capture_client.js';
// Registers the right-click "Capture with Opportunity Agent" menu item; runs
// for its side effects only, so no imports are named here.
import './context_menu.js';

const MESSAGE_TYPES = Object.freeze({
  CAPTURE_TWEET: 'CAPTURE_TWEET',
  // Generic capture message used by non-x.com content scripts (e.g.
  // linkedin.js), which carries its own `platform` instead of it being
  // implied by the message type.
  CAPTURE_POST: 'CAPTURE_POST',
  GENERATE_FORM_ANSWER: 'GENERATE_FORM_ANSWER',
  MAP_FORM_FIELDS: 'MAP_FORM_FIELDS',
  RUN_ACTION: 'RUN_ACTION',
});

const FORM_ANSWER_ENDPOINT = 'http://localhost:8000/generate-form-answer';
const MAP_FORM_FIELDS_ENDPOINT = 'http://localhost:8000/map-form-fields';
const POSTS_ENDPOINT = 'http://localhost:8000/posts';

// Runs every time the (non-persistent) service worker starts up. The setting
// itself persists across restarts once made, but re-asserting it on every
// startup keeps behavior correct even before the first successful call.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[CaptureAgent] Failed to set side panel behavior', error));

/**
 * @param {import('../content/types.js').CaptureMessage} message
 * @returns {Promise<unknown>}
 */
async function capturePost(message) {
  const { payload, capturedAt } = message;

  return submitCapture({
    platform: 'twitter',
    author: payload.author?.displayName || payload.author?.handle || null,
    content: payload.text,
    url: payload.url,
    capturedAt,
  });
}

/**
 * Handles CAPTURE_POST messages from content scripts other than x.com's
 * (e.g. linkedin.js), whose payload is already a flat {author, text, url}
 * shape rather than x.com's nested author object.
 * @param {{platform: string, payload: {author?: string|null, text: string, url?: string|null}, capturedAt: string}} message
 * @returns {Promise<unknown>}
 */
async function captureGenericPost(message) {
  const { payload, capturedAt, platform } = message;

  return submitCapture({
    platform,
    author: payload.author ?? null,
    content: payload.text,
    url: payload.url ?? null,
    capturedAt,
  });
}

/**
 * Options page stores workAuthorized as the select's own string values
 * ('yes'/'no'/'') since chrome.storage.local (and the DOM <select>) don't
 * have a native tri-state boolean; the backend's ProfileContext wants a real
 * boolean (or null when unanswered), so translate here at the one place that
 * crosses that boundary.
 * @param {'yes'|'no'|string|undefined} value
 * @returns {boolean|null}
 */
function toBackendTriState(value) {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

/**
 * @param {Record<string, unknown>} profile - camelCase profile from chrome.storage.local
 * @returns {Record<string, unknown>} snake_case profile matching the backend's ProfileContext
 */
function toBackendProfile(profile) {
  return {
    full_name: profile.fullName ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    linkedin_url: profile.linkedinUrl ?? null,
    github_url: profile.githubUrl ?? null,
    resume_text: profile.resumeText ?? null,
    work_authorized: toBackendTriState(profile.workAuthorized),
    veteran_status: profile.veteranStatus || null,
    disability_status: profile.disabilityStatus || null,
    ethnicity: profile.ethnicity || null,
  };
}

/**
 * @param {{ question: string, profile?: Record<string, unknown> }} message
 * @returns {Promise<string>}
 */
async function generateFormAnswer(message) {
  const response = await fetch(FORM_ANSWER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: message.question,
      profile: toBackendProfile(message.profile || {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Form answer request failed with status ${response.status}`);
  }

  const { answer } = await response.json();
  return answer;
}

/**
 * @param {{ fields: Array<Record<string, unknown>>, profile?: Record<string, unknown> }} message
 * @returns {Promise<Array<{index: number, value: string}>>}
 */
async function mapFormFields(message) {
  const response = await fetch(MAP_FORM_FIELDS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: message.fields || [],
      profile: toBackendProfile(message.profile || {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Field mapping request failed with status ${response.status}`);
  }

  const { mappings } = await response.json();
  return mappings;
}

/**
 * Deletes the underlying post from the backend so a dismissed card doesn't
 * reappear on the next /posts refresh. A 404 (already gone) counts as
 * success -- the sidepanel's goal is just "this id shouldn't be here anymore".
 * @param {number} postId
 * @returns {Promise<void>}
 */
async function dismissPost(postId) {
  if (typeof postId !== 'number' || !Number.isFinite(postId)) {
    throw new Error('Dismiss requires a numeric postId');
  }

  const response = await fetch(`${POSTS_ENDPOINT}/${postId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Dismiss request failed with status ${response.status}`);
  }
}

/**
 * @param {import('../sidepanel/contracts.js').RunActionRequest} message
 * @returns {Promise<void>}
 */
async function runAction(message) {
  if (message.action === 'dismiss') {
    await dismissPost(message.postId);
    return;
  }
  throw new Error(`Unsupported action: ${message.action}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === MESSAGE_TYPES.CAPTURE_TWEET) {
    capturePost(message)
      .then((post) => sendResponse({ ok: true, post }))
      .catch((error) => {
        console.error('[CaptureAgent] Capture failed', error);
        sendResponse({ ok: false, error: error.message });
      });

    // Keep the message channel open: capturePost() resolves/rejects
    // asynchronously, and sendResponse() above runs after this listener returns.
    return true;
  }

  if (message.type === MESSAGE_TYPES.CAPTURE_POST) {
    captureGenericPost(message)
      .then((post) => sendResponse({ ok: true, post }))
      .catch((error) => {
        console.error('[CaptureAgent] Capture failed', error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.type === MESSAGE_TYPES.GENERATE_FORM_ANSWER) {
    generateFormAnswer(message)
      .then((answer) => sendResponse({ ok: true, answer }))
      .catch((error) => {
        console.error('[CaptureAgent] Form answer generation failed', error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.type === MESSAGE_TYPES.MAP_FORM_FIELDS) {
    mapFormFields(message)
      .then((mappings) => sendResponse({ ok: true, mappings }))
      .catch((error) => {
        console.error('[CaptureAgent] Field mapping failed', error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (message.type === MESSAGE_TYPES.RUN_ACTION) {
    runAction(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[CaptureAgent] Action failed', error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  return false;
});
