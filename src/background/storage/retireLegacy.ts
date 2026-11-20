import { EMBEDDINGS_STORE, HIGHLIGHTS_STORE, LEGACY_DATABASE, LEGACY_STORAGE_KEY, PAGES_STORE, PROCESSING_STORE, SEARCH_STORE } from '../../shared/db/index';
import { openExistingSavedLibrary } from '../../shared/db/savedLibrarySource';
import { RECENTS_CACHE_KEY } from '../../shared/recents';

export async function retireLegacySavedData(): Promise<void> {
  const source = await openExistingSavedLibrary();
  if (source) {
    try {
      const stores = [PAGES_STORE, PROCESSING_STORE, SEARCH_STORE, EMBEDDINGS_STORE, HIGHLIGHTS_STORE]
        .filter(store => source.objectStoreNames.contains(store));
      if (stores.length) await new Promise<void>((resolve, reject) => {
        const transaction = source.transaction(stores, 'readwrite', { durability: 'strict' });
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Unable to retire the previous saved library.'));
        for (const store of stores) transaction.objectStore(store).clear();
      });
    } finally { source.close(); }
  }
  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(LEGACY_DATABASE);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error ?? new Error('Unable to retire the V0 library.'));
    deletion.onblocked = () => reject(new Error('Close old Web Recall pages before retrying the storage upgrade.'));
  });
  await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
  await chrome.storage.session.remove(RECENTS_CACHE_KEY);
}
