import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { loadSource, plain, chromeFixture } from './helpers.mjs';

const url = 'https://library.test/evidence';
const page = { url, title: 'Coastal notes', text: 'Copper terns nest above the tide.', timestamp: 20, manual: true, versionId: 'current', chunks: [{ text: 'Copper terns nest above the tide.', embedding: [0.2, 0.8] }], versions: [{ title: 'Earlier notes', text: '', timestamp: 10, versionId: 'earlier', chunks: [{ text: 'Silver herons follow the river.', embedding: [0.7, 0.3] }] }] };

async function textRecords(db) {
  const records = []; await db.scanSearchPages(record => records.push(record)); return records;
}

async function fixture(testContext, indexedDB = new IDBFactory()) {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  const connection = await db.openDatabase(); testContext.after(() => connection.close());
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager: db } }, { chrome: chromeFixture });
  const chrome = { ...chromeFixture, storage: { ...chromeFixture.storage, onChanged: { addListener() {} } } };
  const search = await loadSource('src/background/search/index.ts', '', { '../storage/manager': { storageManager: db }, '../processing/automaticAi': { runAutomaticAi: async () => undefined, stopAutomaticAi() {} } }, { chrome });
  return { db, connection, processing, search, find: async query => plain(await search.searchStoredPages(query, 20)) };
}

test('text-only lookup preserves whole current and chunk-only historical evidence without loading vectors', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(page);
  const [current] = await state.find('"copper terns"'), [earlier] = await state.find('"silver herons"');
  assert.equal(current.url, url); assert.equal(current.versionId, 'current'); assert.equal(current.timestamp, 20);
  assert.equal(earlier.url, url); assert.equal(earlier.versionId, 'earlier'); assert.equal(earlier.timestamp, 10);
  assert.match(earlier.snippet, /Silver herons follow the river/);
  const [lightweight] = await textRecords(state.db);
  assert.deepEqual(plain(lightweight.chunks), []); assert.deepEqual(plain(lightweight.versions[0].chunks), []);
  assert.equal(lightweight.text, page.text); assert.equal(lightweight.versions[0].text, page.versions[0].chunks[0].text);
  assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks), page.chunks);
});

test('model-free retrieval and its final version recheck never read source records containing vectors', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(page);
  const reads = [], originals = new Map(['get', 'getAll', 'openCursor'].map(method => [method, IDBObjectStore.prototype[method]]));
  for (const [method, original] of originals) IDBObjectStore.prototype[method] = function (...args) {
    if (this.name === state.db.PAGES_STORE) reads.push(method);
    return original.apply(this, args);
  };
  let results;
  try { results = await state.find('copper terns'); }
  finally { for (const [method, original] of originals) IDBObjectStore.prototype[method] = original; }
  assert.deepEqual(reads, []); assert.equal(results[0].versionId, 'current'); assert.equal(results[0].timestamp, 20);
  assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks), page.chunks);
});

test('acknowledged recaptures update searchable text and retain only the current retention policy history', async testContext => {
  const state = await fixture(testContext);
  const capture = async number => { await state.processing.markQueued({ url, title: 'Field notebook', text: `Revision ${number}: coastal observations.`, timestamp: number, chunks: [`Revision ${number}: coastal observations.`], manual: true }, 0); await state.processing.markDone(url); };
  await capture(1); const original = await state.db.getPageRecord(url);
  await state.db.updateSavedVersion(url, original.versionId, 'keep');
  for (let number = 2; number <= 8; number++) await capture(number);
  assert.equal((await state.find('"Revision 8:"'))[0].versionId, (await state.db.getPageRecord(url)).versionId);
  assert.equal((await state.find('"Revision 1:"'))[0].versionId, original.versionId);
  assert.deepEqual(await state.find('"Revision 2:"'), []);
  await state.db.updateSavedVersion(url, original.versionId, 'delete');
  assert.deepEqual(await state.find('"Revision 1:"'), []);
});

test('forgetting only reviewed matching versions atomically promotes surviving evidence in text search', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(page);
  await state.db.forgetPageVersions([{ url, versionIds: ['current'] }], { from: 20, before: 21 });
  assert.deepEqual(await state.find('"copper terns"'), []);
  const [survivor] = await state.find('"silver herons"');
  assert.equal(survivor.versionId, 'earlier'); assert.equal(survivor.timestamp, 10);
  await state.db.deletePages([url]);
  assert.deepEqual(await state.find('"silver herons"'), []); assert.deepEqual(plain(await textRecords(state.db)), []);
});

test('atomic replacement discards old searchable history and a rejected compare-and-swap cannot leak proposed text', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(page);
  const existing = await state.db.getPageRecord(url);
  await assert.rejects(state.db.savePageRecord({ ...existing, text: 'Uncommitted replacement.', chunks: [], versions: [] }, { expectedUpdatedAt: existing.updatedAt - 1 }));
  assert.deepEqual(await state.find('"uncommitted replacement"'), []); assert.equal((await state.find('"copper terns"')).length, 1);
  await state.db.savePageRecord({ ...existing, text: 'Restored mountain evidence.', chunks: [], versions: [], versionId: 'restored' }, { replace: true });
  assert.deepEqual(await state.find('"copper terns"'), []); assert.deepEqual(await state.find('"silver herons"'), []);
  assert.equal((await state.find('"restored mountain"'))[0].versionId, 'restored');
});

