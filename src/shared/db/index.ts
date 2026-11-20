import { normalizeLegacyPage } from './records';
import type { RecentPage, RecentCursor, RecentPageBatch } from '../recents';
import { matchesSearchFilters, type SearchFilters } from '../searchFilters';
import { identifySavedVersions, versionSnapshot, versionSource, type SavedVersionSelection, type SavedVersionSource, type ForgetResult } from '../pageHistory';
import type { CaptureInfo } from '../capture';
import { searchPageRecord } from './search';
import { forgetVersions, matchesReconciledJob, nextPageRecord, nextProcessingEntry, updatedSummary, versionEdit, type PageWrite, type PageWriteOptions } from './recordChanges';

export const DB_NAME = 'webRecallBeta';
const DB_VERSION = 5;
const MIGRATIONS_STORE = 'migrations';
export const LEGACY_DATABASE = 'webMemoryDB';

export const PAGES_STORE = 'pages';
export const SEARCH_STORE = 'pageText';
export const HIGHLIGHTS_STORE = 'highlights';
export const EMBEDDINGS_STORE = 'embeddings';
export const LOGS_STORE = 'logs';
export const PROCESSING_STORE = 'processing';

export const LEGACY_STORAGE_KEY = 'beta-pages';
const SEARCH_BATCH_SIZE = 64;

export type PageChunkRecord = {
  text: string;
  embedding: number[];
  embeddingKey?: string;
};

export type StoredCapturePayload = {
  url: string;
  title: string;
  timestamp: number;
  chunks: string[];
  text: string;
  force?: boolean;
  manual?: boolean;
  captureId?: string;
  captureInfo?: CaptureInfo;
};

export type PageVersion = {
  versionId?: string;
  title?: string;
  timestamp: number;
  firstCapturedAt?: number;
  kept?: boolean;
  manual?: boolean;
  lastVisitedAt?: number;
  lastEmbeddedAt?: number;
  text: string;
  chunks: PageChunkRecord[];
  summary?: string;
  captureInfo?: CaptureInfo;
};

export type PageRecord = {
  url: string;
  title: string;
  text: string;
  timestamp: number;
  manual: boolean;
  chunks: PageChunkRecord[];
  createdAt: number;
  updatedAt: number;
  lastEmbeddedAt?: number;
  summary?: string;
  versions?: PageVersion[];
  versionId?: string;
  firstCapturedAt?: number;
  lastVisitedAt?: number;
  kept?: boolean;
  captureInfo?: CaptureInfo;
};

export type LogRecord = {
  id?: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
  createdAt: number;
};

export type ProcessingEntry = {
  url: string;
  title: string;
  status: 'queued' | 'processing' | 'failed' | 'done';
  attempts: number;
  lastAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  payload?: StoredCapturePayload;
  error?: string;
  textSaved?: boolean;
};

export type ProcessingSummary = Pick<ProcessingEntry, 'url' | 'title' | 'status' | 'attempts' | 'updatedAt' | 'error' | 'textSaved'>;
export type FailedProcessingTarget = { url: string; captureId: string | null };

let openPromise: Promise<IDBDatabase> | null = null;
let libraryOpened = false;

