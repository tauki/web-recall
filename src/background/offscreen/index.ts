import { readLibraryAuthority } from '../storage/libraryAuthorityState';
import { LIBRARY_PORT, requestLibraryFrames } from '../../shared/libraryTransfer';

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
        reasons: ['DOM_SCRAPING', 'WORKERS'],
        justification: 'Host local retrieval, inference, and saved library work outside the service worker'
      })
      .catch(async () => {
        await chrome.offscreen?.createDocument({
          url: OFFSCREEN_URL,
          reasons: ['DOM_PARSER', 'WORKERS'],
          justification: 'Host local retrieval, inference, and saved library work outside the service worker'
        });
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function sendOffscreenMessage<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const request = payload.type === 'OFFSCREEN_SAVED_LIBRARY' ? payload.request as { kind?: string; action?: string | { op?: string } } : undefined;
  const operation = typeof request?.action === 'object' ? request.action?.op : undefined;
  if ((request?.kind === 'operate' && ['pages', 'read', 'recentRecords', 'save', 'versions', 'delete', 'forget', 'search', 'searchPage', 'searchText'].includes(operation || '')) ||
      (request?.kind === 'recover' && request.action === 'write')) {
    return requestLibraryFrames<T>(chrome.runtime.connect({ name: LIBRARY_PORT }), request, signal);
  }
  if (payload.type === 'OFFSCREEN_TOP_PAGES' || payload.type === 'OFFSCREEN_SCORE_CHUNKS' || payload.type === 'OFFSCREEN_INVALIDATE_INDEX') {
    const authority = await readLibraryAuthority();
    if (authority?.phase !== 'active' || !authority.retired) throw new Error('Semantic search is waiting for saved library activation.');
    payload = { ...payload, libraryId: authority.id, libraryReplacement: authority.source === 'backup' };
  }
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
