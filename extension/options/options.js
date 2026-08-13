// Reads/writes the profile chrome.storage.local key that
// extension/content/form_autofill.js consumes to fill Google Forms.
const PROFILE_STORAGE_KEY = 'profile';
const FIELDS = ['fullName', 'email', 'phone', 'linkedinUrl', 'githubUrl', 'resumeText'];

const els = Object.fromEntries(FIELDS.map((field) => [field, document.getElementById(field)]));
const form = document.getElementById('profile-form');
const status = document.getElementById('status');

function loadProfile() {
  chrome.storage.local.get(PROFILE_STORAGE_KEY, (result) => {
    const profile = result[PROFILE_STORAGE_KEY] || {};
    for (const field of FIELDS) {
      els[field].value = profile[field] || '';
    }
  });
}

let statusTimer = null;
function showStatus(message) {
  status.textContent = message;
  status.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove('visible'), 2000);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const profile = Object.fromEntries(
    FIELDS.map((field) => [field, els[field].value.trim()])
  );

  chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: profile }, () => {
    showStatus('Saved');
  });
});

loadProfile();