export function openDatabase(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this context'));
  }
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const oldVersion = event.oldVersion;
      if (oldVersion === 0 && libraryOpened) {
        request.transaction!.abort();
        reject(new Error('The previously opened local library is missing. Restart Chrome. If the library is still missing, restore a backup in Settings.'));
        return;
      }
      const db = request.result;
      if (oldVersion < 1) {
        const pages = db.createObjectStore(PAGES_STORE, { keyPath: 'url' });
        pages.createIndex('timestamp', 'timestamp', { unique: false });
        pages.createIndex('manual', 'manual', { unique: false });
        db.createObjectStore(HIGHLIGHTS_STORE, { keyPath: 'date' });
        const embeddings = db.createObjectStore(EMBEDDINGS_STORE, { keyPath: 'key' });
        embeddings.createIndex('pageUrl', 'pageUrl', { unique: false });
      }
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains(LOGS_STORE)) {
          db.createObjectStore(LOGS_STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(PROCESSING_STORE)) {
          db.createObjectStore(PROCESSING_STORE, { keyPath: 'url' });
        }
      }
      if (oldVersion < 3) db.createObjectStore(MIGRATIONS_STORE, { keyPath: 'key' });
      if (oldVersion < 4) request.transaction!.objectStore(PAGES_STORE).createIndex('recentMetadata', ['timestamp', 'url', 'title']);
      if (oldVersion < 5) {
        const search = db.createObjectStore(SEARCH_STORE, { keyPath: 'url' });
        const requestPages = request.transaction!.objectStore(PAGES_STORE).openCursor();
        requestPages.onsuccess = () => {
          const cursor = requestPages.result;
          if (!cursor) return;
          search.put(searchPageRecord(cursor.value as PageRecord));
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      libraryOpened = true;
      const invalidate = () => {
        if (openPromise === opening) openPromise = null;
        reject(new Error('The local library connection closed. Retry the operation.'));
      };
      db.onclose = invalidate;
      db.onversionchange = () => { db.close(); invalidate(); };
      // Every reader (including offscreen search) waits for the upgrade copy.
      migrateLegacyDatabase(db).then(() => resolve(db)).catch((error) => { db.close(); reject(error); });
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    if (openPromise === opening) openPromise = null;
    throw error;
  });
  openPromise = opening;
  return opening;
}

