import type { PageChunkRecord, PageRecord } from './index';
import { readCaptureInfo } from '../capture';

const IMPORT_LIMITS = {
  text: 500_000,
  title: 2048,
  summary: 20_000,
  chunks: 512,
  chunkText: 20_000,
  embeddingDimension: 4096,
  url: 4096
};
type RecordLimits = Partial<typeof IMPORT_LIMITS>;

function captureMetadata(raw: Record<string, unknown>): Partial<PageRecord> {
  if (raw.versionId !== undefined && (typeof raw.versionId !== 'string' || !raw.versionId || raw.versionId.length > 100)) throw new Error('Invalid saved version identity.');
  if (raw.kept !== undefined && typeof raw.kept !== 'boolean') throw new Error('Invalid saved version retention flag.');
  for (const key of ['firstCapturedAt', 'lastVisitedAt'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (raw[key] as number) < 0)) throw new Error(`Invalid saved capture time: ${key}.`);
  }
  return { versionId: raw.versionId as string | undefined, kept: raw.kept as boolean | undefined, firstCapturedAt: raw.firstCapturedAt as number | undefined, lastVisitedAt: raw.lastVisitedAt as number | undefined, captureInfo: readCaptureInfo(raw.captureInfo) };
}

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
  maxLength?: number
): string {
  const text = typeof value === 'string' ? value : fallback;
  const normalized = maxLength === undefined ? text : text.trim();
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new Error(`${field} exceeds the maximum length of ${maxLength} characters.`);
  }
  return normalized;
}

function readTimestamp(value: unknown, fallback: number, field: string): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite positive number.`);
  }
  return Math.floor(value);
}

function normalizeChunks(raw: unknown, pageIndex: number, limits: RecordLimits, preserve = false): PageChunkRecord[] {
  if (!Array.isArray(raw)) return [];
  if (limits.chunks !== undefined && raw.length > limits.chunks) {
    throw new Error(
      `Page ${pageIndex + 1} exceeds the maximum chunk count of ${limits.chunks}.`
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
      limits.chunkText
    );
    const embeddingRaw = (chunk as { embedding?: unknown }).embedding;
    if (!Array.isArray(embeddingRaw)) {
      return { ...(preserve ? chunk : {}), text, embedding: [] };
    }
    if (limits.embeddingDimension !== undefined && embeddingRaw.length > limits.embeddingDimension) {
      throw new Error(
        `Page ${pageIndex + 1} chunk ${chunkIndex + 1} embedding exceeds ${limits.embeddingDimension} values.`
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
    return { ...(preserve ? chunk : {}), text, embedding, embeddingKey: typeof key === 'string' ? key : undefined };
  });
}

export function normalizeImportedPage(raw: Record<string, unknown>, pageIndex: number): PageRecord {
  return normalizePage(raw, pageIndex, 'import');
}

export function normalizeImportedPages(payload: { schemaVersion?: number; pages?: unknown[] }): PageRecord[] {
  if (typeof payload?.schemaVersion === 'number' && payload.schemaVersion !== 1) throw new Error(`Unsupported import schema version: ${payload.schemaVersion}.`);
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  if (pages.length > 2000) throw new Error('Import exceeds the maximum page count of 2000.');
  return pages.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Page ${index + 1} is not a valid object.`);
    return normalizeImportedPage(raw as Record<string, unknown>, index);
  });
}

export function normalizeLegacyPage(raw: Record<string, unknown>, pageIndex: number): PageRecord {
  // Existing captures predate import limits and can be empty after inference
  // failures. Preserve their contents and history while validating structure.
  return normalizePage(raw, pageIndex, 'legacy');
}

export function normalizeBackupPage(raw: Record<string, unknown>): PageRecord {
  function validateFields(record: Record<string, unknown>): void {
    for (const field of ['url', 'title', 'text', 'summary']) {
      if (record[field] !== undefined && typeof record[field] !== 'string') throw new Error(`Invalid backup field: ${field} must be a string.`);
    }
    for (const field of ['timestamp', 'createdAt', 'updatedAt', 'lastEmbeddedAt']) {
      if (record[field] !== undefined && (typeof record[field] !== 'number' || !Number.isFinite(record[field]) || (record[field] as number) < 0)) throw new Error(`Invalid backup field: ${field} must be a finite non-negative number.`);
    }
    if (record.manual !== undefined && typeof record.manual !== 'boolean') throw new Error('Invalid backup field: manual must be a boolean.');
    for (const field of ['chunks', 'items']) {
      const chunks = record[field];
      if (chunks === undefined) continue;
      if (!Array.isArray(chunks)) throw new Error(`Invalid backup field: ${field} must be an array.`);
      for (const chunk of chunks) {
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error('Invalid backup chunk.');
        if (typeof chunk.text !== 'string') throw new Error('Invalid backup chunk text.');
        if (chunk.embedding !== undefined && !Array.isArray(chunk.embedding)) throw new Error('Invalid backup chunk embedding.');
        if (Array.isArray(chunk.embedding) && !chunk.embedding.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) throw new Error('Invalid backup chunk embedding: contains a non-numeric value.');
        if (chunk.embeddingKey !== undefined && typeof chunk.embeddingKey !== 'string') throw new Error('Invalid backup chunk embeddingKey.');
      }
    }
  }
  validateFields(raw);
  if (raw.versions !== undefined) {
    if (!Array.isArray(raw.versions)) throw new Error('Invalid backup versions: expected an array.');
    for (const version of raw.versions) {
      if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error('Invalid backup version.');
      validateFields(version as Record<string, unknown>);
    }
  }
  return normalizePage(raw, 0, 'backup');
}

