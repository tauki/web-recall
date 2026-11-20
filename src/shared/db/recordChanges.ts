import type { PageChunkRecord, PageRecord, ProcessingEntry, StoredCapturePayload } from './index';
import { pageContent } from '../pageContent';
import { captureWithHistory, versionSnapshot, versionSource, type SavedVersionSelection } from '../pageHistory';
import { matchesSearchFilters, type SearchFilters } from '../searchFilters';

export type PageWrite = Omit<PageRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<PageRecord, 'createdAt' | 'updatedAt'>>;

export type PageWriteOptions = {
  expectedUpdatedAt?: number;
  requireProcessing?: boolean;
  expectedCaptureId?: string | null;
  captureEntry?: ProcessingEntry;
  reconcileFailedProcessing?: { captureId: string; updatedAt: number };
  preserveMissingEmbeddings?: boolean;
  discardProcessing?: boolean;
  replace?: boolean;
};

export function nextPageRecord(record: PageWrite, current: PageRecord | undefined, options: PageWriteOptions, now: number): PageRecord {
  const existing = options.replace ? undefined : current;
  const chunks = Array.isArray(record.chunks) ? record.chunks : [];
  const hasEmbeddings = chunks.some(chunk => Array.isArray(chunk.embedding) && chunk.embedding.length > 0);
  const normalized: PageRecord = {
    ...record,
    title: options.replace ? record.title : record.title || record.url,
    text: record.text || '',
    timestamp: options.replace ? record.timestamp : Number.isFinite(record.timestamp) ? record.timestamp : now,
    manual: Boolean(record.manual),
    chunks,
    createdAt: existing?.createdAt ?? record.createdAt ?? now,
    updatedAt: Math.max(now, (current?.updatedAt ?? -1) + 1),
    lastEmbeddedAt: options.replace ? record.lastEmbeddedAt : record.lastEmbeddedAt ?? existing?.lastEmbeddedAt ?? (hasEmbeddings ? now : undefined),
    versions: existing ? existing.versions : record.versions,
    versionId: existing ? existing.versionId : record.versionId,
    firstCapturedAt: existing ? existing.firstCapturedAt : record.firstCapturedAt,
    lastVisitedAt: existing ? existing.lastVisitedAt : record.lastVisitedAt,
    kept: existing ? existing.kept : record.kept,
    captureInfo: record.captureInfo ?? existing?.captureInfo
  };
  if (options.captureEntry) Object.assign(normalized, captureWithHistory(normalized, current));
  const sameContent = current && current.title === normalized.title && pageContent(current) === pageContent(normalized);
  if (options.replace) normalized.summary = record.summary;
  else if (sameContent) normalized.summary = options.expectedUpdatedAt !== undefined ? current?.summary : record.summary?.trim() ? record.summary : current?.summary;
  else normalized.summary = record.summary !== current?.summary ? record.summary : undefined;
  if (options.preserveMissingEmbeddings) {
    const savedChunks = new Map<string, PageChunkRecord>();
    for (const chunk of current?.chunks || []) {
      if (chunk.embedding?.length && chunk.embedding.every(Number.isFinite)) savedChunks.set(chunk.text, chunk);
    }
    normalized.chunks = chunks.map(chunk => chunk.embedding?.length ? chunk : savedChunks.get(chunk.text) || chunk);
    normalized.lastEmbeddedAt = record.lastEmbeddedAt ?? current?.lastEmbeddedAt;
  }
  return normalized;
}

function sameChunks(payload: StoredCapturePayload, page: { chunks: PageChunkRecord[] }): boolean {
  return payload.chunks.length === page.chunks.length && payload.chunks.every((text, index) => text === page.chunks[index]?.text);
}

export function matchesReconciledJob(page: PageRecord, job: ProcessingEntry | undefined, expected: NonNullable<PageWriteOptions['reconcileFailedProcessing']>): boolean {
  const payload = job?.payload;
  return Boolean(payload && job.status === 'failed' && job.textSaved && payload.captureId === expected.captureId && job.updatedAt === expected.updatedAt &&
    payload.url === page.url && payload.timestamp === page.timestamp && (payload.text || payload.chunks.join('\n')) === pageContent(page) && sameChunks(payload, page));
}

