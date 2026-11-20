import type {
  PageRecord,
  appendProcessing,
  updateProcessingEntry,
  deletePages,
  FailedProcessingTarget,
  forgetPageVersions,
  getPageRecord,
  getNextPageRecord,
  getProcessingEntry,
  listPageVersions,
  updateSavedVersion,
  listAllPages,
  scanSearchPages,
  listLogs,
  listProcessing,
  ProcessingSummary,
  listRecentPages,
  listRecentPageSummaries,
  savePageRecord,
  savePageSummary
} from '../../shared/db/index';
import { listLogs as readLogs, clearLogs as removeLogs } from '../../shared/db/index';
import { whenStorageReady } from './index';
import type { TextSearchReply, TextSearchScope } from '../../shared/db/lexicalSearch';
import type { SearchFilters } from '../../shared/searchFilters';

export type {
  LogRecord,
  PageChunkRecord,
  PageRecord,
  ProcessingEntry
} from '../../shared/db/index';

export type StorageBackend = {
  listAllPages: typeof listAllPages;
  scanSearchPages: typeof scanSearchPages;
  searchTextPages: (query: string, limit: number, filters: SearchFilters, options?: TextSearchScope) => Promise<TextSearchReply>;
  listRecentPages: (limit?: number) => ReturnType<typeof listRecentPages>;
  listRecentPageSummaries: typeof listRecentPageSummaries;
  getPageRecord: (url: string) => ReturnType<typeof getPageRecord>;
  getNextPageRecord: typeof getNextPageRecord;
  getBackupBatch: (after?: string, signal?: AbortSignal) => Promise<{ libraryId: string; revision: number; page?: PageRecord }>;
  listPageVersions: typeof listPageVersions;
  updateSavedVersion: typeof updateSavedVersion;
  savePageRecord: typeof savePageRecord;
  savePageSummary: typeof savePageSummary;
  deletePages: typeof deletePages;
  forgetPageVersions: typeof forgetPageVersions;
  listLogs: (limit?: number) => ReturnType<typeof listLogs>;
  clearLogs: () => Promise<void>;
  listProcessing: () => ReturnType<typeof listProcessing>;
  listProcessingSummaries: () => Promise<ProcessingSummary[]>;
  listFailedProcessingTargets: () => Promise<FailedProcessingTarget[]>;
  appendProcessing: (entry: Parameters<typeof appendProcessing>[0]) => Promise<void>;
  updateProcessingEntry: typeof updateProcessingEntry;
  deleteProcessing: (url: string) => Promise<void>;
  getProcessingEntry: (url: string) => ReturnType<typeof getProcessingEntry>;
};

function routed<Key extends keyof StorageBackend>(key: Key): (...args: Parameters<StorageBackend[Key]>) => Promise<Awaited<ReturnType<StorageBackend[Key]>>> {
  return async (...args: Parameters<StorageBackend[Key]>): Promise<Awaited<ReturnType<StorageBackend[Key]>>> => {
    const backend = await whenStorageReady();
    const invoke = backend[key] as (...values: Parameters<StorageBackend[Key]>) => ReturnType<StorageBackend[Key]>;
    return await invoke(...args) as Awaited<ReturnType<StorageBackend[Key]>>;
  };
}

export const storageManager: StorageBackend = {
  listAllPages: routed('listAllPages'),
  scanSearchPages: routed('scanSearchPages'),
  searchTextPages: routed('searchTextPages'),
  listRecentPages: routed('listRecentPages'),
  listRecentPageSummaries: routed('listRecentPageSummaries'),
  getPageRecord: routed('getPageRecord'),
  getNextPageRecord: routed('getNextPageRecord'),
  getBackupBatch: routed('getBackupBatch'),
  savePageRecord: routed('savePageRecord'),
  savePageSummary: routed('savePageSummary'),
  deletePages: routed('deletePages'),
  forgetPageVersions: routed('forgetPageVersions'),
  listLogs: readLogs,
  clearLogs: removeLogs,
  listProcessing: routed('listProcessing'),
  listProcessingSummaries: routed('listProcessingSummaries'),
  listFailedProcessingTargets: routed('listFailedProcessingTargets'),
  appendProcessing: routed('appendProcessing'),
  updateProcessingEntry: routed('updateProcessingEntry'),
  deleteProcessing: routed('deleteProcessing'),
  getProcessingEntry: routed('getProcessingEntry'),
  listPageVersions: routed('listPageVersions'),
  updateSavedVersion: routed('updateSavedVersion')
};
