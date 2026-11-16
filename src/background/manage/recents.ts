import { storageManager } from '../storage/manager';
import { RECENT_PAGE_LIMIT, RECENTS_CACHE_KEY, readRecentCursor, readRecentPages, type RecentPageBatch } from '../../shared/recents';

let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

export function getRecentPages(after?: unknown): Promise<RecentPageBatch> {
  return serialize(async () => {
    const cursor = after === undefined ? undefined : readRecentCursor(after);
    if (after !== undefined && !cursor) throw new Error('Invalid recent-pages cursor');
    const batch = await storageManager.listRecentPageSummaries(RECENT_PAGE_LIMIT, cursor);
    const pages = readRecentPages(batch.pages);
    if (!pages) throw new Error('Invalid recent-pages metadata');
    try {
      if (!cursor && typeof chrome !== 'undefined') await chrome.storage?.session?.set({ [RECENTS_CACHE_KEY]: pages });
    } catch (error) { console.warn('[beta-background] unable to cache recents', error); }
    return { pages, nextCursor: readRecentCursor(batch.nextCursor) || null };
  });
}

export function invalidateRecentPages(): Promise<void> {
  return serialize(async () => {
    try {
      if (typeof chrome !== 'undefined') await chrome.storage?.session?.remove(RECENTS_CACHE_KEY);
    } catch (error) { console.warn('[beta-background] unable to invalidate recents', error); }
  });
}
