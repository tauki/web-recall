import { normalizeImportedPage } from '../../shared/db/records';
import { encodeBackupPage, decodeBackupPage } from '../../shared/backup';
import { cancelCaptureJobs } from '../capture/index';
import { embeddingSpaceKey } from '../../shared/config/index';
import { getEmbeddingConfig } from '../embeddings/index';
import { storageManager, type PageRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';
import { invalidateRecentPages } from './recents';

export type ManagePageSummary = {
  url: string;
  title: string;
  timestamp: number;
  manual: boolean;
  hasEmbeddings: boolean;
  hasSummary: boolean;
  embeddingStatus: string;
  chunkCount: number;
  lastEmbeddedAt?: number;
};

type ImportPayload = {
  schemaVersion?: number;
  pages: Array<Record<string, unknown>>;
};

const MAX_IMPORT_PAGES = 2000;

export async function getManagePages(): Promise<ManagePageSummary[]> {
  const pages = await storageManager.listAllPages();
  return pages.sort((a, b) => b.timestamp - a.timestamp).map((page) => ({
    url: page.url,
    title: page.title || page.url,
    timestamp: page.timestamp,
    manual: Boolean(page.manual),
    hasSummary: Boolean(page.summary?.trim()),
    hasEmbeddings: Array.isArray(page.chunks) && page.chunks.length > 0 && page.chunks.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0 && chunk.embeddingKey === embeddingSpaceKey(getEmbeddingConfig())),
    embeddingStatus: page.chunks?.some((chunk) => chunk.embedding?.length && chunk.embeddingKey !== embeddingSpaceKey(getEmbeddingConfig())) ? 'Different or unknown model — use Re-embed' : '',
    chunkCount: Array.isArray(page.chunks) ? page.chunks.length : 0,
    lastEmbeddedAt: page.lastEmbeddedAt
  }));
}

export async function deleteManagePages(urls: string[]): Promise<number> {
  if (!Array.isArray(urls) || urls.length === 0) return 0;
  await cancelCaptureJobs(urls);
  const deleted = await storageManager.deletePages(urls);
  if (deleted > 0) {
    await invalidateRecentPages();
    await invalidateOffscreenIndex();
  }
  return deleted;
}

export async function exportManagePages(): Promise<PageRecord[]> {
  return storageManager.listAllPages();
}

export async function exportBackupPage(afterUrl?: string): Promise<{ line?: string; url?: string }> {
  const page = await storageManager.getNextPageRecord(afterUrl);
  return page ? { line: encodeBackupPage(page), url: page.url } : {};
}

export async function importBackupPage(line: string): Promise<{ imported: number }> {
  await restorePage(decodeBackupPage(line));
  await invalidateOffscreenIndex();
  return { imported: 1 };
}

async function restorePage(record: PageRecord): Promise<void> {
  await cancelCaptureJobs([record.url]);
  await storageManager.savePageRecord(record, { discardProcessing: true, replace: true });
  await invalidateRecentPages();
}

export async function importManagePages(payload: ImportPayload): Promise<{ imported: number }> {
  if (
    typeof payload?.schemaVersion === 'number' &&
    payload.schemaVersion !== 1
  ) {
    throw new Error(`Unsupported import schema version: ${payload.schemaVersion}.`);
  }
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (pages.length > MAX_IMPORT_PAGES) {
    throw new Error(`Import exceeds the maximum page count of ${MAX_IMPORT_PAGES}.`);
  }
  const records = pages.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Page ${index + 1} is not a valid object.`);
    }
    return normalizeImportedPage(raw, index);
  });
  let imported = 0;
  for (const record of records) {
    await restorePage(record);
    imported += 1;
  }
  if (imported > 0) {
    await invalidateOffscreenIndex();
  }
  return { imported };
}

/** Read only a short saved passage for the inline preview; vectors stay in storage. */
export async function getPagePreview(url: string): Promise<{ url: string; title: string; snippet: string; timestamp: number; previewKind: 'summary' | 'excerpt' } | null> {
  const page = await storageManager.getPageRecord(url);
  if (!page) return null;
  const text = page.summary?.trim() || page.text || page.chunks?.map(chunk => chunk.text).join('\n') || '';
  const prefix = text.slice(0, text.length > 1200 ? 1199 : 1200);
  const boundary = prefix.search(/\s+\S*$/);
  const snippet = text.length > 1200 ? `${prefix.slice(0, boundary > 0 ? boundary : prefix.length).trimEnd()}…` : text;
  return { url: page.url, title: page.title || page.url, snippet, timestamp: page.timestamp, previewKind: page.summary?.trim() ? 'summary' : 'excerpt' };
}
