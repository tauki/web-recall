import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { PageRecord } from '../shared/db/index';
import { openExistingSavedLibrary } from '../shared/db/savedLibrarySource';
import { activateSavedLibrary, inspectStagedLibrary, readStagedPage, requireActiveLibrary, sealRecoveredLibrary, stageBackupPage, stageSavedLibrary, validLibraryId } from '../shared/db/sqliteLibrary';
import { SqliteRecords, type LibraryOperation } from '../shared/db/sqliteRecords';
import { createLibraryQueue } from './libraryQueue';

let sqlite: Promise<Sqlite3Static> | undefined;
let active: { id: string; records: SqliteRecords; close: () => void } | undefined;
let recovering: { id: string; database: Database } | undefined;
let expectedActive: string | undefined;
const replacementPrefix = 'web-recall-library-';
const databaseExtension = '.sqlite3';
const journalSuffix = '-journal';

function loadSqlite(): Promise<Sqlite3Static> {
  return sqlite ??= (async () => {
    const url = new URL('./sqlite/index.mjs', import.meta.url);
    const { default: initialize } = await import(url.href) as typeof import('@sqlite.org/sqlite-wasm');
    return initialize();
  })();
}

function filename(id: unknown, replacement?: unknown): string {
  return replacement === true && validLibraryId(id) ? `${replacementPrefix}${id}${databaseExtension}` : 'web-recall-library.sqlite3';
}

async function hasReplacementFile(root: FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }): Promise<boolean> {
  for await (const entry of root.keys()) {
    const name = entry.endsWith(journalSuffix) ? entry.slice(0, -journalSuffix.length) : entry;
    if (name.startsWith(replacementPrefix) && name.endsWith(databaseExtension) &&
        validLibraryId(name.slice(replacementPrefix.length, -databaseExtension.length))) return true;
  }
  return false;
}

async function fileExists(root: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await root.getFileHandle(name); return true; }
  catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
}

function configureDatabase(database: Database): void {
  database.exec('pragma synchronous=extra; pragma secure_delete=on');
  if (database.selectValue('pragma synchronous') !== 3 || database.selectValue('pragma journal_mode') !== 'delete') {
    throw new Error('The saved library requires durable rollback journaling.');
  }
}

async function recover(request: Record<string, unknown>, check: () => void): Promise<unknown> {
  const root = await navigator.storage.getDirectory();
  const missing = !(await fileExists(root, filename(request.id, request.replacement)));
  check();
  if (request.action === 'check') return { missing };
  const recoveryId = request.recoveryId;
  if (!validLibraryId(recoveryId) || recoveryId === request.id) throw new Error('Invalid saved library recovery identity.');
  const staged = filename(recoveryId, true);
  if (request.action === 'discard') {
    if (recovering?.id === recoveryId) { recovering.database.close(); recovering = undefined; }
    const journal = staged + journalSuffix;
    if (await fileExists(root, journal)) await root.removeEntry(journal);
    if (await fileExists(root, staged)) await root.removeEntry(staged);
    return { discarded: true };
  }
  if (!missing) throw new Error('The saved library file still exists. Restore cannot replace it.');
  if (request.action === 'start') {
    if (recovering || await fileExists(root, staged)) throw new Error('A saved library recovery already exists.');
    const { oo1 } = await loadSqlite();
    if (!oo1.OpfsWlDb) throw new Error('The browser does not support the saved library storage worker.');
    check();
    const database = new oo1.OpfsWlDb(`/${staged}`, 'c');
    try {
      configureDatabase(database);
      await stageSavedLibrary(database, recoveryId, null);
      recovering = { id: recoveryId, database };
      return { started: true };
    } catch (error) { database.close(); throw error; }
  }
  if (recovering?.id !== recoveryId) throw new Error('The staged backup is unavailable. Choose the backup again.');
  if (request.action === 'write') {
    stageBackupPage(recovering.database, request.record as PageRecord);
    return { staged: true };
  }
  if (request.action === 'seal') {
    sealRecoveredLibrary(recovering.database, recoveryId, request.pages as number);
    recovering.database.close();
    recovering = undefined;
    const { oo1 } = await loadSqlite();
    if (!oo1.OpfsWlDb) throw new Error('The browser does not support the saved library storage worker.');
    const verified = new oo1.OpfsWlDb(`/${staged}`, 'w');
    try { requireActiveLibrary(verified, recoveryId); }
    finally { verified.close(); }
    return { sealed: true };
  }
  throw new Error('Unknown saved library recovery operation.');
}

