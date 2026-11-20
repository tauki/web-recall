import { normalizeImportedPages } from '../../shared/db/records';
import { encodeBackupPage, decodeBackupPage } from '../../shared/backup';
import { cancelCaptureJobs } from '../capture/index';
import { embeddingSpaceKey } from '../../shared/config/index';
import { getEmbeddingConfig } from '../embeddings/index';
import { storageManager, type PageRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';
import { invalidateRecentPages } from './recents';
import { matchesSearchFilters, readSearchFilters, type SearchFilters } from '../../shared/searchFilters';
import { markFailed } from '../processing/index';
import type { CaptureInfo } from '../../shared/capture';
import { getSavedVersion } from './reader';
import { readVersionSelection, type SavedVersionSelection, type ForgetResult } from '../../shared/pageHistory';
import { cancelSavedWork } from '../processing/savedWork';
import { restorePage } from './restore';

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
  firstCapturedAt?: number;
  lastVisitedAt?: number;
  versionCount: number;
  captureInfo?: CaptureInfo;
};

type ImportPayload = {
  schemaVersion?: number;
  pages: Array<Record<string, unknown>>;
};

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
    lastEmbeddedAt: page.lastEmbeddedAt,
    firstCapturedAt: page.firstCapturedAt ?? page.timestamp,
    lastVisitedAt: page.lastVisitedAt,
    versionCount: 1 + (page.versions?.length || 0),
    captureInfo: page.captureInfo
  }));
}

export async function deleteManagePages(urls: string[], filters?: SearchFilters): Promise<number> {
  if (!Array.isArray(urls) || urls.length === 0) return 0;
  const stopped = await cancelCaptureJobs(urls, filters);
  let result: Awaited<ReturnType<typeof storageManager.deletePages>>;
  try { result = await storageManager.deletePages(urls, filters); }
  catch (error) {
    await Promise.all(stopped.map(item => markFailed(item.payload, item.attempts, 'Indexing stopped after the page could not be forgotten. Saved text was retained.').catch(failure => console.warn('[beta-manage] unable to record stopped indexing', failure))));
    throw error;
  }
  cancelSavedWork(result.removedVersions);
  if (result.deleted > 0) {
    await invalidateRecentPages();
    await invalidateOffscreenIndex();
  }
  return result.deleted;
}

function readForgetScope(value: unknown): SearchFilters {
  const filters = readSearchFilters(value);
  if (!Object.keys(filters).length) throw new Error('Choose a site or capture date before forgetting pages.');
  return filters;
}

export async function previewForgetPages(value: unknown): Promise<{ selection: SavedVersionSelection[]; versionCount: number }> {
  const filters = readForgetScope(value);
  const pages = await storageManager.listAllPages();
  const selection: SavedVersionSelection[] = [];
  for (const page of pages) {
    if (![page, ...(page.versions || [])].some(version => matchesSearchFilters({ url: page.url, timestamp: version.timestamp }, filters))) continue;
    const versions = await storageManager.listPageVersions(page.url);
    const versionIds = versions.filter(version => matchesSearchFilters({ url: page.url, timestamp: version.timestamp }, filters)).map(version => version.versionId!);
    if (versionIds.length) selection.push({ url: page.url, versionIds });
  }
  return { selection, versionCount: selection.reduce((count, page) => count + page.versionIds.length, 0) };
}

export async function forgetManagePages(rawSelection: unknown, value: unknown): Promise<ForgetResult> {
  const filters = readForgetScope(value);
  const selection = readVersionSelection(rawSelection);
  const result = await storageManager.forgetPageVersions(selection, filters);
  cancelSavedWork(result.removedVersions);
  const captureIds = new Map(result.captureJobs.map(job => [job.url, job.captureId]));
  if (captureIds.size) await cancelCaptureJobs([...captureIds.keys()], undefined, captureIds);
  if (result.versions) { await invalidateRecentPages(); await invalidateOffscreenIndex(); }
  return { pages: result.pages, versions: result.versions };
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

export async function importManagePages(payload: ImportPayload): Promise<{ imported: number }> {
  const records = normalizeImportedPages(payload);
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
export async function getPagePreview(url: string, timestamp?: number, versionId?: string): Promise<{ url: string; title: string; snippet: string; timestamp: number; previewKind: 'summary' | 'excerpt'; versionId?: string; captureInfo?: CaptureInfo } | null> {
  const saved = await getSavedVersion(url, timestamp, versionId);
  if (!saved) return null;
  const page = saved.version;
  const text = page.summary?.trim() || page.text || page.chunks?.map(chunk => chunk.text).join('\n') || '';
  const prefix = text.slice(0, text.length > 1200 ? 1199 : 1200);
  const boundary = prefix.search(/\s+\S*$/);
  const snippet = text.length > 1200 ? `${prefix.slice(0, boundary > 0 ? boundary : prefix.length).trimEnd()}…` : text;
  return { url: saved.record.url, title: page.title || saved.record.url, snippet, timestamp: page.timestamp, previewKind: page.summary?.trim() ? 'summary' : 'excerpt', versionId: page.versionId, captureInfo: page.captureInfo };
}