test('failed derived-text writes abort the source and capture job together rather than acknowledging an unsearchable save', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(page);
  const transaction = state.connection.transaction.bind(state.connection);
  let injected = 0;
  state.connection.transaction = (...args) => {
    const current = transaction(...args);
    if (args[1] !== 'readwrite' || !Array.from(current.objectStoreNames).includes(state.db.SEARCH_STORE)) return current;
    const objectStore = current.objectStore.bind(current);
    current.objectStore = name => {
      const store = objectStore(name);
      if (name === state.db.SEARCH_STORE) {
        const put = store.put.bind(store);
        store.put = (...values) => { const request = put(...values); request.addEventListener('success', () => { injected++; current.abort(); }); return request; };
      }
      return store;
    };
    return current;
  };
  await assert.rejects(state.processing.markQueued({ url, title: 'Changed notebook', text: 'Must not be acknowledged.', timestamp: 30, chunks: ['Must not be acknowledged.'], manual: true }, 0));
  state.connection.transaction = transaction;
  assert.ok(injected > 0); assert.equal((await state.db.getPageRecord(url)).text, page.text);
  assert.equal(await state.db.getProcessingEntry(url), undefined);
  assert.deepEqual(await state.find('"must not be acknowledged"'), []); assert.equal((await state.find('"copper terns"')).length, 1);
});

