import { normalizeImportedPage } from '../../shared/db/records';
import { cancelCaptureJobs } from '../capture/index';
import { embeddingSpaceKey } from '../../shared/config/index';
import { getEmbeddingConfig } from '../embeddings/index';
import { storageManager, type PageRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';

export type ManagePageSummary = {
  url: string;
  title: string;
  timestamp: number;
  manual: boolean;
  hasEmbeddings: boolean;
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
    hasEmbeddings: Array.isArray(page.chunks) && page.chunks.length > 0 && page.chunks.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0 && chunk.embeddingKey === embeddingSpaceKey(getEmbeddingConfig())),
    embeddingStatus: page.chunks?.some((chunk) => chunk.embedding?.length && chunk.embeddingKey !== embeddingSpaceKey(getEmbeddingConfig())) ? 'Different or unknown model — use Re-embed' : '',
    chunkCount: Array.isArray(page.chunks) ? page.chunks.length : 0,
    lastEmbeddedAt: page.lastEmbeddedAt
  }));
}

export async function deleteManagePages(urls: string[]): Promise<number> {
  if (!Array.isArray(urls) || urls.length === 0) return 0;
  cancelCaptureJobs(urls);
  const deleted = await storageManager.deletePages(urls);
  if (deleted > 0) {
    await invalidateOffscreenIndex();
  }
  return deleted;
}

export async function exportManagePages(): Promise<PageRecord[]> {
  return storageManager.listAllPages();
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
    await storageManager.savePageRecord(record);
    imported += 1;
  }
  if (imported > 0) {
    await invalidateOffscreenIndex();
  }
  return { imported };
}
