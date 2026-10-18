import type { PageChunkRecord, PageRecord } from './index';

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
  const trimmed = (typeof value === 'string' ? value : fallback).trim();
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
    const key = (chunk as { embeddingKey?: unknown }).embeddingKey;
    return { text, embedding, embeddingKey: typeof key === 'string' ? key : undefined };
  });
}

export function normalizeImportedPage(raw: Record<string, unknown>, pageIndex: number): PageRecord {
  return normalizePage(raw, pageIndex, false);
}

export function normalizeLegacyPage(raw: Record<string, unknown>, pageIndex: number): PageRecord {
  // 0.1.0 persisted empty items when embedding failed. Keep those captures and
  // their history during upgrades; external imports still require content.
  return normalizePage(raw, pageIndex, true);
}

function normalizePage(raw: Record<string, unknown>, pageIndex: number, allowEmpty: boolean): PageRecord {
  const now = Date.now();
  const url = readBoundedString(raw.url, '', `Page ${pageIndex + 1} url`, 4096);
  if (!url || !isHttpUrl(url)) {
    throw new Error(`Page ${pageIndex + 1} must use an http(s) URL.`);
  }
  const versions = Array.isArray(raw.versions) ? raw.versions.map((version) => {
    if (!version || typeof version !== 'object') throw new Error(`Page ${pageIndex + 1} has an invalid version.`);
    const value = version as Record<string, unknown>;
    const chunks = normalizeImportedChunks(value.chunks ?? value.items, pageIndex);
    return {
      timestamp: readTimestamp(value.timestamp, now, `Page ${pageIndex + 1} version timestamp`),
      text: readBoundedString(value.text, chunks.map(chunk => chunk.text).join('\n\n'), `Page ${pageIndex + 1} version text`, MAX_IMPORT_TEXT_CHARS),
      chunks,
      summary: readBoundedString(value.summary, '', `Page ${pageIndex + 1} version summary`, MAX_IMPORT_SUMMARY_CHARS)
    };
  }) : undefined;
  const latest = versions?.[typeof raw.latestVersionIndex === 'number' ? raw.latestVersionIndex : -1]
    ?? versions?.reduce((a, b) => b.timestamp >= a.timestamp ? b : a, versions[0]!);
  const chunks = normalizeImportedChunks(raw.chunks ?? raw.items ?? latest?.chunks, pageIndex);
  const text = readBoundedString(raw.text, chunks.map(chunk => chunk.text).join('\n\n') || latest?.text || '', `Page ${pageIndex + 1} text`, MAX_IMPORT_TEXT_CHARS);
  if (!allowEmpty && !text && !chunks.some(chunk => chunk.text)) {
    throw new Error(`Page ${pageIndex + 1} has no supported captured content (text, chunks, or legacy items).`);
  }
  return {
    url,
    title: readBoundedString(raw.title, url, `Page ${pageIndex + 1} title`, MAX_IMPORT_TITLE_CHARS),
    text,
    timestamp: readTimestamp(raw.timestamp, latest?.timestamp ?? now, `Page ${pageIndex + 1} timestamp`),
    manual: Boolean(raw.manual),
    chunks,
    versions,
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
        : latest?.summary
  };
}