function normalizePage(raw: Record<string, unknown>, pageIndex: number, source: 'import' | 'legacy' | 'backup'): PageRecord {
  const limits: RecordLimits = source === 'import' ? IMPORT_LIMITS : {};
  const now = Date.now();
  const timestamp = (value: unknown, fallback: number, field: string): number => source === 'backup' && typeof value === 'number' ? value : readTimestamp(value, fallback, field);
  const url = readBoundedString(raw.url, '', `Page ${pageIndex + 1} url`, limits.url);
  if (!url || !isHttpUrl(url)) {
    throw new Error(`Page ${pageIndex + 1} must use an http(s) URL.`);
  }
  const versions = Array.isArray(raw.versions) ? raw.versions.map((version) => {
    if (!version || typeof version !== 'object') throw new Error(`Page ${pageIndex + 1} has an invalid version.`);
    const value = version as Record<string, unknown>;
    const chunks = normalizeChunks(value.chunks ?? value.items, pageIndex, limits, source === 'backup');
    return {
      ...(source === 'backup' ? value : {}),
      ...captureMetadata(value),
      ...(source === 'backup' && value.captureInfo !== undefined ? { captureInfo: { ...(value.captureInfo as object), ...readCaptureInfo(value.captureInfo)! } } : {}),
      title: typeof value.title === 'string' ? readBoundedString(value.title, '', `Page ${pageIndex + 1} version title`, limits.title) : undefined,
      timestamp: timestamp(value.timestamp, now, `Page ${pageIndex + 1} version timestamp`),
      manual: typeof value.manual === 'boolean' ? value.manual : undefined,
      lastEmbeddedAt: typeof value.lastEmbeddedAt === 'number' ? timestamp(value.lastEmbeddedAt, now, `Page ${pageIndex + 1} version embedding time`) : undefined,
      text: readBoundedString(value.text, chunks.map(chunk => chunk.text).join('\n\n'), `Page ${pageIndex + 1} version text`, limits.text),
      chunks,
      summary: source === 'backup' && value.summary === undefined ? undefined : readBoundedString(value.summary, '', `Page ${pageIndex + 1} version summary`, limits.summary)
    };
  }) : undefined;
  const identities = [raw.versionId, ...(versions || []).map(version => version.versionId)].filter((identity): identity is string => typeof identity === 'string');
  if (new Set(identities).size !== identities.length) throw new Error('Saved version identities must be unique within a page.');
  const latest = source === 'backup' ? undefined : (versions?.[typeof raw.latestVersionIndex === 'number' ? raw.latestVersionIndex : -1]
    ?? versions?.reduce((a, b) => b.timestamp >= a.timestamp ? b : a, versions[0]!));
  const inferred = !(typeof raw.text === 'string' && raw.text.length) && raw.chunks === undefined && raw.items === undefined ? latest : undefined;
  const chunks = normalizeChunks(raw.chunks ?? raw.items ?? inferred?.chunks, pageIndex, limits, source === 'backup');
  const text = readBoundedString(raw.text, chunks.map(chunk => chunk.text).join('\n\n') || inferred?.text || '', `Page ${pageIndex + 1} text`, limits.text);
  if (source === 'import' && !text && !chunks.some(chunk => chunk.text)) {
    throw new Error(`Page ${pageIndex + 1} has no supported captured content (text, chunks, or legacy items).`);
  }
  return {
    ...(source === 'backup' ? raw : {}),
    ...captureMetadata(raw),
    ...(source === 'backup' && raw.captureInfo !== undefined ? { captureInfo: { ...(raw.captureInfo as object), ...readCaptureInfo(raw.captureInfo)! } } : {}),
    url,
    title: readBoundedString(raw.title, inferred?.title || url, `Page ${pageIndex + 1} title`, limits.title),
    text,
    timestamp: timestamp(raw.timestamp, inferred?.timestamp ?? now, `Page ${pageIndex + 1} timestamp`),
    manual: Boolean(raw.manual),
    chunks,
    versions,
    createdAt: timestamp(raw.createdAt, now, `Page ${pageIndex + 1} createdAt`),
    updatedAt: now,
    lastEmbeddedAt:
      typeof raw.lastEmbeddedAt === 'number'
        ? timestamp(raw.lastEmbeddedAt, now, `Page ${pageIndex + 1} lastEmbeddedAt`)
        : undefined,
    summary:
      typeof raw.summary === 'string'
        ? readBoundedString(
            raw.summary,
            '',
            `Page ${pageIndex + 1} summary`,
            limits.summary
          )
        : inferred && (!inferred.title || typeof raw.title !== 'string' || inferred.title === raw.title) ? inferred.summary : undefined
  };
}