async function migrateLegacyDatabase(db: IDBDatabase): Promise<void> {
  const migrated = await new Promise<boolean>((resolve, reject) => {
    const request = db.transaction(MIGRATIONS_STORE).objectStore(MIGRATIONS_STORE).get(LEGACY_DATABASE);
    request.onsuccess = () => resolve(Boolean(request.result));
    request.onerror = () => reject(request.error);
  });
  if (migrated) return;
  // Do not create an empty legacy database on a fresh installation.
  const databases = await indexedDB.databases();
  let legacy: IDBDatabase | undefined;
  try {
    let records: Record<string, unknown>[] = [];
    if (databases.some((entry) => entry.name === LEGACY_DATABASE)) {
      legacy = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(LEGACY_DATABASE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      legacy.onversionchange = () => legacy?.close();
      if (legacy.objectStoreNames.contains(PAGES_STORE)) {
        records = await new Promise((resolve, reject) => {
          const request = legacy!.transaction(PAGES_STORE).objectStore(PAGES_STORE).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
    }
    // Validate the complete source before committing any records or the marker.
    const pages = new Map<string, PageRecord>();
    for (const page of records.map(normalizeLegacyPage).sort((a, b) => b.timestamp - a.timestamp)) {
      const newer = pages.get(page.url);
      if (newer) newer.versions = [...(newer.versions || [pageVersion(newer)]), ...(page.versions || [pageVersion(page)])];
      else pages.set(page.url, page);
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([PAGES_STORE, SEARCH_STORE, MIGRATIONS_STORE], 'readwrite', { durability: 'strict' });
      const markers = tx.objectStore(MIGRATIONS_STORE);
      const check = markers.get(LEGACY_DATABASE);
      check.onsuccess = () => {
        if (check.result) return; // Another extension context already completed the copy.
        for (const page of pages.values()) {
          const existing = tx.objectStore(PAGES_STORE).get(page.url);
          existing.onsuccess = () => {
            if (existing.result) {
              // Preserve the active 0.2 capture and retain the old content in history.
              const current = existing.result as PageRecord;
              putPage(tx, { ...current, versions: [...(current.versions || []), ...(page.versions || [pageVersion(page)])] });
              return;
            }
            putPage(tx, page);
          };
        }
        markers.put({ key: LEGACY_DATABASE, completedAt: Date.now() });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Legacy library migration aborted'));
    });
  } finally {
    legacy?.close();
  }
}

function pageVersion(page: PageRecord): NonNullable<PageRecord['versions']>[number] {
  return versionSnapshot(page);
}

export async function getPageRecord(url: string): Promise<PageRecord | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, 'readonly');
    const request = tx.objectStore(PAGES_STORE).get(url);
    request.onsuccess = () => {
      resolve((request.result as PageRecord | undefined) || undefined);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function listRecentPages(limit = 50): Promise<PageRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, 'readonly');
    const index = tx.objectStore(PAGES_STORE).index('timestamp');
    const result: PageRecord[] = [];
    const request = index.openCursor(null, 'prev');
    request.onsuccess = () => {
      const cursor = request.result as IDBCursorWithValue | null;
      if (!cursor) {
        resolve(result);
        return;
      }
      result.push(cursor.value as PageRecord);
      if (result.length >= limit) {
        resolve(result);
        return;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listRecentPageSummaries(limit: number, after?: RecentCursor): Promise<RecentPageBatch> {
  if (!Number.isInteger(limit) || limit < 1) return { pages: [], nextCursor: null };
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, 'readonly');
    const result: RecentPage[] = [];
    let last: RecentCursor | null = null, nextCursor: RecentCursor | null = null;
    const range = after ? IDBKeyRange.upperBound([after.timestamp, after.url, after.title], true) : null;
    const request = tx.objectStore(PAGES_STORE).index('recentMetadata').openKeyCursor(range, 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (result.length === limit) { nextCursor = last; return; }
      const [timestamp, url, title] = cursor.key as [number, string, string];
      result.push({ url, title: title || url, timestamp });
      last = { timestamp, url, title };
      cursor.continue();
    };
    tx.oncomplete = () => resolve({ pages: result, nextCursor });
    tx.onabort = () => reject(tx.error || new Error('Unable to read recent pages'));
    request.onerror = () => reject(request.error);
  });
}

export async function savePageRecord(record: PageWrite, options: PageWriteOptions & { signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const db = await openDatabase();
  options.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PAGES_STORE, SEARCH_STORE, PROCESSING_STORE], 'readwrite', { durability: 'strict' });
    const stop = (): void => { tx.abort(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    const write = (current?: PageRecord): void => {
      const normalized = nextPageRecord(record, current, options, Date.now());
      putPage(tx, normalized);
      if (options.captureEntry) tx.objectStore(PROCESSING_STORE).put(options.captureEntry);
      if (options.discardProcessing) tx.objectStore(PROCESSING_STORE).delete(normalized.url);
      if (options.reconcileFailedProcessing) {
        const expected = options.reconcileFailedProcessing;
        const pending = tx.objectStore(PROCESSING_STORE).get(normalized.url);
        pending.onsuccess = () => {
          if (matchesReconciledJob(normalized, pending.result as ProcessingEntry | undefined, expected)) tx.objectStore(PROCESSING_STORE).delete(normalized.url);
        };
      }
    };
    const writeLatest = (): void => {
      const latest = tx.objectStore(PAGES_STORE).get(record.url);
      latest.onsuccess = () => write(latest.result as PageRecord | undefined);
    };
    if (options.expectedUpdatedAt !== undefined) {
      const check = tx.objectStore(PAGES_STORE).get(record.url);
      check.onsuccess = () => {
        if (!check.result || check.result.updatedAt !== options.expectedUpdatedAt) tx.abort();
        else write(check.result as PageRecord);
      };
    } else if (options.requireProcessing) {
      const check = tx.objectStore(PROCESSING_STORE).get(record.url);
      check.onsuccess = () => {
        const job = check.result as ProcessingEntry | undefined;
        if (job && (options.expectedCaptureId === undefined || (job.payload?.captureId ?? null) === options.expectedCaptureId)) writeLatest();
        else tx.abort();
      };
    } else writeLatest();
    tx.oncomplete = () => { options.signal?.removeEventListener('abort', stop); resolve(); };
    tx.onabort = () => { options.signal?.removeEventListener('abort', stop); reject(options.signal?.reason || tx.error || new Error('Page update aborted')); };
  });
}

export async function listPageVersions(url: string, signal?: AbortSignal): Promise<PageVersion[]> {
  signal?.throwIfAborted();
  const db = await openDatabase();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let versions: PageVersion[] = [];
    const tx = db.transaction([PAGES_STORE, SEARCH_STORE], 'readwrite', { durability: 'strict' });
    const stop = (): void => { tx.abort(); };
    signal?.addEventListener('abort', stop, { once: true });
    const store = tx.objectStore(PAGES_STORE), request = store.get(url);
    request.onsuccess = () => {
      if (signal?.aborted) { tx.abort(); return; }
      const page = request.result as PageRecord | undefined;
      if (!page) return;
      const identified = identifySavedVersions(page);
      if (!page.versionId || page.versions?.some(version => !version.versionId)) putPage(tx, identified);
      versions = [versionSnapshot(identified), ...(identified.versions || [])];
    };
    tx.oncomplete = () => { signal?.removeEventListener('abort', stop); resolve(versions); };
    tx.onabort = () => { signal?.removeEventListener('abort', stop); reject(signal?.reason || tx.error || new Error('Unable to read saved versions')); };
  });
}

