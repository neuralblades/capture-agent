// Reads/writes the profile chrome.storage.local key that the autofill content
// scripts (form_autofill.js for Google Forms, universal_autofill.js for ATS
// platforms) consume.
const PROFILE_STORAGE_KEY = 'profile';
const TEXT_FIELDS = [
  'fullName',
  'email',
  'phone',
  'linkedinUrl',
  'githubUrl',
  'resumeText',
  'workAuthorized',
  'veteranStatus',
  'disabilityStatus',
  'ethnicity',
];
// Stored separately from TEXT_FIELDS since the resume file is read via
// FileReader rather than read straight off an <input>'s .value.
const RESUME_FILE_FIELDS = ['resumeFileName', 'resumeFileType', 'resumeFileData'];

const els = Object.fromEntries(TEXT_FIELDS.map((field) => [field, document.getElementById(field)]));
const form = document.getElementById('profile-form');
const status = document.getElementById('status');
const resumeFileInput = document.getElementById('resumeFile');
const resumeFileName = document.getElementById('resumeFileName');

// Holds the pending resume file's data URL between "choose file" and "Save",
// so a selected-but-unsaved file doesn't silently disappear on submit.
let pendingResumeFile = null;

function loadProfile() {
  chrome.storage.local.get(PROFILE_STORAGE_KEY, (result) => {
    const profile = result[PROFILE_STORAGE_KEY] || {};
    for (const field of TEXT_FIELDS) {
      els[field].value = profile[field] || '';
    }
    pendingResumeFile = null;
    resumeFileName.textContent = profile.resumeFileName || '';
  });
}

let statusTimer = null;
function showStatus(message) {
  status.textContent = message;
  status.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('visible'), 2000);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

resumeFileInput.addEventListener('change', async () => {
  const file = resumeFileInput.files[0];
  if (!file) return;

  try {
    const data = await readFileAsDataUrl(file);
    pendingResumeFile = { resumeFileName: file.name, resumeFileType: file.type, resumeFileData: data };
    resumeFileName.textContent = file.name;
  } catch (error) {
    console.error('[CaptureAgent] Failed to read resume file', error);
    resumeFileName.textContent = 'Failed to read file';
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const profile = Object.fromEntries(TEXT_FIELDS.map((field) => [field, els[field].value.trim()]));

  chrome.storage.local.get(PROFILE_STORAGE_KEY, (result) => {
    const existing = result[PROFILE_STORAGE_KEY] || {};
    if (pendingResumeFile) {
      Object.assign(profile, pendingResumeFile);
    } else {
      for (const field of RESUME_FILE_FIELDS) {
        if (existing[field]) profile[field] = existing[field];
      }
    }

    chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: profile }, () => {
      pendingResumeFile = null;
      showStatus('Saved');
    });
  });
});

loadProfile();

// --- Feeds -----------------------------------------------------------------
// Feeds are backend-owned state (the poller runs server-side), not
// chrome.storage.local -- unlike the profile form above, "Add"/"Remove" here
// talk straight to the backend rather than a local key.
const FEEDS_ENDPOINT = 'http://localhost:8000/feeds';

const feedForm = document.getElementById('feed-form');
const feedUrlInput = document.getElementById('feedUrl');
const feedLabelInput = document.getElementById('feedLabel');
const feedStatus = document.getElementById('feedStatus');
const feedList = document.getElementById('feedList');

let feedStatusTimer = null;
function showFeedStatus(message, { isError = false } = {}) {
  feedStatus.textContent = message;
  feedStatus.classList.toggle('error', isError);
  feedStatus.classList.add('visible');
  clearTimeout(feedStatusTimer);
  feedStatusTimer = setTimeout(() => feedStatus.classList.remove('visible'), 2500);
}

function renderFeeds(feeds) {
  feedList.innerHTML = '';

  if (feeds.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'feed-list-empty';
    empty.textContent = 'No feeds subscribed yet.';
    feedList.appendChild(empty);
    return;
  }

  for (const feed of feeds) {
    const item = document.createElement('li');
    item.className = 'feed-item';

    const info = document.createElement('div');
    info.className = 'feed-item-info';

    const label = document.createElement('span');
    label.className = 'feed-item-label';
    label.textContent = feed.label || feed.url;
    info.appendChild(label);

    const url = document.createElement('span');
    url.className = 'feed-item-url';
    url.textContent = feed.url;
    info.appendChild(url);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'feed-item-remove';
    removeButton.textContent = 'Remove';
    removeButton.addEventListener('click', () => removeFeed(feed.id));

    item.append(info, removeButton);
    feedList.appendChild(item);
  }
}

