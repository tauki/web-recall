import { storageManager, type PageChunkRecord, type PageRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';

export type ManagePageSummary = {
  url: string;
  title: string;
  timestamp: number;
  manual: boolean;
  hasEmbeddings: boolean;
  chunkCount: number;
  lastEmbeddedAt?: number;
};

type ImportPayload = {
  schemaVersion?: number;
  pages: Array<Record<string, unknown>>;
};

export async function getManagePages(): Promise<ManagePageSummary[]> {
  const pages = await storageManager.listRecentPages(500);
  return pages.map((page) => ({
    url: page.url,
    title: page.title || page.url,
    timestamp: page.timestamp,
    manual: Boolean(page.manual),
    hasEmbeddings: Array.isArray(page.chunks) && page.chunks.length > 0 && page.chunks.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0),
    chunkCount: Array.isArray(page.chunks) ? page.chunks.length : 0,
    lastEmbeddedAt: page.lastEmbeddedAt
  }));
}

export async function deleteManagePages(urls: string[]): Promise<number> {
  if (!Array.isArray(urls) || urls.length === 0) return 0;
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
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  let imported = 0;
  for (const raw of pages) {
    const url = typeof raw?.url === 'string' ? raw.url : '';
    if (!url) continue;
    const record: PageRecord = {
      url,
      title: typeof raw.title === 'string' ? raw.title : url,
      text: typeof raw.text === 'string' ? raw.text : '',
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
      manual: Boolean(raw.manual),
      chunks: Array.isArray(raw.chunks) ? (raw.chunks as PageChunkRecord[]) : [],
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: Date.now(),
      lastEmbeddedAt: typeof raw.lastEmbeddedAt === 'number' ? raw.lastEmbeddedAt : undefined,
      summary: typeof raw.summary === 'string' ? raw.summary : undefined
    };
    await storageManager.savePageRecord(record);
    imported += 1;
  }
  if (imported > 0) {
    await invalidateOffscreenIndex();
  }
  return { imported };
}