export async function updateSavedVersion(url: string, versionId: string, action: 'keep' | 'release' | 'delete'): Promise<SavedVersionSource[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    const removed: SavedVersionSource[] = [];
    const tx = db.transaction([PAGES_STORE, SEARCH_STORE], 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(PAGES_STORE), request = store.get(url);
    request.onsuccess = () => {
      try {
        const edit = versionEdit(request.result as PageRecord | undefined, versionId, action);
        removed.push(...edit.removed);
        putPage(tx, edit.page);
      } catch (error) { failure = error as Error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(removed);
    tx.onabort = () => reject(failure || tx.error || new Error('Saved version update aborted'));
  });
}

export async function savePageSummary(url: string, expectedText: string, summary: string, signal?: AbortSignal, expectedSummary?: string, expectedTitle?: string, expectedVersionId?: string | null): Promise<boolean> {
  signal?.throwIfAborted();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let saved = false;
    const tx = db.transaction(PAGES_STORE, 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(PAGES_STORE), request = store.get(url);
    request.onsuccess = () => {
      if (signal?.aborted) { tx.abort(); return; }
      const next = updatedSummary(request.result as PageRecord | undefined, expectedText, summary, expectedSummary, expectedTitle, expectedVersionId);
      if (next) { store.put(next); saved = true; }
    };
    tx.oncomplete = () => resolve(saved);
    tx.onabort = () => reject(signal?.reason || tx.error || new Error('Summary update aborted'));
  });
}

export async function migrateLegacySnapshotIfNeeded(): Promise<void> {
  const db = await openDatabase();
  const stored = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
  const snapshot: unknown = stored[LEGACY_STORAGE_KEY];
  if (snapshot === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([PAGES_STORE, SEARCH_STORE], 'readwrite', { durability: 'strict' });
    const pages = transaction.objectStore(PAGES_STORE);
    let failure: unknown;
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Legacy snapshot preparation was interrupted.'));
    const existing = pages.openKeyCursor();
    existing.onsuccess = () => {
      if (existing.result) return;
      try {
        if (!Array.isArray(snapshot)) throw new Error('The legacy saved-page snapshot is invalid.');
        for (const page of snapshot.map(normalizeLegacyPage)) putPage(transaction, page);
      } catch (error) { failure = error; transaction.abort(); }
    };
  });
}

export async function resetDbCaches(): Promise<void> {
  openPromise = null;
}

