import { normalizeLegacyPage } from './records';

const DB_NAME = 'webRecallBeta';
const DB_VERSION = 3;
const MIGRATIONS_STORE = 'migrations';
const LEGACY_DATABASE = 'webMemoryDB';

export const PAGES_STORE = 'pages';
export const HIGHLIGHTS_STORE = 'highlights';
export const EMBEDDINGS_STORE = 'embeddings';
export const LOGS_STORE = 'logs';
export const PROCESSING_STORE = 'processing';

const LEGACY_STORAGE_KEY = 'beta-pages';
const MAX_LEGACY_SNAPSHOT = 20;

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
  versions?: Array<{ timestamp: number; text: string; chunks: PageChunkRecord[]; summary?: string }>;
};

export type HighlightRecord = {
  date: string;
  payload: unknown;
  updatedAt: number;
};

export type EmbeddingRecord = {
  key: string;
  pageUrl: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  embeddingKey?: string;
  createdAt: number;
};

export type LogRecord = {
  id?: number;
  level: 'info' | 'warn' | 'error';
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
};

type LegacyPageSnapshot = {
  url: string;
  title: string;
  timestamp: number;
  text?: string;
  items?: Array<{ text: string; embedding?: number[] }>;
  manual?: boolean;
};

let openPromise: Promise<IDBDatabase> | null = null;
let legacyMigrationPromise: Promise<void> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this context'));
  }
  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;
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
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); openPromise = null; };
      // Every reader (including offscreen search) waits for the upgrade copy.
      migrateLegacyDatabase(db).then(() => resolve(db)).catch((error) => { db.close(); reject(error); });
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    openPromise = null;
    throw error;
  });
  return openPromise;
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
      const tx = db.transaction([PAGES_STORE, EMBEDDINGS_STORE, MIGRATIONS_STORE], 'readwrite');
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
              tx.objectStore(PAGES_STORE).put({ ...current, versions: [...(current.versions || []), ...(page.versions || [pageVersion(page)])] });
              return;
            }
            tx.objectStore(PAGES_STORE).put(page);
            page.chunks.forEach((chunk, chunkIndex) => tx.objectStore(EMBEDDINGS_STORE).put({
              key: `${page.url}::${chunkIndex}`, pageUrl: page.url, chunkIndex, ...chunk, createdAt: page.createdAt
            }));
          };
        }
        markers.put({ key: LEGACY_DATABASE, completedAt: Date.now() });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Legacy library migration aborted'));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    legacy?.close();
  }
}

function pageVersion(page: PageRecord): NonNullable<PageRecord['versions']>[number] {
  return { timestamp: page.timestamp, text: page.text, chunks: page.chunks, summary: page.summary };
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

export async function savePageRecord(record: Omit<PageRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<PageRecord, 'createdAt' | 'updatedAt'>>, options: { expectedUpdatedAt?: number; requireProcessing?: boolean; preserveMissingEmbeddings?: boolean } = {}): Promise<void> {
  const existing = await getPageRecord(record.url);
  const now = Date.now();
  const chunks = Array.isArray(record.chunks) ? record.chunks : [];
  const hasEmbeddings = chunks.some((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0);
  const normalized: PageRecord = {
    url: record.url,
    title: record.title || record.url,
    text: record.text || '',
    timestamp: record.timestamp || now,
    manual: Boolean(record.manual),
    chunks,
    createdAt: existing?.createdAt ?? record.createdAt ?? now,
    updatedAt: now,
    lastEmbeddedAt: record.lastEmbeddedAt ?? existing?.lastEmbeddedAt ?? (hasEmbeddings ? now : undefined),
    summary: record.summary ?? existing?.summary,
    versions: record.versions ?? existing?.versions
  };
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PAGES_STORE, EMBEDDINGS_STORE, HIGHLIGHTS_STORE, PROCESSING_STORE], 'readwrite');
    const write = (current?: PageRecord): void => {
      if (options.preserveMissingEmbeddings) {
        const savedChunks = new Map<string, PageChunkRecord>();
        for (const chunk of current?.chunks || []) {
          if (chunk.embedding?.length && chunk.embedding.every(Number.isFinite)) savedChunks.set(chunk.text, chunk);
        }
        // Reuse only exact text matches, retaining the original model identity.
        // Read and merge within this transaction so concurrent backfills survive.
        normalized.chunks = chunks.map(chunk => chunk.embedding?.length ? chunk : savedChunks.get(chunk.text) || chunk);
        normalized.lastEmbeddedAt = record.lastEmbeddedAt ?? current?.lastEmbeddedAt;
      }
      tx.objectStore(PAGES_STORE).put(normalized);
      tx.objectStore(HIGHLIGHTS_STORE).clear();
      const store = tx.objectStore(EMBEDDINGS_STORE);
      const cursor = store.index('pageUrl').openCursor(IDBKeyRange.only(normalized.url));
      cursor.onsuccess = () => {
        if (cursor.result) {
          cursor.result.delete();
          cursor.result.continue();
          return;
        }
        normalized.chunks.forEach((chunk, chunkIndex) => store.put({
          key: `${normalized.url}::${chunkIndex}`,
          pageUrl: normalized.url,
          chunkIndex,
          ...chunk,
          createdAt: now
        }));
      };
    };
    const writeLatest = (): void => {
      if (!options.preserveMissingEmbeddings) { write(); return; }
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
      check.onsuccess = () => { if (check.result) writeLatest(); else tx.abort(); };
    } else writeLatest();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Page update aborted'));
  });
}