export function nextProcessingEntry(entry: ProcessingEntry, existing: ProcessingEntry | undefined, create: boolean): ProcessingEntry | undefined {
  if (!create && (!existing || (existing.payload?.captureId ?? null) !== (entry.payload?.captureId ?? null))) return undefined;
  return { ...entry, updatedAt: Math.max(entry.updatedAt, (existing?.updatedAt ?? -1) + 1), textSaved: existing?.textSaved ?? entry.textSaved, createdAt: existing?.createdAt ?? entry.createdAt, payload: entry.payload ?? existing?.payload };
}

export function versionEdit(page: PageRecord | undefined, versionId: string, action: 'keep' | 'release' | 'delete') {
  const current = page?.versionId === versionId;
  const version = current ? page : page?.versions?.find(entry => entry.versionId === versionId);
  if (!page || !version) throw new Error('This saved version is no longer available. Refresh the history.');
  if (action === 'delete' && current) throw new Error('Use Delete page to remove the current saved version.');
  if (action === 'delete') return { page: { ...page, versions: page.versions?.filter(entry => entry.versionId !== versionId) }, removed: [versionSource(page.url, version)] };
  const kept = action === 'keep';
  return { page: current ? { ...page, kept } : { ...page, versions: page.versions?.map(entry => entry === version ? { ...entry, kept } : entry) }, removed: [] };
}

export function forgetVersions(page: PageRecord, selection: SavedVersionSelection, filters: SearchFilters, now: number) {
  const identities = new Set(selection.versionIds);
  const versions = [versionSnapshot(page), ...(page.versions || [])];
  const removed = versions.filter(version => version.versionId && identities.has(version.versionId) && matchesSearchFilters({ url: page.url, timestamp: version.timestamp }, filters));
  if (!removed.length) return null;
  const removedIds = new Set(removed.map(version => version.versionId));
  const remaining = versions.filter(version => !removedIds.has(version.versionId));
  const removingCurrent = removedIds.has(page.versionId);
  let next: PageRecord | null = null;
  if (remaining.length) {
    if (removingCurrent) {
      remaining.sort((first, second) => second.timestamp - first.timestamp);
      const promoted = remaining.shift()!;
      next = { ...page, ...promoted, title: promoted.title || page.url, text: promoted.text, summary: promoted.summary, firstCapturedAt: promoted.firstCapturedAt ?? promoted.timestamp, kept: promoted.kept ?? true, manual: promoted.manual ?? false, lastEmbeddedAt: promoted.lastEmbeddedAt, lastVisitedAt: promoted.lastVisitedAt, captureInfo: promoted.captureInfo, versions: remaining, updatedAt: Math.max(now, page.updatedAt + 1) };
    } else next = { ...page, versions: remaining.slice(1) };
  }
  return {
    page: next, removed: removed.map(version => versionSource(page.url, version)),
    removesJob(job: ProcessingEntry | undefined): boolean {
      const payload = job?.payload;
      return Boolean(payload && (removingCurrent || removed.some(version => payload.title === (version.title || page.url) &&
        payload.timestamp >= (version.firstCapturedAt ?? version.timestamp) && payload.timestamp <= version.timestamp &&
        (payload.text ? payload.text === pageContent(version) : sameChunks(payload, version)))));
    }
  };
}

export function updatedSummary(page: PageRecord | undefined, text: string, summary: string, expected?: string, title?: string, versionId?: string | null): PageRecord | undefined {
  if (!page || (versionId !== undefined && (page.versionId ?? null) !== versionId) || (title !== undefined && page.title !== title) ||
      pageContent(page) !== text || (expected === undefined ? Boolean(page.summary?.trim()) : page.summary !== expected)) return undefined;
  return { ...page, summary };
}