function putPage(transaction: IDBTransaction, page: PageRecord): void {
  transaction.objectStore(PAGES_STORE).put(page);
  transaction.objectStore(SEARCH_STORE).put(searchPageRecord(page));
}

export async function scanSearchPages(visit: (page: PageRecord) => void, options: { signal?: AbortSignal; scopeUrls?: string[] } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const db = await openDatabase();
  options.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SEARCH_STORE, 'readonly'), store = tx.objectStore(SEARCH_STORE);
    const urls = options.scopeUrls ? [...new Set(options.scopeUrls)].sort() : undefined;
    let position = 0, after: string | undefined, failure: unknown;
    const stop = (): void => { tx.abort(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    const next = (): void => {
      if (urls && position >= urls.length) return;
      const request = urls ? store.get(urls[position++]!) : store.getAll(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true), SEARCH_BATCH_SIZE);
      request.onsuccess = () => {
        try {
          const records = (urls ? request.result ? [request.result] : [] : request.result || []) as PageRecord[];
          options.signal?.throwIfAborted();
          after = records.at(-1)?.url;
          if (urls ? position < urls.length : records.length === SEARCH_BATCH_SIZE) next();
          for (const record of records) { options.signal?.throwIfAborted(); visit(record); }
          options.signal?.throwIfAborted();
        } catch (error) {
          failure = error;
          try { tx.abort(); } catch { options.signal?.removeEventListener('abort', stop); reject(error); }
        }
      };
    };
    tx.oncomplete = () => { options.signal?.removeEventListener('abort', stop); resolve(); };
    tx.onabort = () => { options.signal?.removeEventListener('abort', stop); reject(options.signal?.reason || failure || tx.error || new Error('Text search scan aborted')); };
    next();
  });
}

export async function listAllPages(): Promise<PageRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, 'readonly');
    const request = tx.objectStore(PAGES_STORE).getAll();
    request.onsuccess = () => resolve((request.result as PageRecord[]) || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getNextPageRecord(afterUrl?: string): Promise<PageRecord | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, 'readonly');
    const request = tx.objectStore(PAGES_STORE).openCursor(afterUrl === undefined ? undefined : IDBKeyRange.lowerBound(afterUrl, true));
    request.onsuccess = () => resolve(request.result?.value as PageRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function deletePages(urls: string[], filters?: SearchFilters): Promise<{ deleted: number; removedVersions: SavedVersionSource[] }> {
  const result = { deleted: 0, removedVersions: [] as SavedVersionSource[] };
  if (!urls.length) return result;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PAGES_STORE, SEARCH_STORE, EMBEDDINGS_STORE, PROCESSING_STORE, HIGHLIGHTS_STORE], 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(PAGES_STORE);
    let clearedHighlights = false;
    const remove = (url: string, page?: PageRecord): void => {
      if (!clearedHighlights) { tx.objectStore(HIGHLIGHTS_STORE).clear(); clearedHighlights = true; }
      if (page) { result.deleted++; result.removedVersions.push(...[versionSnapshot(page), ...(page.versions || [])].map(version => versionSource(url, version))); }
      store.delete(url);
      tx.objectStore(SEARCH_STORE).delete(url);
      tx.objectStore(PROCESSING_STORE).delete(url);
      const cursor = tx.objectStore(EMBEDDINGS_STORE).index('pageUrl').openCursor(IDBKeyRange.only(url));
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        cursor.result.delete();
        cursor.result.continue();
      };
    };
    for (const url of new Set(urls)) {
      const read = store.get(url);
      read.onsuccess = () => { if (!filters || read.result && matchesSearchFilters(read.result, filters)) remove(url, read.result as PageRecord | undefined); };
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('delete transaction aborted'));
  });
}

