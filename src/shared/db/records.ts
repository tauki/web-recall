import type { PageChunkRecord, PageRecord } from './index';

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

function normalizeChunks(raw: unknown, pageIndex: number, limits: RecordLimits): PageChunkRecord[] {
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
      return { text, embedding: [] };
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
    return { text, embedding, embeddingKey: typeof key === 'string' ? key : undefined };
  });
}

export function normalizeImportedPage(raw: Record<string, unknown>, pageIndex: number): PageRecord {
  return normalizePage(raw, pageIndex, 'import');
}

export function normalizeLegacyPage(raw: Record<string, unknown>, pageIndex: number): PageRecord {
  // Existing captures predate import limits and can be empty after inference
  // failures. Preserve their contents and history while validating structure.
  return normalizePage(raw, pageIndex, 'legacy');
}

function normalizePage(raw: Record<string, unknown>, pageIndex: number, source: 'import' | 'legacy'): PageRecord {
  const limits: RecordLimits = source === 'import' ? IMPORT_LIMITS : {};
  const now = Date.now();
  const url = readBoundedString(raw.url, '', `Page ${pageIndex + 1} url`, limits.url);
  if (!url || !isHttpUrl(url)) {
    throw new Error(`Page ${pageIndex + 1} must use an http(s) URL.`);
  }
  const versions = Array.isArray(raw.versions) ? raw.versions.map((version) => {
    if (!version || typeof version !== 'object') throw new Error(`Page ${pageIndex + 1} has an invalid version.`);
    const value = version as Record<string, unknown>;
    const chunks = normalizeChunks(value.chunks ?? value.items, pageIndex, limits);
    return {
      timestamp: readTimestamp(value.timestamp, now, `Page ${pageIndex + 1} version timestamp`),
      text: readBoundedString(value.text, chunks.map(chunk => chunk.text).join('\n\n'), `Page ${pageIndex + 1} version text`, limits.text),
      chunks,
      summary: readBoundedString(value.summary, '', `Page ${pageIndex + 1} version summary`, limits.summary)
    };
  }) : undefined;
  const latest = versions?.[typeof raw.latestVersionIndex === 'number' ? raw.latestVersionIndex : -1]
    ?? versions?.reduce((a, b) => b.timestamp >= a.timestamp ? b : a, versions[0]!);
  const chunks = normalizeChunks(raw.chunks ?? raw.items ?? latest?.chunks, pageIndex, limits);
  const text = readBoundedString(raw.text, chunks.map(chunk => chunk.text).join('\n\n') || latest?.text || '', `Page ${pageIndex + 1} text`, limits.text);
  if (source === 'import' && !text && !chunks.some(chunk => chunk.text)) {
    throw new Error(`Page ${pageIndex + 1} has no supported captured content (text, chunks, or legacy items).`);
  }
  return {
    url,
    title: readBoundedString(raw.title, url, `Page ${pageIndex + 1} title`, limits.title),
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
            limits.summary
          )
        : latest?.summary
  };
}

