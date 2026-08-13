// Registers a right-click "Capture with Opportunity Agent" context menu item
// for selected text on any webpage, and submits the selection straight to
// the backend as a 'web_selection' capture. Imported for its side effects by
// background.js so it shares the same service worker lifecycle.

import { submitCapture } from './capture_client.js';

const MENU_ITEM_ID = 'capture-agent-capture-selection';

// Menu items registered here persist across service worker restarts (Chrome
// stores them independently of the worker's lifetime), so onInstalled --
// which only fires on install/update -- is the right place to create it,
// rather than re-creating it on every worker wakeup.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ITEM_ID,
    title: 'Capture with Opportunity Agent',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ITEM_ID || !info.selectionText) {
    return;
  }

  submitCapture({
    platform: 'web_selection',
    author: null,
    content: info.selectionText,
    url: tab?.url ?? info.pageUrl ?? null,
    capturedAt: new Date().toISOString(),
  }).catch((error) => {
    console.error('[CaptureAgent] Failed to capture selection', error);
  });
});
