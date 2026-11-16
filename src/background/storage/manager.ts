import {
  appendProcessing,
  updateProcessingEntry,
  clearLogs,
  deletePages,
  deleteProcessing,
  getPageRecord,
  getNextPageRecord,
  getProcessingEntry,
  listAllPages,
  listLogs,
  listProcessing,
  listRecentPages,
  listRecentPageSummaries,
  savePageRecord,
  savePageSummary
} from '../../shared/db/index';

export type {
  LogRecord,
  PageChunkRecord,
  PageRecord,
  ProcessingEntry
} from '../../shared/db/index';

export type StorageBackend = {
  listAllPages: () => ReturnType<typeof listAllPages>;
  listRecentPages: (limit?: number) => ReturnType<typeof listRecentPages>;
  listRecentPageSummaries: typeof listRecentPageSummaries;
  getPageRecord: (url: string) => ReturnType<typeof getPageRecord>;
  getNextPageRecord: typeof getNextPageRecord;
  savePageRecord: typeof savePageRecord;
  savePageSummary: typeof savePageSummary;
  deletePages: (urls: string[]) => Promise<number>;
  listLogs: (limit?: number) => ReturnType<typeof listLogs>;
  clearLogs: () => Promise<void>;
  listProcessing: () => ReturnType<typeof listProcessing>;
  appendProcessing: (entry: Parameters<typeof appendProcessing>[0]) => Promise<void>;
  updateProcessingEntry: typeof updateProcessingEntry;
  deleteProcessing: (url: string) => Promise<void>;
  getProcessingEntry: (url: string) => ReturnType<typeof getProcessingEntry>;
};

export const storageManager: StorageBackend = {
  listAllPages,
  listRecentPages,
  listRecentPageSummaries,
  getPageRecord,
  getNextPageRecord,
  savePageRecord,
  savePageSummary,
  deletePages,
  listLogs,
  clearLogs,
  listProcessing,
  appendProcessing,
  updateProcessingEntry,
  deleteProcessing,
  getProcessingEntry
};
