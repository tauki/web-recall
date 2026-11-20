import { DB_NAME, PAGES_STORE, PROCESSING_STORE, type PageRecord, type ProcessingEntry } from './index';

type SavedLibraryVisitor = {
  page: (record: PageRecord) => undefined;
  processing: (entry: ProcessingEntry) => undefined;
};

export type SavedLibraryCounts = { pages: number; processing: number };

export function openExistingSavedLibrary(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    let absent = false;
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction!.abort();
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      if (absent && request.error?.name === 'AbortError') resolve(null);
      else reject(request.error);
    };
  });
}

export function visitSavedLibrarySnapshot(database: IDBDatabase, visitor: SavedLibraryVisitor): Promise<SavedLibraryCounts> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([PAGES_STORE, PROCESSING_STORE], 'readonly');
    let failure: { reason: unknown } | undefined;
    const counts = { pages: 0, processing: 0 };
    transaction.oncomplete = () => resolve(counts);
    transaction.onabort = () => reject(failure ? failure.reason : transaction.error ?? new Error('Saved library snapshot was interrupted.'));

    const read = <Record extends { url: string }>(store: string, visit: (record: Record) => undefined, count: keyof SavedLibraryCounts): void => {
      const request = transaction.objectStore(store).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          const record = cursor.value as Record;
          if (!record || typeof record.url !== 'string' || !record.url || record.url !== cursor.primaryKey) {
            throw new Error('Saved library snapshot contains an invalid record identity.');
          }
          const result = visit(record);
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => {});
            throw new Error('Consume snapshot records synchronously before advancing the cursor.');
          }
          counts[count]++;
          cursor.continue();
        } catch (error) {
          failure = { reason: error };
          transaction.abort();
        }
      };
    };
    read(PAGES_STORE, visitor.page, 'pages');
    read(PROCESSING_STORE, visitor.processing, 'processing');
  });
}