async function loadFeeds() {
  try {
    const response = await fetch(FEEDS_ENDPOINT);
    if (!response.ok) throw new Error(`Failed to load feeds (status ${response.status})`);
    renderFeeds(await response.json());
  } catch (error) {
    console.error('[CaptureAgent] Failed to load feeds', error);
    feedList.innerHTML = '';
    const errorItem = document.createElement('li');
    errorItem.className = 'feed-list-empty';
    errorItem.textContent = 'Could not reach the backend to load feeds.';
    feedList.appendChild(errorItem);
  }
}

async function removeFeed(feedId) {
  try {
    const response = await fetch(`${FEEDS_ENDPOINT}/${feedId}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to remove feed (status ${response.status})`);
    }
    await loadFeeds();
  } catch (error) {
    console.error('[CaptureAgent] Failed to remove feed', error);
    showFeedStatus('Failed to remove feed', { isError: true });
  }
}

feedForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = feedUrlInput.value.trim();
  const label = feedLabelInput.value.trim();
  if (!url) return;

  try {
    const response = await fetch(FEEDS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, label: label || null }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Failed to add feed (status ${response.status})`);
    }

    feedUrlInput.value = '';
    feedLabelInput.value = '';
    showFeedStatus('Feed added');
    await loadFeeds();
  } catch (error) {
    console.error('[CaptureAgent] Failed to add feed', error);
    showFeedStatus(error.message || 'Failed to add feed', { isError: true });
  }
});

loadFeeds();

// --- Privacy & Capture (Power Mode) -----------------------------------------
// Deliberately not a plain radio pair that fires chrome.permissions.request()
// as a side effect of selection -- <all_urls> is significant enough that the
// explanation has to be read before Chrome's own prompt appears, not
// stumbled into. chrome.permissions.request()/.remove() are called directly
// in these click handlers (not after an intervening message round-trip)
// since they must run within a real user gesture; the actual
// register/unregister of the floating-button content script is delegated to
// background.js, which owns that state.
const CAPTURE_MODE_KEY = 'captureMode';

const powerModeOffView = document.getElementById('power-mode-off-view');
const powerModeOnView = document.getElementById('power-mode-on-view');
const enablePowerModeBtn = document.getElementById('enable-power-mode-btn');
const disablePowerModeBtn = document.getElementById('disable-power-mode-btn');
const powerModeStatus = document.getElementById('power-mode-status');
const powerModeStatusOn = document.getElementById('power-mode-status-on');

function showPowerModeView(isPowerMode) {
  powerModeOffView.hidden = isPowerMode;
  powerModeOnView.hidden = !isPowerMode;
}

function showPowerModeStatus(el, message, isError = false) {
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function sendBackgroundMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response from background' });
    });
  });
}

function loadPowerModeState() {
  chrome.storage.local.get(CAPTURE_MODE_KEY, (result) => {
    showPowerModeView(result[CAPTURE_MODE_KEY] === 'power');
  });
}

enablePowerModeBtn.addEventListener('click', async () => {
  enablePowerModeBtn.disabled = true;
  showPowerModeStatus(powerModeStatus, '');
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) {
      showPowerModeStatus(powerModeStatus, 'Permission denied.', true);
      return;
    }

    const response = await sendBackgroundMessage({ type: 'POWER_MODE_ENABLED' });
    if (!response.ok) {
      showPowerModeStatus(powerModeStatus, response.error || 'Failed to enable Power Mode.', true);
      return;
    }
    showPowerModeView(true);
  } catch (error) {
    showPowerModeStatus(powerModeStatus, error.message || 'Permission request failed.', true);
  } finally {
    enablePowerModeBtn.disabled = false;
  }
});

disablePowerModeBtn.addEventListener('click', async () => {
  disablePowerModeBtn.disabled = true;
  showPowerModeStatus(powerModeStatusOn, '');
  try {
    const response = await sendBackgroundMessage({ type: 'POWER_MODE_DISABLED' });
    if (!response.ok) {
      showPowerModeStatus(powerModeStatusOn, response.error || 'Failed to disable Power Mode.', true);
      return;
    }
    // Revoked last, after the content script is already unregistered -- if
    // this were first, a page navigating mid-toggle could momentarily hold
    // the permission with nothing registered to use it.
    await chrome.permissions.remove({ origins: ['<all_urls>'] });
    showPowerModeView(false);
  } finally {
    disablePowerModeBtn.disabled = false;
  }
});

loadPowerModeState();
