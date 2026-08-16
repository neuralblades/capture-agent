// Registers the two Standard Mode capture triggers and submits their result
// to the backend. Imported for its side effects by background.js so it
// shares the same service worker lifecycle.
//
// 1. Right-click "Capture with Opportunity Agent" on selected text, for a
//    short quote/sentence -- submits the selection verbatim as a
//    'web_selection' capture, unchanged from before.
// 2. "Capture this page" -- for a whole blog post/article/announcement.
//    Reachable via three activeTab-qualifying gestures: right-clicking the
//    page (contexts: ['page']), right-clicking the toolbar icon itself
//    (contexts: ['action']), and a keyboard shortcut (commands). All three
//    were live-tested individually before settling on this design -- a
//    fourth candidate, a button inside the side panel, was ruled out because
//    a click there does not carry activeTab access to the underlying tab
//    (Chrome throws "Cannot access contents of the page..."), unlike these
//    three, which do.
//
// Uses extension/content/generic_extract.js's Readability-lite heuristic
// (title/meta description/author + a semantic-or-density-scored body) run
// via a one-shot chrome.scripting.executeScript against the active tab --
// no persistent content script, no host_permissions beyond activeTab.

import { submitCapture } from './capture_client.js';

const SELECTION_MENU_ID = 'capture-agent-capture-selection';
const PAGE_MENU_ID = 'capture-agent-capture-page-menu';
const ACTION_MENU_ID = 'capture-agent-capture-page-action';
const COMMAND_ID = 'capture-agent-capture-page';

const BADGE_RESET_MS = 2500;
const DEFAULT_ACTION_TITLE = 'Capture Agent';

// Copy for each getCapturabilityBlockReason() code (generic_extract.js) --
// kept here, not in the content script, so wording can be iterated on
// without touching extraction logic. A little personality on purpose: a
// flat "capture failed" error doesn't tell the user *why*, and a bare red
// badge is easy to miss/ignore -- naming the actual reason (it's a login
// page, it's a search page, there's just not enough text here) is both more
// informative and more forgivable to see.
const BLOCK_REASON_MESSAGES = {
  'dedicated-integration': "This site already has its own Capture Agent button built for it -- use that one, it knows this site better than I do.",
  password: "That's a login page -- I don't do passwords, so there's nothing for me to remember there.",
  'excluded-path': "This looks like a search/settings/checkout page, not something worth remembering.",
  'no-title': "Couldn't even find a title on this page -- skipping it.",
  'thin-content': "Not much to go on here -- try a page with more actual content.",
};
const GENERIC_FAILURE_MESSAGE = "Hmm, couldn't capture that one -- give it another try?";

// Menu items registered here persist across service worker restarts (Chrome
// stores them independently of the worker's lifetime), so onInstalled --
// which only fires on install/update -- is the right place to create them,
// rather than re-creating them on every worker wakeup.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: SELECTION_MENU_ID,
    title: 'Capture with Opportunity Agent',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: PAGE_MENU_ID,
    title: 'Capture this page with Opportunity Agent',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: ACTION_MENU_ID,
    title: 'Capture this page with Opportunity Agent',
    contexts: ['action'],
  });
});

/**
 * Badge (glanceable, works even unfocused) + toolbar tooltip (the actual
 * message, visible on hover) + a best-effort broadcast so an open side panel
 * can show the same message as a toast immediately, without needing to
 * hover anything. None of the three trigger gestures here guarantee the
 * side panel is open, so the tooltip is the one channel that's always
 * available regardless.
 * @param {boolean} ok
 * @param {string} message
 */
function showCaptureFeedback(ok, message) {
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#cf222e' });
  chrome.action.setTitle({ title: message });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: DEFAULT_ACTION_TITLE });
  }, BADGE_RESET_MS);

  // Best-effort: rejects with "Receiving end does not exist" when no panel
  // is listening, which is the common case and not worth logging.
  chrome.runtime.sendMessage({ type: 'CAPTURE_FEEDBACK', ok, message }).catch(() => {});
}

/**
 * Runs the generic extraction heuristic against `tab` and submits the
 * result. Platform is the page's own hostname (e.g. "medium.com") rather
 * than a fixed enum, so the sidepanel's already-dynamic platform tabs
 * (platformsFromItems in sidepanel.js) pick it up with no new code.
 * @param {chrome.tabs.Tab|undefined} tab
 */
async function captureCurrentTab(tab) {
  if (!tab?.id) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) throw new Error('No active tab found');

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['extension/content/generic_extract.js'],
  });
  // Applies the same capturability gate Power Mode uses to decide whether to
  // show its floating button -- login/search/checkout pages and anything
  // with a password field are excluded here too, even though this is an
  // explicit user-triggered capture. Without this, a page with enough
  // marketing copy (e.g. Instagram's login page) can pass a bare
  // "is there any content" check while still being junk to capture. Reports
  // *why* (not just whether) it was blocked, so the caller can surface a
  // specific message instead of a generic failure.
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const reason = window.__captureAgent.getCapturabilityBlockReason();
      return reason ? { blocked: reason } : { extracted: window.__captureAgent.extractGenericPage() };
    },
  });

  if (result.blocked) {
    throw new Error(BLOCK_REASON_MESSAGES[result.blocked] || GENERIC_FAILURE_MESSAGE);
  }

  const { title, description, author, bodyText, url } = result.extracted;
  const content = [title, description, bodyText].filter(Boolean).join('\n\n');
  if (!content) {
    throw new Error(GENERIC_FAILURE_MESSAGE);
  }

  let platform = 'web_selection';
  try {
    platform = new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    // tab.url missing/unparseable (e.g. a chrome:// page) -- falls back to
    // the same generic bucket manual selection capture already uses.
  }

  return submitCapture({
    platform,
    author,
    content,
    url: url || tab.url || null,
    capturedAt: new Date().toISOString(),
  });
}

async function handleCaptureCurrentTabTrigger(tab) {
  try {
    await captureCurrentTab(tab);
    showCaptureFeedback(true, 'Captured! 📌');
  } catch (error) {
    console.error('[CaptureAgent] Capture this page failed', error);
    showCaptureFeedback(false, error.message || GENERIC_FAILURE_MESSAGE);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === SELECTION_MENU_ID) {
    if (!info.selectionText) return;
    submitCapture({
      platform: 'web_selection',
      author: null,
      content: info.selectionText,
      url: tab?.url ?? info.pageUrl ?? null,
      capturedAt: new Date().toISOString(),
    }).catch((error) => {
      console.error('[CaptureAgent] Failed to capture selection', error);
    });
    return;
  }

  if (info.menuItemId === PAGE_MENU_ID || info.menuItemId === ACTION_MENU_ID) {
    handleCaptureCurrentTabTrigger(tab);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === COMMAND_ID) {
    handleCaptureCurrentTabTrigger(tab);
  }
});
