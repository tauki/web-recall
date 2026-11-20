import { extractPage } from './extraction';

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

function isForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

async function sendPageToBackground({ force = false, isCurrent = () => true }: { force?: boolean; isCurrent?: () => boolean } = {}): Promise<boolean> {
  const url = location.href;
  if (!force) {
    if (!isForeground() || !isCurrent()) return false;
    const allow = await new Promise<boolean>((resolve) => {
      chrome.runtime.sendMessage({ type: 'SHOULD_CAPTURE', url }, (response: { allow?: boolean } | undefined) => {
        resolve(!chrome.runtime.lastError && response?.allow === true);
      });
    });
    if (!allow || !isForeground() || !isCurrent() || location.href !== url) return false;
  }
  const { text, captureInfo } = extractPage(document);
  if (!text) return false;
  await new Promise<void>((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'SAVE_PAGE', url, title: document.title || url, timestamp: Date.now(), chunks: chunkText(text), text, captureInfo, force, manual: force }, (response?: { status?: string; error?: string }) => {
      const error = chrome.runtime.lastError?.message || response?.error;
      if (error) reject(new Error(error));
      else if (response?.status === 'queued' || response?.status === 'saved') resolve();
      else reject(new Error('Capture was not confirmed. Try capturing the page again.'));
    });
  });
  return true;
}

function scheduleAutoCapture(): () => void {
  let stopped = false, attempted = false, generation = 0;
  let cycleUrl = location.href;
  let idleTimer: number | null = null;
  let maxTimer: number | null = null;

  const clearTimers = (): void => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    if (maxTimer !== null) window.clearTimeout(maxTimer);
    idleTimer = null; maxTimer = null;
  };
  const cleanup = (): void => {
    stopped = true; generation++; clearTimers(); observer.disconnect();
    document.removeEventListener('visibilitychange', foregroundChanged);
    window.removeEventListener('focus', foregroundChanged);
    window.removeEventListener('blur', foregroundChanged);
  };

  const triggerCapture = (): void => {
    if (stopped || attempted || !isForeground()) return;
    if (location.href !== cycleUrl) { foregroundChanged(); return; }
    attempted = true; clearTimers();
    const revision = generation;
    const retryLater = (): void => {
      if (stopped || revision !== generation) return;
      if (location.href !== cycleUrl) { foregroundChanged(); return; }
      attempted = false;
      maxTimer = window.setTimeout(triggerCapture, AUTO_CAPTURE_MAX_WAIT_MS);
    };
    void sendPageToBackground({ isCurrent: () => !stopped && revision === generation && location.href === cycleUrl }).then(saved => {
      if (stopped || revision !== generation) return;
      if (saved) cleanup();
      else retryLater();
    }).catch(error => { retryLater(); console.warn('[beta-content] automatic capture unavailable', error); });
  };

  const observer = new MutationObserver(() => {
    if (stopped || attempted || !isForeground()) return;
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(triggerCapture, AUTO_CAPTURE_IDLE_MS);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function foregroundChanged(): void {
    if (stopped) return;
    generation++; attempted = false; clearTimers();
    cycleUrl = location.href;
    if (!isForeground()) return;
    idleTimer = window.setTimeout(triggerCapture, AUTO_CAPTURE_IDLE_MS);
    maxTimer = window.setTimeout(triggerCapture, AUTO_CAPTURE_MAX_WAIT_MS);
  }
  document.addEventListener('visibilitychange', foregroundChanged);
  window.addEventListener('focus', foregroundChanged);
  window.addEventListener('blur', foregroundChanged);
  foregroundChanged();
  return cleanup;
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
    sendResponse: (response?: { ok?: boolean; error?: string }) => void
  ) => {
    if (message?.type === 'FORCE_CAPTURE') {
      void sendPageToBackground({ force: true }).then(saved => sendResponse(saved ? { ok: true } : { error: 'No readable page text was found.' }), error => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    return false;
  });
}

init();
