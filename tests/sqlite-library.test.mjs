import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import initializeSqlite from '@sqlite.org/sqlite-wasm';
import { loadSource } from './helpers.mjs';
import { previousLayout } from './fixtures/previous-sqlite-layout.mjs';

const sqlite = await initializeSqlite();
const fixtureId = '948e480c-bafd-4d1d-bdcb-64a7d7f31095';
const competingId = '9610102a-c3ae-4ea1-b23d-4343a04467a1';
const url = 'https://library.example/page';
const jobUrl = 'https://library.example/retry';
const text = 'The recovered field note includes café and spruce 🌲.\n'.repeat(1200);
const page = {
  url, title: 'A saved article', text, timestamp: 200, createdAt: 90, updatedAt: 210, manual: true, versionId: 'current',
  summary: 'A locally generated summary.', chunks: [{ text: 'Current excerpt', embedding: [-0, 0.4], embeddingKey: 'local-model@2' }],
  versions: [{ versionId: 'retained', timestamp: 100, text: 'Earlier evidence.', kept: true, summary: 'Earlier summary', chunks: [{ text: 'Earlier excerpt', embedding: [0.6, 0.8] }] }]
};
const pending = { url: jobUrl, title: 'Unfinished capture', status: 'queued', attempts: 1, createdAt: 150, updatedAt: 150, lastAttemptAt: 0,
  payload: { url: jobUrl, title: 'Unfinished capture', timestamp: 150, captureId: 'resume-me', chunks: ['Unfinished'], text: 'Unfinished' } };

async function sourceFixture(context, records) {
  const factory = new IDBFactory();
  const sourceReader = await loadSource('src/shared/db/savedLibrarySource.ts', '', {}, { indexedDB: factory });
  const database = await new Promise((resolve, reject) => {
    const request = factory.open('webRecallBeta', 5);
    request.onupgradeneeded = () => {
      for (const name of ['pages', 'processing', 'pageText']) request.result.createObjectStore(name, { keyPath: 'url' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  context.after(() => database.close());
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(['pages', 'processing'], 'readwrite');
    for (const record of records) transaction.objectStore('pages').put(record);
    transaction.objectStore('processing').put(pending);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  return sourceReader;
}

test('inspecting a missing migration source does not create a legacy database', async () => {
  const factory = new IDBFactory();
  const source = await loadSource('src/shared/db/savedLibrarySource.ts', '', {}, { indexedDB: factory });
  assert.equal(await source.openExistingSavedLibrary(), null);
  assert.deepEqual(await factory.databases(), []);
});

test('the staged authority verifies source history, vector values and independent queued work without rewriting the legacy library', async context => {
  const { stageSavedLibrary, inspectStagedLibrary, readStagedPage } = await loadSource('src/shared/db/sqliteLibrary.ts');
  const sourceReader = await sourceFixture(context, [page]);
  const source = await sourceReader.openExistingSavedLibrary();
  context.after(() => source.close());
  const target = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => target.close());
  assert.equal(inspectStagedLibrary(target), null);
  const expected = { id: fixtureId, sourceVersion: 5, pages: 1, processing: 1 };
  assert.deepEqual(structuredClone(await stageSavedLibrary(target, fixtureId, source)), expected);
  assert.deepEqual(structuredClone(inspectStagedLibrary(target)), expected);
  assert.deepEqual(structuredClone(readStagedPage(target, fixtureId, url)), page);
  assert.equal(readStagedPage(target, fixtureId, jobUrl), null);
  assert.deepEqual(JSON.parse(target.selectValue('select record from saved_processing where url=?', [jobUrl])), pending);
  assert.deepEqual(structuredClone(await stageSavedLibrary(target, fixtureId, source)), expected, 'Retry the same logical migration without rewriting the target');
  await assert.rejects(stageSavedLibrary(target, competingId, source), /belongs to another migration/u);
  assert.throws(() => readStagedPage(target, competingId, url), /not available/u);
  const originals = [];
  await sourceReader.visitSavedLibrarySnapshot(source, { page(row) { originals.push(row); }, processing(row) { originals.push(row); } });
  assert.deepEqual(originals.sort((left, right) => left.url.localeCompare(right.url)), [page, pending]);
});

test('an unsupported stored value rolls back the entire copy and does not seal an empty library', async context => {
  const invalid = { ...page, url: 'https://library.example/z-last', chunks: [{ text: 'Invalid historic vector', embedding: [NaN] }] };
  const sourceReader = await sourceFixture(context, [page, invalid]);
  const source = await sourceReader.openExistingSavedLibrary();
  context.after(() => source.close());
  const target = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => target.close());
  const { inspectStagedLibrary, stageSavedLibrary } = await loadSource('src/shared/db/sqliteLibrary.ts');
  await assert.rejects(stageSavedLibrary(target, fixtureId, source), /cannot be copied without losing data/u);
  assert.equal(inspectStagedLibrary(target), null);
  assert.deepEqual(target.selectValues("select name from sqlite_schema where type='table'"), []);
  const remaining = [];
  assert.equal((await sourceReader.visitSavedLibrarySnapshot(source, { page(row) { remaining.push(row); }, processing() {} })).pages, 2);
  assert.deepEqual(remaining, [page, invalid]);
});

test('a completion marker with missing rows cannot certify the staged library or permit a stale retry', async context => {
  const sourceReader = await sourceFixture(context, [page]);
  const source = await sourceReader.openExistingSavedLibrary();
  context.after(() => source.close());
  const target = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => target.close());
  const { inspectStagedLibrary, stageSavedLibrary, readStagedPage } = await loadSource('src/shared/db/sqliteLibrary.ts');
  await stageSavedLibrary(target, fixtureId, source);
  target.exec('delete from saved_processing');
  assert.throws(() => inspectStagedLibrary(target), /library is incomplete/u);
  assert.throws(() => readStagedPage(target, fixtureId, url), /library is incomplete/u);
  await assert.rejects(stageSavedLibrary(target, fixtureId, source), /library is incomplete/u);
  assert.equal(target.selectValue('select count(*) from saved_processing'), 0, 'Do not replace a damaged authority from a potentially stale source');
});

function previousSqliteFixture(context, raw) {
  const database = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => database.close());
  database.exec(previousLayout);
  database.exec('insert into saved_pages values(?,?,?,?,?,?)', { bind: [url, page.timestamp, page.title, raw, '{}', new Uint8Array([0, 1])] });
  database.exec('insert into saved_processing values(?,?)', { bind: [jobUrl, JSON.stringify(pending)] });
  database.exec('insert into saved_library values(?,4,1,1,1,17,9)', { bind: [fixtureId] });
  return database;
}

test('an existing active SQLite library keeps its full evidence and retry job when compacted, and deletes its independent search projection with the page', async context => {
  const expected = { ...page, title: 'Résumé 🐦 with Unicode', metadata: { bill: 'legacy extension field' } };
  const bytes = JSON.stringify(expected).replace('"embedding":[0,0.4]', '"embedding":[-0,0.4]');
  const database = previousSqliteFixture(context, bytes);
  const { activateSavedLibrary } = await loadSource('src/shared/db/sqliteLibrary.ts');
  const { SqliteRecords } = await loadSource('src/shared/db/sqliteRecords.ts');
  await assert.rejects(async () => activateSavedLibrary(database, competingId), /belongs to another migration/u);
  activateSavedLibrary(database, fixtureId);
  const records = new SqliteRecords(database, fixtureId);
  assert.deepEqual(structuredClone(records.page(url)), expected);
  assert.equal(records.page(url, true).text, expected.text);
  assert.deepEqual(structuredClone(records.job(jobUrl)), pending);
  assert.equal(records.batch('pages').revision, 17);
  assert.ok(database.selectValue('select length(record) from saved_pages') < Buffer.byteLength(bytes) / 2);
  assert.equal(records.delete([url]).deleted, 1);
  assert.equal(records.page(url, true), undefined);
  assert.deepEqual(structuredClone(records.job(jobUrl)), pending);
});

test('an identity mismatch during the format upgrade leaves the original library transactionally intact', async context => {
  const raw = JSON.stringify({ ...page, url: 'https://different.example/' });
  const database = previousSqliteFixture(context, raw);
  const { activateSavedLibrary } = await loadSource('src/shared/db/sqliteLibrary.ts');
  assert.throws(() => activateSavedLibrary(database, fixtureId), /Invalid saved record identity/u);
  assert.equal(database.selectValue('pragma user_version'), 4);
  assert.equal(database.selectValue('select record from saved_pages'), raw);
  assert.deepEqual(JSON.parse(database.selectValue('select record from saved_processing')), pending);
});

test('a damaged compact payload fails closed instead of returning a different saved page', async context => {
  const sourceReader = await sourceFixture(context, [page]);
  const source = await sourceReader.openExistingSavedLibrary();
  context.after(() => source.close());
  const database = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => database.close());
  const { stageSavedLibrary, readStagedPage } = await loadSource('src/shared/db/sqliteLibrary.ts');
  await stageSavedLibrary(database, fixtureId, source);
  const packed = database.selectValue('select record from saved_pages');
  assert.ok(packed instanceof Uint8Array);
  packed[packed.length - 2] ^= 2;
  database.exec('update saved_pages set record=? where url=?', { bind: [packed, url] });
  assert.throws(() => readStagedPage(database, fixtureId, url), /payload failed its checksum/u);
});

