import sqliteInit from './sqlite/index.mjs';
import { visitSavedLibrarySnapshot } from './saved-library-source.mjs';

const filename = '/qualification-library.sqlite3';
const migrationFile = '/qualification-migration.sqlite3';
const initialized = sqliteInit();
let database;

async function connect(create = false) {
  if (database) return database;
  const sqlite = await initialized;
  if (!sqlite.oo1.OpfsWlDb) throw Error('The SQLite Web Locks OPFS VFS is unavailable');
  const root = await navigator.storage.getDirectory();
  if (!create) await root.getFileHandle(filename.slice(1));
  const opened = new sqlite.oo1.OpfsWlDb(filename, create ? 'c' : 'w');
  try {
    opened.exec('pragma foreign_keys=on; pragma synchronous=extra; pragma cache_size=8; pragma cache_spill=on');
    if (opened.selectValue('pragma journal_mode') !== 'delete') throw Error('Expected a rollback journal');
    if (opened.selectValue('pragma synchronous') !== 3) throw Error('Extra durability unavailable');
    if (create) opened.transaction(transaction => transaction.exec(`
      create table pages(id text primary key not null, title text not null, text text not null);
      create table versions(id text primary key not null, page text not null references pages(id) on delete cascade, text text not null);
      create table jobs(page text primary key not null references pages(id) on delete cascade, capture text not null);
    `));
    database = opened;
    return database;
  } catch (error) { opened.close(); throw error; }
}

function mutate(database, request) {
  for (const id of request.forget) database.exec({ sql: 'delete from pages where id=?', bind: [id] });
  for (const [id, title, text] of request.pages) {
    database.exec({ sql: 'insert into pages values(?,?,?) on conflict(id) do update set title=excluded.title,text=excluded.text', bind: [id, title, text] });
  }
  for (const version of request.versions) database.exec({ sql: 'insert into versions values(?,?,?)', bind: version });
  for (const job of request.jobs) database.exec({ sql: 'insert into jobs values(?,?) on conflict(page) do update set capture=excluded.capture', bind: job });
}

async function legacySource() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('webRecallBeta');
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openMigration(create) {
  const sqlite = await initialized;
  if (!create) await (await navigator.storage.getDirectory()).getFileHandle(migrationFile.slice(1));
  const connection = new sqlite.oo1.OpfsWlDb(migrationFile, create ? 'c' : 'w');
  connection.exec('pragma synchronous=extra');
  return connection;
}

async function copyLegacy(failFirstPage) {
  const source = await legacySource();
  try {
    const target = await openMigration(true);
    try {
      target.exec('begin immediate');
      try {
        target.exec(`create table records(store text, url text, body text, primary key(store,url)) without rowid;
          create table cutover(sourceVersion integer not null, pages integer not null, processing integer not null);`);
        const copy = (store, row) => target.exec({ sql: 'insert into records values(?,?,?)', bind: [store, row.url, JSON.stringify(row)] });
        const counts = await visitSavedLibrarySnapshot(source, {
          page(row) { copy('pages', row); if (failFirstPage) throw Error('Injected failure after copying evidence'); },
          processing(row) { copy('processing', row); }
        });
        for (const [store, count] of Object.entries(counts)) {
          if (target.selectValue('select count(*) from records where store=?', [store]) !== count) throw Error('The copied library counts differ');
        }
        target.exec({ sql: 'insert into cutover values(?,?,?)', bind: [source.version, counts.pages, counts.processing] });
        target.exec('commit');
        return { migrated: counts };
      } catch (error) { target.exec('rollback'); throw error; }
    } finally { target.close(); }
  } finally { source.close(); }
}

async function inspectMigration() {
  const target = await openMigration(false);
  try {
    const sealed = target.selectValue("select count(*) from sqlite_schema where type='table' and name='cutover'");
    if (!sealed) return { committed: false, tables: target.selectValues("select name from sqlite_schema where type='table'") };
    return {
      committed: true,
      marker: target.selectArrays('select * from cutover'),
      pages: target.selectValues("select body from records where store='pages' order by url").map(value => JSON.parse(value)),
      processing: target.selectValues("select body from records where store='processing' order by url").map(value => JSON.parse(value)),
      integrity: target.selectValues('pragma integrity_check')
    };
  } finally { target.close(); }
}

async function operate(request) {
  if (request.kind === 'host-status') return {
    workerIsolated: crossOriginIsolated,
    vfsAvailable: Boolean((await initialized).oo1.OpfsWlDb)
  };
  if (request.kind === 'copy-legacy') return copyLegacy(request.failFirstPage);
  if (request.kind === 'inspect-migration') return inspectMigration();
  const connection = await connect(request.kind === 'initialize');
  if (request.kind === 'initialize' || request.kind === 'commit') {
    connection.transaction(transaction => mutate(transaction, request));
    return { committed: true };
  }
  if (request.kind === 'leave-open') {
    connection.exec('begin immediate');
    mutate(connection, request);
    return { pending: true };
  }
  if (request.kind === 'inspect') return {
    pages: connection.selectArrays('select id,title,text from pages order by id'),
    versions: connection.selectArrays('select id,page,text from versions order by id'),
    jobs: connection.selectArrays('select page,capture from jobs order by page'),
    integrity: connection.selectValues('pragma integrity_check'),
    brokenReferences: connection.selectArrays('pragma foreign_key_check')
  };
  throw Error('Unexpected qualification request');
}

self.onmessage = ({ data: { sequence, request } }) => {
  void operate(request).then(reply => self.postMessage({ sequence, reply }), error => self.postMessage({ sequence, reply: { error: error.message, errorName: error.name } }));
};
