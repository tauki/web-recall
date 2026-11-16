export const RECENT_PAGE_LIMIT = 20;
export const RECENTS_CACHE_KEY = 'sidepanelRecentPages';

export type RecentPage = { url: string; title: string; timestamp: number };
export type RecentCursor = { timestamp: number; url: string; title: string };
export type RecentPageBatch = { pages: RecentPage[]; nextCursor: RecentCursor | null };

export function readRecentCursor(value: unknown): RecentCursor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.timestamp === 'number' && Number.isFinite(cursor.timestamp) && typeof cursor.url === 'string' && !!cursor.url && typeof cursor.title === 'string'
    ? { timestamp: cursor.timestamp, url: cursor.url, title: cursor.title } : undefined;
}

export function readRecentPages(value: unknown): RecentPage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages: RecentPage[] = [];
  for (const entry of value.slice(0, RECENT_PAGE_LIMIT)) {
    if (!entry || typeof entry.url !== 'string' || !entry.url || typeof entry.title !== 'string' || !Number.isFinite(entry.timestamp)) return undefined;
    pages.push({ url: entry.url, title: entry.title, timestamp: entry.timestamp });
  }
  return pages;
}