async function seedReleasedDatabase(indexedDB) {
  const old = await new Promise((resolve, reject) => {
    const request = indexedDB.open('webRecallBeta', 4);
    request.onupgradeneeded = () => {
      const database = request.result;
      const pages = database.createObjectStore('pages', { keyPath: 'url' }); pages.createIndex('timestamp', 'timestamp'); pages.createIndex('manual', 'manual'); pages.createIndex('recentMetadata', ['timestamp', 'url', 'title']);
      database.createObjectStore('migrations', { keyPath: 'key' }); database.createObjectStore('processing', { keyPath: 'url' }); database.createObjectStore('logs', { keyPath: 'id', autoIncrement: true }); database.createObjectStore('highlights', { keyPath: 'date' });
      database.createObjectStore('embeddings', { keyPath: 'key' }).createIndex('pageUrl', 'pageUrl');
      request.transaction.objectStore('pages').put(page);
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  old.close();
}

test('upgrading the released version-four database makes existing text and history searchable without inference or recapture', async testContext => {
  const indexedDB = new IDBFactory(); await seedReleasedDatabase(indexedDB);
  const state = await fixture(testContext, indexedDB);
  assert.equal((await state.find('"copper terns"'))[0].versionId, 'current'); assert.equal((await state.find('"silver herons"'))[0].versionId, 'earlier');
  const source = await state.db.getPageRecord(url); assert.equal(source.text, page.text); assert.deepEqual(plain(source.chunks), page.chunks);
  assert.deepEqual(plain(source.versions), page.versions);
});

test('an interrupted derived-text upgrade preserves the released database and safely retries without losing saved evidence', async testContext => {
  const indexedDB = new IDBFactory(); await seedReleasedDatabase(indexedDB);
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  const put = IDBObjectStore.prototype.put;
  let interrupted = 0;
  IDBObjectStore.prototype.put = function (...values) {
    const request = put.apply(this, values);
    if (this.name === db.SEARCH_STORE && this.transaction.mode === 'versionchange') request.addEventListener('success', () => { interrupted++; this.transaction.abort(); });
    return request;
  };
  try { await assert.rejects(db.openDatabase(), /abort/i); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(interrupted, 1);
  const old = await new Promise((resolve, reject) => { const request = indexedDB.open('webRecallBeta', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  assert.equal(old.objectStoreNames.contains(db.SEARCH_STORE), false);
  const source = await new Promise((resolve, reject) => { const request = old.transaction('pages').objectStore('pages').get(url); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  assert.deepEqual(source, page); old.close();
  const connection = await db.openDatabase(); testContext.after(() => connection.close());
  const [restored] = await textRecords(db);
  assert.equal(restored.text, page.text); assert.equal(restored.versions[0].text, page.versions[0].chunks[0].text);
});

test('search visits the whole library through bounded reads and still finds old historical evidence at the final URL', async testContext => {
  const state = await fixture(testContext);
  const count = 1100;
  for (let index = 0; index < count; index++) await state.db.savePageRecord({ url: `https://library.test/page-${String(index).padStart(4, '0')}`, title: 'Ordinary saved page', text: 'Unrelated reading.', timestamp: index + 100, chunks: [] });
  const finalUrl = 'https://library.test/zz-last';
  await state.db.savePageRecord({ ...page, url: finalUrl, text: 'Revised observations.', chunks: [], timestamp: 50 });
  const getAll = IDBObjectStore.prototype.getAll, reads = [];
  IDBObjectStore.prototype.getAll = function (...args) {
    if (this.name === state.db.SEARCH_STORE) reads.push(args[1]);
    return getAll.apply(this, args);
  };
  const visited = [];
  let found;
  try {
    await state.db.scanSearchPages(record => visited.push(record.url));
    found = await state.find('"silver herons"');
  } finally { IDBObjectStore.prototype.getAll = getAll; }
  assert.equal(new Set(visited).size, count + 1); assert.equal(visited.at(-1), finalUrl);
  assert.ok(reads.every(limit => Number.isSafeInteger(limit) && limit > 0 && limit < count), 'No text-store bulk read may allocate the entire declared library');
  assert.equal(found[0].url, finalUrl); assert.equal(found[0].versionId, 'earlier'); assert.equal(found[0].timestamp, 10);
});

test('scoped text scans visit only selected pages and an explicitly empty scope visits nothing', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(page);
  await state.db.savePageRecord({ ...page, url: 'https://private.test/unrelated', title: 'Unrelated private page' });
  const selected = [], empty = [], reads = [], attempts = [];
  let phase = 'selected';
  const originals = new Map(['get', 'getAll', 'openCursor'].map(method => [method, IDBObjectStore.prototype[method]]));
  for (const [method, original] of originals) IDBObjectStore.prototype[method] = function (...args) {
    const request = original.apply(this, args);
    if (this.name === state.db.SEARCH_STORE) {
      attempts.push(phase);
      request.addEventListener('success', () => {
        const values = method === 'getAll' ? request.result : [method === 'openCursor' ? request.result?.value : request.result];
        for (const record of values) if (record) reads.push({ phase, url: record.url });
      });
    }
    return request;
  };
  try {
    await state.db.scanSearchPages(record => selected.push(record.url), { scopeUrls: [url, url, 'https://missing.test/'] });
    phase = 'empty';
    await state.db.scanSearchPages(record => empty.push(record.url), { scopeUrls: [] });
  } finally { for (const [method, original] of originals) IDBObjectStore.prototype[method] = original; }
  assert.deepEqual(selected, [url]); assert.deepEqual(empty, []);
  assert.deepEqual(reads, [{ phase: 'selected', url }], 'Unselected or duplicate text records must not cross the storage boundary');
  assert.ok(attempts.every(value => value === 'selected'), 'An empty selection must issue no text reads');
});

test('stopping or failing a scan rejects it and releases the reader without visiting later records', async testContext => {
  const state = await fixture(testContext);
  for (let index = 0; index < 350; index++) await state.db.savePageRecord({ ...page, url: `${url}/${index}` });
  const stopped = new AbortController(); stopped.abort(new Error('Stopped before opening'));
  await assert.rejects(state.db.scanSearchPages(() => assert.fail('An already stopped scan must not read'), { signal: stopped.signal }), /Stopped before opening/);
  const controller = new AbortController(); let visits = 0;
  await assert.rejects(state.db.scanSearchPages(() => { visits++; if (visits === 3) controller.abort(new Error('Stopped by user')); }, { signal: controller.signal }), /Stopped by user/);
  assert.equal(visits, 3);
  await assert.rejects(state.db.scanSearchPages(() => { throw Error('Visitor failed'); }), /Visitor failed/);
  const recovered = []; await state.db.scanSearchPages(record => recovered.push(record.url)); assert.equal(recovered.length, 350);
});

test('a scan observes one consistent library snapshot while concurrent recapture waits and becomes visible afterward', async testContext => {
  const state = await fixture(testContext);
  for (let index = 0; index < 350; index++) await state.db.savePageRecord({ ...page, url: `${url}/${String(index).padStart(3, '0')}` });
  const lastUrl = `${url}/349`;
  let replacement; const observed = [];
  await state.db.scanSearchPages(record => {
    if (!replacement) replacement = state.db.savePageRecord({ ...page, url: lastUrl, text: 'Replacement after the snapshot.', chunks: [] }, { replace: true });
    if (record.url === lastUrl) observed.push(record.text);
  });
  assert.deepEqual(observed, [page.text]); await replacement;
  const after = []; await state.db.scanSearchPages(record => after.push(record.text), { scopeUrls: [lastUrl] });
  assert.deepEqual(after, ['Replacement after the snapshot.']);
});

test('an aborted storage scan never publishes partial matches or a success and leaves saved evidence recoverable', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(page);
  for (let index = 1; index < 350; index++) await state.db.savePageRecord({ ...page, url: `${url}/${index}` });
  const getAll = IDBObjectStore.prototype.getAll, updates = [];
  let reads = 0;
  IDBObjectStore.prototype.getAll = function (...args) {
    const request = getAll.apply(this, args);
    if (this.name === state.db.SEARCH_STORE && ++reads === 2) request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await assert.rejects(state.search.searchStoredPages('"copper terns"', 5, { onTextResults: results => updates.push(plain(results)) })); }
  finally { IDBObjectStore.prototype.getAll = getAll; }
  assert.equal(reads, 2, 'The fault occurs after a completed first batch, while further reads are pending');
  assert.deepEqual(updates, []); assert.equal((await state.db.getPageRecord(url)).text, page.text);
  assert.equal((await state.find('"copper terns"'))[0].url, url);
});