test('activating the previous compact format repairs its derived text from the canonical page without reimporting', async context => {
  const database = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => database.close());
  const { activateSavedLibrary, urlOrderKey } = await loadSource('src/shared/db/sqliteLibrary.ts');
  const { SqliteRecords } = await loadSource('src/shared/db/sqliteRecords.ts');
  database.exec(`
    pragma user_version=5;
    create table saved_library(id text primary key, source_version integer, pages integer, processing integer,
      active integer, page_revision integer, job_revision integer);
    create table saved_pages(url text primary key, captured_at real, title text, record any, url_order blob);
    create unique index saved_pages_by_url_order on saved_pages(url_order);
    create table saved_search(url_order blob primary key, url text, record any);
    create table saved_processing(url text primary key, record text);
    create trigger remove_search_projection after delete on saved_pages begin delete from saved_search where url_order=old.url_order; end;
  `);
  const order = urlOrderKey(url);
  const original = { ...page, chunks: [] };
  database.exec('insert into saved_pages values(?,?,?,?,?)', { bind: [url, page.timestamp, page.title, JSON.stringify(original), order] });
  database.exec('insert into saved_search values(?,?,?)', { bind: [order, url, new Uint8Array([1, 2, 3])] });
  database.exec('insert into saved_processing values(?,?)', { bind: [jobUrl, JSON.stringify(pending)] });
  database.exec('insert into saved_library values(?,5,1,1,1,17,9)', { bind: [fixtureId] });
  activateSavedLibrary(database, fixtureId);
  const records = new SqliteRecords(database, fixtureId);
  assert.deepEqual(structuredClone(records.page(url)), original);
  assert.deepEqual(structuredClone(records.job(jobUrl)), pending);
  assert.equal(records.batch('pages').revision, 17);
  const result = await records.run({ op: 'searchText', query: '"Earlier evidence"', limit: 1, filters: {} });
  assert.equal(result.results[0]?.versionId, 'retained');
});
