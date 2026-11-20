import { clearLogs, listLogs, migrateLegacySnapshotIfNeeded } from '../../shared/db/index';
import { openSqliteAuthority } from './libraryActivation';
import { retireLegacySavedData } from './retireLegacy';
import { createSqliteBackend } from './sqlite';
import type { StorageBackend } from './manager';

let readyPromise: Promise<StorageBackend> | null = null;

export function invalidateStorageReadiness(): void { readyPromise = null; }

export function initStorage(): void {
  void whenStorageReady().catch((err) => {
    console.error('[beta-background:storage] failed to open the saved library', err);
  });
}

export function whenStorageReady(): Promise<StorageBackend> {
  if (!readyPromise) {
    const attempt = openSqliteAuthority(async () => {
      await migrateLegacySnapshotIfNeeded();
      return 'indexeddb';
    }, retireLegacySavedData).then(authority => createSqliteBackend(authority.id, { listLogs, clearLogs }, authority.source === 'backup')).catch((err) => {
      if (readyPromise === attempt) readyPromise = null;
      throw err;
    });
    readyPromise = attempt;
  }
  return readyPromise;
}
