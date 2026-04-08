import {
  appendProcessing,
  clearLogs,
  deletePages,
  deleteProcessing,
  getPageRecord,
  getProcessingEntry,
  listAllPages,
  listLogs,
  listProcessing,
  listRecentPages,
  removeHighlight,
  savePageRecord,
  upsertHighlight
} from '../../shared/db/index';

export type {
  HighlightRecord,
  LogRecord,
  PageChunkRecord,
  PageRecord,
  ProcessingEntry
} from '../../shared/db/index';

export type StorageBackend = {
  listAllPages: () => ReturnType<typeof listAllPages>;
  listRecentPages: (limit?: number) => ReturnType<typeof listRecentPages>;
  getPageRecord: (url: string) => ReturnType<typeof getPageRecord>;
  savePageRecord: (record: Parameters<typeof savePageRecord>[0]) => Promise<void>;
  deletePages: (urls: string[]) => Promise<number>;
  listLogs: (limit?: number) => ReturnType<typeof listLogs>;
  clearLogs: () => Promise<void>;
  listProcessing: () => ReturnType<typeof listProcessing>;
  appendProcessing: (entry: Parameters<typeof appendProcessing>[0]) => Promise<void>;
  deleteProcessing: (url: string) => Promise<void>;
  getProcessingEntry: (url: string) => ReturnType<typeof getProcessingEntry>;
  upsertHighlight: (record: Parameters<typeof upsertHighlight>[0]) => Promise<void>;
  removeHighlight: (date: string) => Promise<void>;
};

export const storageManager: StorageBackend = {
  listAllPages,
  listRecentPages,
  getPageRecord,
  savePageRecord,
  deletePages,
  listLogs,
  clearLogs,
  listProcessing,
  appendProcessing,
  deleteProcessing,
  getProcessingEntry,
  upsertHighlight,
  removeHighlight
};