export async function upsertHighlight(record: HighlightRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readwrite');
    tx.objectStore(HIGHLIGHTS_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function removeHighlight(date: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(HIGHLIGHTS_STORE, 'readwrite');
    tx.objectStore(HIGHLIGHTS_STORE).delete(date);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function migrateLegacySnapshotIfNeeded(): Promise<void> {
  if (legacyMigrationPromise) return legacyMigrationPromise;
  legacyMigrationPromise = (async () => {
    const db = await openDatabase();
    const hasPages = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(PAGES_STORE, 'readonly');
      const cursorReq = tx.objectStore(PAGES_STORE).openKeyCursor();
      cursorReq.onsuccess = () => resolve(Boolean(cursorReq.result));
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    if (hasPages) {
      await clearLegacySnapshot();
      return;
    }
    const snapshot = await readLegacySnapshot();
    if (!snapshot || snapshot.length === 0) return;
    for (const legacy of snapshot.slice(0, MAX_LEGACY_SNAPSHOT)) {
      const page: PageRecord = {
        url: legacy.url,
        title: legacy.title || legacy.url,
        text: legacy.text || '',
        timestamp: legacy.timestamp || Date.now(),
        manual: Boolean(legacy.manual),
        chunks: (legacy.items || []).map((item) => ({
          text: item.text || '',
          embedding: Array.isArray(item.embedding) ? item.embedding : []
        })),
        createdAt: legacy.timestamp || Date.now(),
        updatedAt: legacy.timestamp || Date.now(),
        lastEmbeddedAt: legacy.timestamp || Date.now()
      };
      await savePageRecord(page);
    }
    await clearLegacySnapshot();
    console.info('[beta-shared:db] migrated legacy chrome.storage snapshot', {
      migrated: Math.min(snapshot.length, MAX_LEGACY_SNAPSHOT)
    });
  })().catch((err) => {
    console.error('[beta-shared:db] legacy snapshot migration failed', err);
  });
  await legacyMigrationPromise;
}

async function readLegacySnapshot(): Promise<LegacyPageSnapshot[] | undefined> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return undefined;
  return new Promise((resolve) => {
    chrome.storage.local.get([LEGACY_STORAGE_KEY], (result: Record<string, unknown>) => {
      if (chrome.runtime?.lastError) {
        console.warn('[beta-shared:db] unable to read legacy snapshot', chrome.runtime.lastError);
        resolve(undefined);
        return;
      }
      const payload = result?.[LEGACY_STORAGE_KEY];
      if (!Array.isArray(payload)) {
        resolve(undefined);
        return;
      }
      resolve(payload as LegacyPageSnapshot[]);
    });
  });
}

async function clearLegacySnapshot(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove([LEGACY_STORAGE_KEY], () => resolve());
  });
}

export async function resetDbCaches(): Promise<void> {
  openPromise = null;
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

export async function deletePages(urls: string[]): Promise<number> {
  if (!urls.length) return 0;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PAGES_STORE, EMBEDDINGS_STORE, PROCESSING_STORE, HIGHLIGHTS_STORE], 'readwrite');
    const store = tx.objectStore(PAGES_STORE);
    tx.objectStore(HIGHLIGHTS_STORE).clear();
    for (const url of urls) {
      store.delete(url);
      tx.objectStore(PROCESSING_STORE).delete(url);
      const cursor = tx.objectStore(EMBEDDINGS_STORE).index('pageUrl').openCursor(IDBKeyRange.only(url));
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        cursor.result.delete();
        cursor.result.continue();
      };
    }
    tx.oncomplete = () => resolve(urls.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('delete transaction aborted'));
  });
}

export async function saveLog(record: LogRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(LOGS_STORE, 'readwrite');
    tx.objectStore(LOGS_STORE).put({ ...record, createdAt: record.createdAt || Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
  });
}

export async function appendProcessing(entry: ProcessingEntry): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readwrite');
    tx.objectStore(PROCESSING_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function updateProcessingEntry(entry: ProcessingEntry, create = false): Promise<boolean> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readwrite');
    const store = tx.objectStore(PROCESSING_STORE);
    let updated = false;
    const request = store.get(entry.url);
    request.onsuccess = () => {
      const existing = request.result as ProcessingEntry | undefined;
      if (!existing && !create) return;
      store.put({ ...entry, createdAt: existing?.createdAt ?? entry.createdAt, payload: entry.payload ?? existing?.payload });
      updated = true;
    };
    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Processing transition aborted'));
  });
}

export async function deleteProcessing(url: string): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROCESSING_STORE, 'readwrite');
    tx.objectStore(PROCESSING_STORE).delete(url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
