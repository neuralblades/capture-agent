// Injects a .capture-agent-btn into each tweet card's action bar and
// wires it to extraction + messaging.
(function (global) {
  const { SELECTORS } = global.CaptureAgent;

  const INJECTED_ATTR = 'data-capture-agent-injected';
  const STATE_ATTR = 'data-capture-agent-state';

  const CAPTURE_ICON = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/>
      <circle cx="12" cy="13" r="3.5"/>
    </svg>`;

  /**
   * @returns {HTMLButtonElement}
   */
  function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'capture-agent-btn';
    button.setAttribute('aria-label', 'Capture with Capture Agent');
    button.setAttribute(STATE_ATTR, 'idle');
    button.innerHTML = CAPTURE_ICON;
    return button;
  }

  function setButtonState(button, state) {
    button.setAttribute(STATE_ATTR, state);
    button.disabled = state === 'loading';
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

    setButtonState(button, 'loading');

    try {
      const payload = global.CaptureAgent.extractTweetPayload(article);
      await global.CaptureAgent.sendCapturePayload(payload);
      setButtonState(button, 'success');
    } catch (error) {
      console.error('[CaptureAgent] Failed to capture tweet', error);
      setButtonState(button, 'error');
    } finally {
      setTimeout(() => setButtonState(button, 'idle'), 2000);
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
