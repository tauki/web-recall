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

const MAX_IMPORT_PAGES = 2000;
const MAX_IMPORT_TEXT_CHARS = 500_000;
const MAX_IMPORT_TITLE_CHARS = 2048;
const MAX_IMPORT_SUMMARY_CHARS = 20_000;
const MAX_IMPORT_CHUNKS = 512;
const MAX_IMPORT_CHUNK_TEXT_CHARS = 20_000;
const MAX_IMPORT_EMBEDDING_DIM = 4096;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readBoundedString(
  value: unknown,
  fallback: string,
  field: string,
  maxLength: number
): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${field} exceeds the maximum length of ${maxLength} characters.`);
  }
  return trimmed;
}

function readTimestamp(value: unknown, fallback: number, field: string): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite positive number.`);
  }
  return Math.floor(value);
}

function normalizeImportedChunks(raw: unknown, pageIndex: number): PageChunkRecord[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_IMPORT_CHUNKS) {
    throw new Error(
      `Page ${pageIndex + 1} exceeds the maximum chunk count of ${MAX_IMPORT_CHUNKS}.`
    );
  }
  return raw.map((chunk, chunkIndex) => {
    if (!chunk || typeof chunk !== 'object') {
      throw new Error(`Page ${pageIndex + 1} chunk ${chunkIndex + 1} is invalid.`);
    }
    const text = readBoundedString(
      (chunk as { text?: unknown }).text,
      '',
      `Page ${pageIndex + 1} chunk ${chunkIndex + 1} text`,
      MAX_IMPORT_CHUNK_TEXT_CHARS
    );
    const embeddingRaw = (chunk as { embedding?: unknown }).embedding;
    if (!Array.isArray(embeddingRaw)) {
      return { text, embedding: [] };
    }
    if (embeddingRaw.length > MAX_IMPORT_EMBEDDING_DIM) {
      throw new Error(
        `Page ${pageIndex + 1} chunk ${chunkIndex + 1} embedding exceeds ${MAX_IMPORT_EMBEDDING_DIM} values.`
      );
    }
    const embedding = embeddingRaw.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `Page ${pageIndex + 1} chunk ${chunkIndex + 1} embedding contains a non-numeric value.`
        );
      }
      return value;
    });
    return { text, embedding };
  });
}

function normalizeImportedPage(raw: Record<string, unknown>, pageIndex: number): PageRecord {
  const now = Date.now();
  const url = readBoundedString(raw.url, '', `Page ${pageIndex + 1} url`, 4096);
  if (!url || !isHttpUrl(url)) {
    throw new Error(`Page ${pageIndex + 1} must use an http(s) URL.`);
  }
  const text = readBoundedString(raw.text, '', `Page ${pageIndex + 1} text`, MAX_IMPORT_TEXT_CHARS);
  const chunks = normalizeImportedChunks(raw.chunks, pageIndex);
  return {
    url,
    title: readBoundedString(raw.title, url, `Page ${pageIndex + 1} title`, MAX_IMPORT_TITLE_CHARS),
    text,
    timestamp: readTimestamp(raw.timestamp, now, `Page ${pageIndex + 1} timestamp`),
    manual: Boolean(raw.manual),
    chunks,
    createdAt: readTimestamp(raw.createdAt, now, `Page ${pageIndex + 1} createdAt`),
    updatedAt: now,
    lastEmbeddedAt:
      typeof raw.lastEmbeddedAt === 'number'
        ? readTimestamp(raw.lastEmbeddedAt, now, `Page ${pageIndex + 1} lastEmbeddedAt`)
        : undefined,
    summary:
      typeof raw.summary === 'string'
        ? readBoundedString(
            raw.summary,
            '',
            `Page ${pageIndex + 1} summary`,
            MAX_IMPORT_SUMMARY_CHARS
          )
        : undefined
  };
}

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
  let imported = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const raw = pages[index];
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Page ${index + 1} is not a valid object.`);
    }
    const record = normalizeImportedPage(raw, index);
    await storageManager.savePageRecord(record);
    imported += 1;
  }
  if (imported > 0) {
    await invalidateOffscreenIndex();
  }
  return { imported };
}
