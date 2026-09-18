const CHUNK_MAX_WORDS = 512;
const AUTO_CAPTURE_IDLE_MS = 1500;
const AUTO_CAPTURE_MAX_WAIT_MS = 20_000;
const URL_CHECK_INTERVAL_MS = 2000;

function isTopFrame(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function extractPageText(): string {
  let root: HTMLElement | null;
  try {
    root = (document.querySelector('article') || document.querySelector('main') || document.body) as HTMLElement | null;
  } catch {
    root = document.body;
  }
  if (!root) return '';
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, style, noscript, code, pre, iframe, svg').forEach((el) => el.remove());
  clone.querySelectorAll('nav, footer, header, aside').forEach((el) => el.remove());
  const text = clone.innerText || '';
  return text.replace(/\s+\n/g, '\n').trim();
}

function chunkText(text: string, maxWords = CHUNK_MAX_WORDS): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let buffer: string[] = [];
  for (const word of words) {
    buffer.push(word);
    if (buffer.length >= maxWords) {
      chunks.push(buffer.join(' '));
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    chunks.push(buffer.join(' '));
  }
  return chunks;
}

function sendPageToBackground({ force = false }: { force?: boolean } = {}): void {
  const proceed = (): void => {
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
    try {
      chrome.runtime.sendMessage(message, () => {});
    } catch (err) {
      console.warn('[beta-content] failed to send capture payload', err);
    }
  };

  if (force) {
    proceed();
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: 'SHOULD_CAPTURE', url: location.href }, (resp: { allow?: boolean } | undefined) => {
      if (resp && resp.allow === false) return;
      proceed();
    });
  } catch (err) {
    console.warn('[beta-content] capture eligibility failed, skipping', err);
  }
}

function scheduleAutoCapture(): () => void {
  let fired = false;
  let idleTimer: number | null = null;

  const triggerCapture = (): void => {
    if (fired) return;
    fired = true;
    observer.disconnect();
    if (idleTimer) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    sendPageToBackground();
  };

  const observer = new MutationObserver(() => {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(triggerCapture, AUTO_CAPTURE_IDLE_MS);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  idleTimer = window.setTimeout(triggerCapture, AUTO_CAPTURE_IDLE_MS);
  const maxTimer = window.setTimeout(triggerCapture, AUTO_CAPTURE_MAX_WAIT_MS);

  return () => {
    observer.disconnect();
    if (idleTimer) window.clearTimeout(idleTimer);
    window.clearTimeout(maxTimer);
  };
}

function watchNavigation(onNavigate: () => void): () => void {
  let lastUrl = location.href;
  const notifyIfChanged = (): void => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onNavigate();
  };

  const pollTimer = window.setInterval(notifyIfChanged, URL_CHECK_INTERVAL_MS);
  const popstateHandler = () => notifyIfChanged();
  const hashchangeHandler = () => notifyIfChanged();

  window.addEventListener('popstate', popstateHandler);
  window.addEventListener('hashchange', hashchangeHandler);

  const restore: Array<() => void> = [];
  try {
    const wrapHistory = <T extends 'pushState' | 'replaceState'>(method: T): void => {
      const original = history[method];
      history[method] = function (...args: Parameters<History[T]>) {
        const result = original.apply(history, args);
        notifyIfChanged();
        return result;
      } as History[T];
      restore.push(() => {
        history[method] = original;
      });
    };

    wrapHistory('pushState');
    wrapHistory('replaceState');
  } catch {
    // best effort; the interval fallback still covers navigation changes.
  }

  return () => {
    window.clearInterval(pollTimer);
    window.removeEventListener('popstate', popstateHandler);
    window.removeEventListener('hashchange', hashchangeHandler);
    restore.forEach((reset) => reset());
  };
}

function init(): void {
  if (!isTopFrame()) {
    return;
  }
  let cleanup: (() => void) | null = null;
  let stopWatchingNavigation: (() => void) | null = null;

  const startCaptureCycle = (): void => {
    if (cleanup) cleanup();
    cleanup = scheduleAutoCapture();
  };

  const start = (): void => {
    startCaptureCycle();
    if (!stopWatchingNavigation) {
      stopWatchingNavigation = watchNavigation(startCaptureCycle);
    }
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    window.addEventListener('load', start, { once: true });
  }
  chrome.runtime.onMessage.addListener((
    message: Record<string, unknown>,
    _sender: unknown,
    sendResponse: (response?: { ok?: boolean }) => void
  ) => {
    if (message?.type === 'FORCE_CAPTURE') {
      sendPageToBackground({ force: true });
      if (typeof sendResponse === 'function') {
        sendResponse({ ok: true });
      }
      return true;
    }
    return false;
  });
}

init();
