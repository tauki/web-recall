const DB = 'web-recall-backup-keys';
const STORE = 'keys';

async function keyTransaction<Result>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<Result>): Promise<Result> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode, { durability: 'strict' });
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not access the local backup key.'));
    });
  } finally { database.close(); }
}

export function readBackupKey(): Promise<CryptoKey | undefined> {
  return keyTransaction('readonly', store => store.get('recovery'));
}

export async function requireBackupKey(): Promise<CryptoKey> {
  const key = await readBackupKey();
  if (!key) throw new Error('Set up a recovery key in Settings → Storage & backups first.');
  return key;
}

export async function storeBackupKey(key: CryptoKey): Promise<void> {
  await keyTransaction('readwrite', store => store.add(key, 'recovery'));
}
