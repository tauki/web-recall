import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { forceCloseDatabase, IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain, tick } from './helpers.mjs';

const url = 'https://example.test/saved';
const captured = { url, title: 'Saved article', text: 'Original evidence', timestamp: 10, manual: true, chunks: [{ text: 'Original evidence', embedding: [1, 0] }] };
const queued = { url, title: captured.title, status: 'queued', attempts: 0, lastAttemptAt: 0, createdAt: 10, updatedAt: 10, payload: { ...captured, chunks: ['Original evidence'] } };

async function database() {
  const factory = new IDBFactory();
  const writes = [];
  let abortStore;
  const indexedDB = {
    databases: () => factory.databases(),
    open(...args) {
      const request = factory.open(...args);
      request.addEventListener('success', () => {
        const db = request.result;
        const transaction = db.transaction.bind(db);
        db.transaction = (...parameters) => {
          const tx = transaction(...parameters);
          if (tx.mode === 'readwrite') {
            writes.push(tx);
            if (abortStore && tx.objectStoreNames.contains(abortStore)) {
              const store = tx.objectStore(abortStore);
              abortStore = undefined;
              for (const method of ['put', 'delete']) {
                const mutate = store[method].bind(store);
                store[method] = (...values) => {
                  const mutation = mutate(...values);
                  mutation.addEventListener('success', () => tx.abort(), { once: true });
                  return mutation;
                };
              }
            }
          }
          return tx;
        };
      });
      return request;
    }
  };
  const load = () => loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  return { mod: await load(), load, writes, factory, abortNext: store => { abortStore = store; } };
}

test('Chrome eviction protection is a required installation permission, not an optional user choice', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('unlimitedStorage'), 'Chrome requires unlimitedStorage to exempt IndexedDB and model caches from eviction');
});

test('after a browser-forced connection close, saved evidence and its pending job remain usable without reloading the extension', async testContext => {
  const { mod } = await database();
  await mod.savePageRecord(captured);
  await mod.savePageSummary(url, captured.text, 'An established overview.');
  await mod.appendProcessing(queued);
  const connection = await mod.openDatabase();
  const closed = new Promise(resolve => connection.addEventListener('close', resolve, { once: true }));
  forceCloseDatabase(connection);
  await closed;
  const [saved, job] = await Promise.all([mod.getPageRecord(url), mod.getProcessingEntry(url)]);
  testContext.after(async () => (await mod.openDatabase()).close());
  assert.equal(saved.text, captured.text);
  assert.equal(saved.summary, 'An established overview.');
  assert.deepEqual(plain(saved.chunks), captured.chunks);
  assert.deepEqual(plain(job.payload), queued.payload);
  await mod.deletePages([url]);
  assert.deepEqual(plain(await mod.listAllPages()), [], 'Intentional forgetting can still leave an empty library');
  const visible = [];
  await mod.scanSearchPages(record => visible.push(record));
  assert.deepEqual(visible, []);
});

test('a disappeared library is an error, not a fresh database or a successful empty read in the same runtime', async () => {
  const { mod, factory } = await database();
  await mod.savePageRecord(captured);
  const connection = await mod.openDatabase();
  const closed = new Promise(resolve => connection.addEventListener('close', resolve, { once: true }));
  forceCloseDatabase(connection);
  await closed;
  await new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(connection.name);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  const missing = /previously opened local library is missing/i;
  await assert.rejects(mod.listAllPages(), missing);
  await assert.rejects(mod.savePageRecord(captured), missing);
  assert.ok(!(await factory.databases()).some(entry => entry.name === connection.name), 'Neither the read nor write creates a replacement library');
});

test('library changes and accepted capture jobs request persistent-media durability', async () => {
  const fixture = await database();
  await fixture.mod.savePageRecord(captured);
  await fixture.mod.savePageSummary(url, captured.text, 'A saved overview.');
  await fixture.mod.appendProcessing(queued);
  await fixture.mod.updateProcessingEntry({ ...queued, status: 'processing' });
  await fixture.mod.deleteProcessing(url);
  await fixture.mod.deletePages([url]);
  assert.ok(fixture.writes.length > 0);
  for (const transaction of fixture.writes) {
    assert.equal(transaction.durability, 'strict', `${Array.from(transaction.objectStoreNames).join(', ')} must flush before acknowledging a library or queue change`);
  }
  (await fixture.mod.openDatabase()).close();
});

test('an aborted capture cannot replace the last committed page, vectors, summary or retry payload', async () => {
  const fixture = await database();
  await fixture.mod.savePageRecord(captured);
  await fixture.mod.savePageSummary(url, captured.text, 'Original overview.');
  await fixture.mod.appendProcessing(queued);
  fixture.abortNext('pages');
  await assert.rejects(fixture.mod.savePageRecord({ ...captured, text: 'Replacement evidence', chunks: [{ text: 'Replacement evidence', embedding: [0, 1] }] }, { discardProcessing: true }), /abort/i);
  (await fixture.mod.openDatabase()).close();
  const reopened = await fixture.load();
  const saved = await reopened.getPageRecord(url);
  assert.equal(saved.text, 'Original evidence');
  assert.equal(saved.summary, 'Original overview.');
  assert.deepEqual(plain(saved.chunks[0].embedding), [1, 0]);
  assert.deepEqual(plain((await reopened.getProcessingEntry(url)).payload), queued.payload);
  const db = await reopened.openDatabase();
  db.close();
});

test('aborted capture admission and removal reject instead of hanging or reporting success', async () => {
  const fixture = await database();
  await fixture.mod.openDatabase();
  fixture.abortNext('processing');
  await assert.rejects(fixture.mod.appendProcessing(queued), /abort/i);
  assert.equal(await fixture.mod.getProcessingEntry(url), undefined);
  await fixture.mod.appendProcessing(queued);
  fixture.abortNext('processing');
  await assert.rejects(fixture.mod.deleteProcessing(url), /abort/i);
  assert.equal((await fixture.mod.getProcessingEntry(url)).status, 'queued');
  (await fixture.mod.openDatabase()).close();
});

test('storage readiness shares initialization, reports failures, and allows a later retry', async () => {
  let rejectOpen;
  let attempts = 0;
  let migrations = 0;
  const opening = new Promise((_resolve, reject) => { rejectOpen = reject; });
  const backend = {};
  const mod = await loadSource('src/background/storage/index.ts', '', {
    '../../shared/db/index': {
      migrateLegacySnapshotIfNeeded: async () => { migrations++; }, listLogs() {}, clearLogs() {}
    },
    './libraryActivation': { async openSqliteAuthority(prepare) { attempts++; if (attempts === 1) await opening; await prepare(); return { id: 'active-library', source: 'indexeddb' }; } },
    './retireLegacy': { retireLegacySavedData: async () => {} },
    './sqlite': { createSqliteBackend: () => backend }
  });
  const first = mod.whenStorageReady();
  const second = mod.whenStorageReady();
  const failed = Promise.all([assert.rejects(first, /disk unavailable/), assert.rejects(second, /disk unavailable/)]);
  await tick();
  assert.equal(attempts, 1);
  rejectOpen(Error('disk unavailable'));
  await failed;
  assert.equal(migrations, 0);
  assert.equal(await mod.whenStorageReady(), backend);
  assert.equal(attempts, 2);
  assert.equal(migrations, 1);
});
