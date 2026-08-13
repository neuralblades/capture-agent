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
