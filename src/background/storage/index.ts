import { migrateLegacySnapshotIfNeeded, openDatabase } from '../../shared/db/index';

let readyPromise: Promise<void> | null = null;

export function initStorage(): void {
  if (readyPromise) return;
  readyPromise = (async () => {
    try {
      await openDatabase();
      await migrateLegacySnapshotIfNeeded();
      console.info('[beta-background:storage] IndexedDB ready');
    } catch (err) {
      console.error('[beta-background:storage] failed to initialise IndexedDB', err);
    }
  })();
}

export async function whenStorageReady(): Promise<void> {
  if (!readyPromise) {
    initStorage();
  }
  if (readyPromise) {
    await readyPromise;
  }
}