export async function forgetPageVersions(selection: SavedVersionSelection[], filters: SearchFilters): Promise<ForgetResult & { captureJobs: Array<{ url: string; captureId: string | null }>; removedVersions: SavedVersionSource[] }> {
  const result = { pages: 0, versions: 0, captureJobs: [] as Array<{ url: string; captureId: string | null }>, removedVersions: [] as SavedVersionSource[] };
  if (!selection.length) return result;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PAGES_STORE, SEARCH_STORE, EMBEDDINGS_STORE, PROCESSING_STORE, HIGHLIGHTS_STORE], 'readwrite', { durability: 'strict' });
    const pages = tx.objectStore(PAGES_STORE);
    for (const selected of selection) {
      const read = pages.get(selected.url);
      read.onsuccess = () => {
        const page = read.result as PageRecord | undefined;
        if (!page) return;
        const change = forgetVersions(page, selected, filters, Date.now());
        if (!change) return;
        if (!result.pages) tx.objectStore(HIGHLIGHTS_STORE).clear();
        result.pages++; result.versions += change.removed.length;
        if (change.page) putPage(tx, change.page);
        else { pages.delete(page.url); tx.objectStore(SEARCH_STORE).delete(page.url); }
        result.removedVersions.push(...change.removed);
        const processing = tx.objectStore(PROCESSING_STORE), jobRead = processing.get(page.url);
        jobRead.onsuccess = () => {
          const job = jobRead.result as ProcessingEntry | undefined;
          if (!change.removesJob(job)) return;
          result.captureJobs.push({ url: page.url, captureId: job?.payload?.captureId ?? null });
          processing.delete(page.url);
        };
        const embeddings = tx.objectStore(EMBEDDINGS_STORE).index('pageUrl').openCursor(IDBKeyRange.only(page.url));
        embeddings.onsuccess = () => { if (embeddings.result) { embeddings.result.delete(); embeddings.result.continue(); } };
      };
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Forget transaction aborted'));
  });
}

export async function saveLog(record: LogRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readwrite');
    tx.objectStore(LOGS_STORE).put({ ...record, createdAt: record.createdAt || Date.now() });
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Log update aborted'));
  });
}

export async function listLogs(limit = 200): Promise<LogRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readonly');
    const store = tx.objectStore(LOGS_STORE);
    const request = store.openCursor(null, 'prev');
    const rows: LogRecord[] = [];
    request.onsuccess = () => {
      const cursor = request.result as IDBCursorWithValue | null;
      if (!cursor || rows.length >= limit) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value as LogRecord);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearLogs(): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readwrite');
    tx.objectStore(LOGS_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Log removal aborted'));
  });
}

export async function appendProcessing(entry: ProcessingEntry): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readwrite', { durability: 'strict' });
    tx.objectStore(PROCESSING_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Capture admission aborted'));
  });
}

export async function updateProcessingEntry(entry: ProcessingEntry, create = false): Promise<boolean> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readwrite', { durability: 'strict' });
    const store = tx.objectStore(PROCESSING_STORE);
    let updated = false;
    const request = store.get(entry.url);
    request.onsuccess = () => {
      const next = nextProcessingEntry(entry, request.result as ProcessingEntry | undefined, create);
      if (!next) return;
      store.put(next);
      updated = true;
    };
    tx.oncomplete = () => resolve(updated);
    tx.onabort = () => reject(tx.error || new Error('Processing transition aborted'));
  });
}

export async function deleteProcessing(url: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readwrite', { durability: 'strict' });
    tx.objectStore(PROCESSING_STORE).delete(url);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Capture removal aborted'));
  });
}

export async function listProcessing(): Promise<ProcessingEntry[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readonly');
    const request = tx.objectStore(PROCESSING_STORE).getAll();
    request.onsuccess = () => resolve((request.result as ProcessingEntry[]) || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getProcessingEntry(url: string): Promise<ProcessingEntry | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readonly');
    const request = tx.objectStore(PROCESSING_STORE).get(url);
    request.onsuccess = () => resolve((request.result as ProcessingEntry) || undefined);
    request.onerror = () => reject(request.error);
  });
}
