const OFFSCREEN_URL = chrome.runtime.getURL('dist/beta/offscreen/index.html');
let creating: Promise<void> | null = null;

async function hasDocument(): Promise<boolean> {
  try {
    const exists = await (chrome.offscreen as unknown as { hasDocument?: () => Promise<boolean> })?.hasDocument?.();
    return Boolean(exists);
  } catch {
    return false;
  }
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (!chrome.offscreen) return;
  if (await hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_SCRAPING'],
        justification: 'Run ANN retrieval and scoring using IndexedDB without blocking the service worker'
      })
      .catch(async () => {
        await chrome.offscreen?.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['DOM_PARSER'],
          justification: 'Run ANN retrieval and scoring using IndexedDB without blocking the service worker'
        });
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export function sendOffscreenMessage<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response: T & { error?: string }) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (response && (response as { error?: string }).error) {
        reject(new Error((response as { error?: string }).error || 'offscreen error'));
        return;
      }
      resolve((response || {}) as T);
    });
  });
}

export async function invalidateOffscreenIndex(): Promise<void> {
  try {
    await ensureOffscreenDocument();
    await sendOffscreenMessage<{ ok?: boolean }>({ type: 'OFFSCREEN_INVALIDATE_INDEX' });
  } catch (err) {
    console.warn('[beta-offscreen] failed to invalidate index', err);
  }
}
