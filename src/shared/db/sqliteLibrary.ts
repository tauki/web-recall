import type { Database } from '@sqlite.org/sqlite-wasm';
import type { PageRecord, ProcessingEntry } from './index';
import { visitSavedLibrarySnapshot, type SavedLibraryCounts } from './savedLibrarySource';
import { searchPageRecord } from './search';
import { packSearchProjection, packSqlitePayload, unpackSqlitePayload } from './sqlitePayload';
import { encodeTextIndex } from './textIndex';

const SCHEMA_VERSION = 6;
const LIBRARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type StagedLibrary = SavedLibraryCounts & { id: string; sourceVersion: number | null };

export function validLibraryId(value: unknown): value is string {
  return typeof value === 'string' && LIBRARY_ID.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function verifyCounts(database: Database, counts: SavedLibraryCounts): void {
  if (database.selectValue('select count(*) from saved_pages') !== counts.pages || database.selectValue('select count(*) from saved_processing') !== counts.processing) {
    throw new Error('The copied saved library is incomplete.');
  }
}

type LibrarySeal = StagedLibrary & { active: 0 | 1 };

function readSeal(database: Database, version = SCHEMA_VERSION): LibrarySeal | null {
  if (database.selectValue('select count(*) from sqlite_schema') === 0) return null;
  const marker = database.selectValue('pragma user_version');
  if (marker !== version) throw new Error('Unsupported saved library format.');
  const markers = database.selectArrays('select id, source_version, pages, processing, active from saved_library');
  const [id, sourceVersion, pages, processing, active] = markers[0] ?? [];
  if (markers.length !== 1 || !validLibraryId(id) || (active !== 0 && active !== 1) ||
      (sourceVersion !== null && !nonNegativeInteger(sourceVersion)) || !nonNegativeInteger(pages) || !nonNegativeInteger(processing)) {
    throw new Error('Saved library has a missing or unsupported migration marker.');
  }
  return { id, sourceVersion, pages, processing, active };
}

export function inspectStagedLibrary(database: Database): StagedLibrary | null {
  const marker = database.selectValue('pragma user_version');
  const version = marker === 4 || marker === 5 ? marker : SCHEMA_VERSION;
  const seal = readSeal(database, version);
  if (!seal) return null;
  const { id, sourceVersion, pages, processing } = seal;
  verifyCounts(database, { pages, processing });
  return { id, sourceVersion, pages, processing };
}

function encodeRecord(record: PageRecord | ProcessingEntry): string {
  return JSON.stringify(record, function (key, value: unknown) {
    const original = (this as Record<string, unknown>)[key];
    if (original === null || typeof original === 'string' || typeof original === 'boolean') return value;
    if (original === undefined && !Array.isArray(this)) return undefined;
    if (typeof original === 'number' && Number.isFinite(original)) {
      if (Object.is(original, -0)) return (JSON as JSON & { rawJSON: (text: string) => unknown }).rawJSON('-0');
      return original;
    }
    if (Array.isArray(original)) return original;
    if (original && typeof original === 'object') {
      const prototype: object | null = Object.getPrototypeOf(original);
      if (prototype === null || Object.getPrototypeOf(prototype) === null) return original;
    }
    throw new Error('The saved library has a record that cannot be copied without losing data.');
  });
}

export function urlOrderKey(url: string): Uint8Array {
  const bytes = new Uint8Array(url.length * 2), view = new DataView(bytes.buffer);
  for (let offset = 0; offset < url.length; offset++) view.setUint16(offset * 2, url.charCodeAt(offset));
  return bytes;
}

export function putSqlitePage(database: Database, record: PageRecord): string {
  const encoded = encodeRecord(record);
  const order = urlOrderKey(record.url);
  database.exec(`insert into saved_pages values(?,?,?,?,?) on conflict(url) do update set
    captured_at=excluded.captured_at, title=excluded.title, record=excluded.record`,
    { bind: [record.url, record.timestamp, record.title, packSqlitePayload(encoded), order] });
  putSearchProjection(database, record, order);
  return encoded;
}

function putSearchProjection(database: Database, record: PageRecord, order: Uint8Array): void {
  database.exec('insert into saved_search values(?,?,?) on conflict(url_order) do update set record=excluded.record',
    { bind: [order, record.url, packSearchProjection(JSON.stringify(searchPageRecord(record)))] });
  database.exec('insert into saved_text_index values(?,?,?) on conflict(url_order) do update set hints=excluded.hints',
    { bind: [order, record.url, encodeTextIndex(record)] });
}

export function putSqliteJob(database: Database, entry: ProcessingEntry): string {
  const encoded = encodeRecord(entry);
  database.exec('insert into saved_processing values(?,?) on conflict(url) do update set record=excluded.record', { bind: [entry.url, encoded] });
  return encoded;
}

export function parseSqliteRecord<RecordType extends { url: string }>(value: unknown, url?: string): RecordType | undefined {
  if (value === undefined) return undefined;
  const record = JSON.parse(unpackSqlitePayload(value)) as RecordType;
  if (!record || typeof record.url !== 'string' || !record.url || (url !== undefined && record.url !== url)) throw new Error('Invalid saved record identity.');
  return record;
}

function createPageTables(database: Database): void {
  database.exec(`
    create table saved_pages(url text primary key not null, captured_at real not null,
      title text not null, record any not null check(typeof(record)='blob' or json_valid(record)),
      url_order blob not null) without rowid, strict;
    create index saved_pages_by_capture on saved_pages(captured_at desc, url desc);
    create unique index saved_pages_by_url_order on saved_pages(url_order);
    create table saved_search(url_order blob primary key not null, url text not null,
      record any not null check(typeof(record)='blob' or json_valid(record))) without rowid, strict;
  `);
  createTextIndex(database);
}

function createTextIndex(database: Database): void {
  database.exec('create table saved_text_index(url_order blob primary key not null, url text not null, hints blob not null) without rowid, strict');
}

function createProjectionTrigger(database: Database): void {
  database.exec('create trigger remove_search_projection after delete on saved_pages begin delete from saved_search where url_order=old.url_order; delete from saved_text_index where url_order=old.url_order; end;');
}

function createPageTriggers(database: Database): void {
  createProjectionTrigger(database);
  database.exec(`
    create trigger count_page_insert after insert on saved_pages begin update saved_library set pages=pages+1, page_revision=page_revision+1 where active=1; end;
    create trigger count_page_delete after delete on saved_pages begin update saved_library set pages=pages-1, page_revision=page_revision+1 where active=1; end;
    create trigger count_page_update after update on saved_pages begin update saved_library set page_revision=page_revision+1 where active=1; end;
  `);
}

function verifyCopiedPage(database: Database, page: PageRecord, encoded: string): void {
  if (unpackSqlitePayload(database.selectValue('select record from saved_pages where url=?', [page.url])) !== encoded ||
      unpackSqlitePayload(database.selectValue('select record from saved_search where url_order=?', [urlOrderKey(page.url)])) !== JSON.stringify(searchPageRecord(page))) {
    throw new Error('Cannot verify a copied saved page.');
  }
}

function upgradePageStorage(database: Database, id: string): void {
  const version = database.selectValue('pragma user_version');
  if (version !== 4 && version !== 5) return;
  const seal = readSeal(database, version);
  if (!seal || seal.id !== id) throw new Error('The saved library belongs to another migration.');
  verifyCounts(database, seal);
  if (version === 5) {
    createTextIndex(database);
    database.exec('delete from saved_search');
    const cursor = database.prepare('select url,record,url_order from saved_pages');
    try {
      while (cursor.step()) {
        const url = cursor.get(0);
        if (typeof url !== 'string') throw new Error('Invalid previous saved page identity.');
        const record = parseSqliteRecord<PageRecord>(cursor.get(1), url);
        if (!record) throw new Error('Missing previous saved page.');
        const order = cursor.get(2);
        if (!(order instanceof Uint8Array)) throw new Error('Invalid previous saved page order.');
        putSearchProjection(database, record, order);
      }
    } finally { cursor.finalize(); }
    verifyCounts(database, seal);
    database.exec('drop trigger remove_search_projection');
    createProjectionTrigger(database);
    database.exec('pragma user_version=' + SCHEMA_VERSION);
    return;
  }
  database.exec(`
    drop trigger count_page_insert;
    drop trigger count_page_delete;
    drop trigger count_page_update;
    drop index saved_pages_by_capture;
    drop index saved_pages_by_url_order;
    alter table saved_pages rename to saved_pages_v4;
  `);
  createPageTables(database);
  const previous = database.prepare('select url,record from saved_pages_v4');
  try {
    while (previous.step()) {
      const url = previous.get(0), raw = previous.get(1);
      if (typeof url !== 'string' || typeof raw !== 'string') throw new Error('Invalid previous saved library row.');
      const record = parseSqliteRecord<PageRecord>(raw, url);
      if (!record) throw new Error('Missing previous saved page.');
      putSqlitePage(database, record);
      verifyCopiedPage(database, record, raw);
    }
  } finally { previous.finalize(); }
  verifyCounts(database, seal);
  database.exec(`drop table saved_pages_v4; pragma user_version=${SCHEMA_VERSION};`);
  createPageTriggers(database);
}

export function activateSavedLibrary(database: Database, id: string): void {
  database.transaction(() => {
    upgradePageStorage(database, id);
    const seal = readSeal(database);
    if (!seal || seal.id !== id) throw new Error('The staged saved library is not available.');
    verifyCounts(database, seal);
    if (!seal.active) database.exec('update saved_library set active=1');
  });
}

export function stageBackupPage(database: Database, record: PageRecord): void {
  database.transaction(() => {
    if (database.selectValue('select 1 from saved_pages where url=?', [record.url]) !== undefined) throw new Error('Backup has duplicate saved pages.');
    const encoded = putSqlitePage(database, record);
    verifyCopiedPage(database, record, encoded);
  });
}

export function sealRecoveredLibrary(database: Database, id: string, pages: number): void {
  database.transaction(() => {
    const seal = readSeal(database);
    if (!seal || seal.id !== id || seal.active || !nonNegativeInteger(pages) || pages === 0) throw new Error('Choose a complete backup with saved pages.');
    verifyCounts(database, { pages, processing: 0 });
    database.exec('update saved_library set pages=?, active=1', { bind: [pages] });
  });
}

export function requireActiveLibrary(database: Database, id: string): void {
  const seal = readSeal(database);
  if (!seal || seal.id !== id || seal.active !== 1) throw new Error('The active saved library is not available.');
  verifyCounts(database, seal);
}

export async function stageSavedLibrary(database: Database, id: string, source: IDBDatabase | null): Promise<StagedLibrary> {
  if (!validLibraryId(id)) throw new Error('Invalid saved library identity.');
  if (database.selectValue('select count(*) from sqlite_schema') === 0) database.exec('pragma page_size=16384');
  database.exec('begin immediate');
  try {
    upgradePageStorage(database, id);
    const existing = inspectStagedLibrary(database);
    if (existing) {
      if (existing.id !== id) throw new Error('The saved library belongs to another migration.');
      database.exec('commit');
      return existing;
    }
    database.exec(`
      pragma user_version=${SCHEMA_VERSION};
      create table saved_library(id text primary key not null, source_version integer,
        pages integer not null, processing integer not null, active integer not null check(active in (0,1)),
        page_revision integer not null, job_revision integer not null) strict;
      create table saved_processing(url text primary key not null,
        record text not null check(json_valid(record))) without rowid, strict;
      create trigger count_job_insert after insert on saved_processing begin update saved_library set processing=processing+1, job_revision=job_revision+1 where active=1; end;
      create trigger count_job_delete after delete on saved_processing begin update saved_library set processing=processing-1, job_revision=job_revision+1 where active=1; end;
      create trigger count_job_update after update on saved_processing begin update saved_library set job_revision=job_revision+1 where active=1; end;
    `);
    createPageTables(database);
    createPageTriggers(database);

    const counts = source ? await visitSavedLibrarySnapshot(source, {
      page(record) {
        const encoded = putSqlitePage(database, record);
        verifyCopiedPage(database, record, encoded);
      },
      processing(entry) {
        const encoded = putSqliteJob(database, entry);
        if (database.selectValue('select record from saved_processing where url=?', [entry.url]) !== encoded) throw new Error('Cannot verify a copied capture job.');
      }
    }) : { pages: 0, processing: 0 };
    verifyCounts(database, counts);
    const sourceVersion = source?.version ?? null;
    database.exec('insert into saved_library values(?,?,?,?,0,0,0)', { bind: [id, sourceVersion, counts.pages, counts.processing] });
    database.exec('commit');
    return { id, sourceVersion, ...counts };
  } catch (error) {
    try { database.exec('rollback'); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'The saved library copy failed and rollback could not be confirmed.'); }
    throw error;
  }
}

export function readStagedPage(database: Database, id: string, url: string): PageRecord | null {
  if (inspectStagedLibrary(database)?.id !== id) throw new Error('The requested saved library is not available.');
  return parseSqliteRecord<PageRecord>(database.selectValue('select record from saved_pages where url=?', [url]), url) ?? null;
}