async function operate(request: Record<string, unknown>, check: () => void): Promise<unknown> {
  if (!request || typeof request.kind !== 'string' || !['inspect', 'stage', 'read', 'activate', 'operate', 'recover'].includes(request.kind)) {
    throw new Error('Unknown saved library request.');
  }
  const id = request.id;
  if (request.kind !== 'inspect' && !validLibraryId(id)) throw new Error('Invalid saved library identity.');
  if (request.kind === 'recover') return recover(request, check);
  if (request.kind === 'stage' && (request.preparing !== true || (request.source !== 'indexeddb' && request.source !== 'empty'))) {
    throw new Error('The saved library requires a verified migration intent.');
  }
  if (request.kind === 'read' && (typeof request.url !== 'string' || !request.url)) throw new Error('A saved page URL is required.');
  const { oo1 } = await loadSqlite();
  if (!oo1.OpfsWlDb) throw new Error('The browser does not support the saved library storage worker.');
  const name = filename(id, request.replacement);
  const root = await navigator.storage.getDirectory();
  const exists = await fileExists(root, name);
  check();
  if (!exists && expectedActive) throw new Error('The previously activated saved library is missing.');
  if (!exists && request.kind === 'inspect') {
    if (await hasReplacementFile(root as Parameters<typeof hasReplacementFile>[0])) throw new Error('The saved library has no matching startup identity.');
    return { library: null, exists: false };
  }
  if (!exists && request.kind !== 'stage') throw new Error('The saved library file is missing.');

  if (request.kind === 'operate') {
    if (active && active.id !== id) throw new Error('The active saved library belongs to another migration.');
    if (!active) {
      const database = new oo1.OpfsWlDb(`/${name}`, 'w');
      try {
        configureDatabase(database);
        active = { id: id as string, records: new SqliteRecords(database, id as string), close: () => { database.close(); } };
        expectedActive = active.id;
      } catch (error) { database.close(); throw error; }
    }
    return { value: await active.records.run(request.action as LibraryOperation, check) };
  }

  const database = new oo1.OpfsWlDb(`/${name}`, exists ? 'w' : 'c');
  try {
    configureDatabase(database);
    if (request.kind === 'inspect') return { library: inspectStagedLibrary(database), exists: true };
    if (request.kind === 'read') return { page: readStagedPage(database, id as string, request.url as string) };
    if (request.kind === 'activate') {
      activateSavedLibrary(database, id as string);
      if (active && active.id !== id) { active.close(); active = undefined; }
      expectedActive = id as string;
      return { active: true };
    }
    const existing = inspectStagedLibrary(database);
    if (existing) {
      if (existing.id !== id || (existing.sourceVersion === null) !== (request.source === 'empty')) {
        throw new Error('The saved library belongs to another migration.');
      }
      return { library: existing };
    }
    const source = await openExistingSavedLibrary();
    try {
      if (!source && request.source === 'indexeddb') throw new Error('The legacy saved library is missing.');
      if (source && request.source === 'empty') throw new Error('An existing saved library cannot be replaced with an empty library.');
      return { library: await stageSavedLibrary(database, id as string, source) };
    } finally { source?.close(); }
  } finally { database.close(); }
}

const queue = createLibraryQueue();
self.addEventListener('message', ({ data }: MessageEvent<{ token: number; request: Record<string, unknown> }>) => {
  const { token, request } = data;
  const key = validLibraryId(request?.id) && validLibraryId(request?.operationId) ? `${request.id}:${request.operationId}` : undefined;
  if (request?.kind === 'cancel') {
    if (key) queue.cancel(key);
    self.postMessage({ token, result: { cancelled: Boolean(key) } });
    return;
  }
  void queue.enqueue(key, check => operate(request, check)).then(result => self.postMessage({ token, result }),
    error => self.postMessage({ token, error: error instanceof Error ? error.message : String(error) }));
});
