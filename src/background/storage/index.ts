import { migrateLegacySnapshotIfNeeded, openDatabase } from '../../shared/db/index';

let readyPromise: Promise<void> | null = null;

export function initStorage(): void {
  void whenStorageReady().catch((err) => {
    console.error('[beta-background:storage] failed to initialise IndexedDB', err);
  });
}

export function whenStorageReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await openDatabase();
      await migrateLegacySnapshotIfNeeded();
      console.info('[beta-background:storage] IndexedDB ready');
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}
