/**
 * Content script for Web Recall:
 * - Runs in the top-level frame only.
 * - Extracts readable text, chunks it, and sends capture payloads to the background worker.
 * - Supports auto-capture after DOM idle and on-demand FORCE_CAPTURE requests.
 */

const CHUNK_MAX_WORDS = 512;
const AUTO_CAPTURE_IDLE_MS = 1500;
const AUTO_CAPTURE_MAX_WAIT_MS = 20000;

function isTopFrame() {
  try {
    return window.top === window;
  } catch (_) {
    return false;
  }
}

/**
 * Extract the visible text of the page.  We avoid pulling in heavy
 * external libraries here; instead we use the browser's representation
 * of the document.  In practice you may want to integrate Mozilla's
 * Readability.js for better article extraction.
 *
 * @returns {string} Approximate page text.
 */
function extractPageText() {
  let root;
  try {
    root = document.querySelector('article') ||
      document.querySelector('main') ||
      document.body;
  } catch (_) {
    root = document.body;
  }
  if (!root) return '';

  const clone = root.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, code, pre, iframe, svg').forEach(el => el.remove());
  clone.querySelectorAll('nav, footer, header, aside').forEach(el => el.remove());

  const text = clone.innerText || '';
  return text.replace(/\s+\n/g, '\n').trim();
}

function chunkText(text, maxWords = CHUNK_MAX_WORDS) {
  const words = text.split(/\s+/);
  const chunks = [];
  let current = [];

  for (const word of words) {
    current.push(word);
    if (current.length >= maxWords) {
      chunks.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) {
    chunks.push(current.join(' '));
  }
  return chunks;
}

function sendPageToBackground({ force = false } = {}) {
  const proceed = () => {
    const text = extractPageText();
    if (!text) return;

    const chunks = chunkText(text);
    const message = {
      type: 'SAVE_PAGE',
      url: location.href,
      title: document.title || location.href,
      timestamp: Date.now(),
      chunks,
      text,
      force,
      manual: force
    };
    chrome.runtime.sendMessage(message, () => {});
  };

  if (force) {
    proceed();
    return;
  }

  chrome.runtime.sendMessage({ type: 'SHOULD_CAPTURE', url: location.href }, (resp) => {
    if (resp && resp.allow === false) return;
    proceed();
  });
}

function scheduleAutoCapture() {
  let fired = false;
  let idleTimer = null;

  const tryFire = () => {
    if (fired) return;
    fired = true;
    observer.disconnect();
    sendPageToBackground();
  };

  const observer = new MutationObserver(() => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(tryFire, AUTO_CAPTURE_IDLE_MS);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  idleTimer = setTimeout(tryFire, AUTO_CAPTURE_IDLE_MS);
  setTimeout(tryFire, AUTO_CAPTURE_MAX_WAIT_MS);
}

function init() {
  if (!isTopFrame()) return;

  window.addEventListener('load', () => {
    scheduleAutoCapture();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'FORCE_CAPTURE') {
      sendPageToBackground({ force: true });
    }
  });
}

init();
