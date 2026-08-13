// Injects a .capture-agent-btn into each tweet card's action bar and
// wires it to extraction + messaging.
(function (global) {
  const { SELECTORS } = global.CaptureAgent;

  const INJECTED_ATTR = 'data-capture-agent-injected';
  const STATE_ATTR = 'data-capture-agent-state';

  const CAPTURE_ICON = `
    <svg class="capture-agent-btn-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>`;

  const LOADING_ICON = `
    <svg class="capture-agent-btn-icon capture-agent-spinner" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" stroke-opacity="0.25"/>
      <path d="M21 12a9 9 0 0 0-9-9" stroke-linecap="round"/>
    </svg>`;

  const SUCCESS_ICON = `
    <svg class="capture-agent-btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  const ERROR_ICON = `
    <svg class="capture-agent-btn-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 3.5 21.5 20h-19L12 3.5z" stroke-linejoin="round"/>
      <line x1="12" y1="9.5" x2="12" y2="13.5" stroke-linecap="round"/>
      <circle cx="12" cy="16.5" r="0.75" fill="currentColor" stroke="none"/>
    </svg>`;

  const STATE_CONFIG = Object.freeze({
    idle: {
      icon: CAPTURE_ICON,
      label: null,
      title: 'Capture with Capture Agent',
      ariaLabel: 'Capture with Capture Agent',
    },
    loading: {
      icon: LOADING_ICON,
      label: 'Capturing...',
      title: 'Capturing post...',
      ariaLabel: 'Capturing post...',
    },
    success: {
      icon: SUCCESS_ICON,
      label: '✓ Captured!',
      title: 'Successfully Captured!',
      ariaLabel: 'Successfully Captured!',
    },
    error: {
      icon: ERROR_ICON,
      label: 'Failed',
      title: 'Failed to capture. Click to retry.',
      ariaLabel: 'Failed to capture. Click to retry.',
    },
  });

  const RESET_DELAY_MS = 3000;

  /**
   * @returns {HTMLButtonElement}
   */
  function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'capture-agent-btn';
    setButtonState(button, 'idle');
    return button;
  }

  /**
   * @param {HTMLButtonElement} button
   * @param {'idle'|'loading'|'success'|'error'} state
   */
  function setButtonState(button, state) {
    const config = STATE_CONFIG[state] || STATE_CONFIG.idle;

    button.setAttribute(STATE_ATTR, state);
    button.disabled = state === 'loading';
    button.setAttribute('title', config.title);
    button.setAttribute('aria-label', config.ariaLabel);
    button.innerHTML = config.label
      ? `${config.icon}<span class="capture-agent-btn-label">${config.label}</span>`
      : config.icon;
  }

  /**
   * @param {HTMLButtonElement} button
   */
  function clearScheduledReset(button) {
    if (button.__captureAgentResetTimer) {
      clearTimeout(button.__captureAgentResetTimer);
      button.__captureAgentResetTimer = null;
    }
  }

  /**
   * @param {HTMLButtonElement} button
   */
  function scheduleResetToIdle(button) {
    clearScheduledReset(button);
    button.__captureAgentResetTimer = setTimeout(() => {
      button.__captureAgentResetTimer = null;
      setButtonState(button, 'idle');
    }, RESET_DELAY_MS);
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  function isExtensionContextInvalidated(error) {
    return typeof error?.message === 'string' && error.message.includes('Extension context invalidated');
  }

  /**
   * @param {MouseEvent} event
   */
  async function handleCaptureClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const article = button.closest(SELECTORS.tweetArticle);
    if (!article) {
      return;
    }

    clearScheduledReset(button);
    setButtonState(button, 'loading');

    try {
      const payload = global.CaptureAgent.extractTweetPayload(article);
      await global.CaptureAgent.sendCapturePayload(payload);
      setButtonState(button, 'success');
      scheduleResetToIdle(button);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        // The extension was reloaded/updated after this page loaded, so the
        // content script's messaging channel to the background worker is
        // permanently dead. Nothing short of a page refresh fixes this.
        console.error('[CaptureAgent] Extension context invalidated', error);
        setButtonState(button, 'error');
        alert('Capture Agent was updated. Please refresh this page (F5) to continue capturing.');
        return;
      }
      console.error('[CaptureAgent] Failed to capture tweet', error);
      setButtonState(button, 'error');
      scheduleResetToIdle(button);
    }
  }

  /**
   * Injects a capture button into a single tweet card, if not already present.
   * @param {Element} article
   */
  function injectIntoTweet(article) {
    if (article.getAttribute(INJECTED_ATTR) === 'true') {
      return;
    }

    const actionBar = article.querySelector(SELECTORS.actionBar);
    if (!actionBar) {
      return;
    }

    const button = createButton();
    button.addEventListener('click', handleCaptureClick);
    actionBar.appendChild(button);

    article.setAttribute(INJECTED_ATTR, 'true');
  }

  global.CaptureAgent.injectIntoTweet = injectIntoTweet;
})(window);
