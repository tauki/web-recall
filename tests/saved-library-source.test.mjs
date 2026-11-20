import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { loadSource, plain } from './helpers.mjs';

const url = 'https://memory.example/article';
const queuedUrl = 'https://memory.example/waiting';
const original = {
  url, title: 'Saved field notes', timestamp: 200, manual: true, text: 'The evidence uses café and spruce 🌲.',
  createdAt: 100, updatedAt: 210, lastEmbeddedAt: 205, summary: 'A previous local summary.',
  chunks: [{ text: 'The evidence uses café and spruce 🌲.', embedding: [0.25, -0.75], embeddingKey: 'example-model@1' }],
  versionId: 'second', captureInfo: { kind: 'complete' },
  versions: [{ versionId: 'first', title: 'Earlier notes', text: 'Keep this earlier evidence.', timestamp: 100, kept: true,
    chunks: [{ text: 'Keep this earlier evidence.', embedding: [0.1, 0.9], embeddingKey: 'example-model@1' }], summary: 'Original summary.' }]
};
const queued = {
  url: queuedUrl, title: 'Awaiting storage', status: 'queued', attempts: 1, lastAttemptAt: 315, createdAt: 300, updatedAt: 317,
  payload: { url: queuedUrl, title: 'Awaiting storage', timestamp: 300, chunks: ['This pending page was not written.'], text: 'This pending page was not written.', captureId: 'queued-capture' }
};

async function fixture(context) {
  const migration = await loadSource('src/shared/db/savedLibrarySource.ts');
  const factory = new IDBFactory();
  const database = await new Promise((resolve, reject) => {
    const request = factory.open('saved-library-source', 4);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages', { keyPath: 'url' });
      request.result.createObjectStore('processing', { keyPath: 'url' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  context.after(() => database.close());
  const write = (page, job) => new Promise((resolve, reject) => {
    const transaction = database.transaction(['pages', 'processing'], 'readwrite');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.objectStore('pages').put(page);
    transaction.objectStore('processing').put(job);
  });
  await write(original, queued);
  return { database, visit: migration.visitSavedLibrarySnapshot, write };
}

async function observe({ database, visit }, onFirstPage) {
  const pages = [], processing = [];
  const counts = await visit(database, {
    page(record) { pages.push(record); onFirstPage?.(); },
    processing(job) { processing.push(job); }
  });
  return { pages, processing, counts: plain(counts) };
}

test('migration observes one consistent library snapshot even while another writer updates both stores', async context => {
  const source = await fixture(context);
  const revised = { ...original, summary: 'A later summary.', updatedAt: 420 };
  const revisionJob = { ...queued, status: 'failed', attempts: 2, updatedAt: 421 };
  let pending;
  const snapshot = await observe(source, () => { pending ??= source.write(revised, revisionJob); });
  await pending;
  assert.deepEqual(snapshot, { pages: [original], processing: [queued], counts: { pages: 1, processing: 1 } });
  assert.deepEqual(await observe(source), { pages: [revised], processing: [revisionJob], counts: { pages: 1, processing: 1 } });
});

test('a rejected destination row aborts migration without changing or upgrading the source', async context => {
  const source = await fixture(context);
  const destinationError = new Error('Destination journal could not be written');
  await assert.rejects(source.visit(source.database, {
    page() { throw destinationError; }, processing() {}
  }), error => error === destinationError);
  assert.equal(source.database.version, 4);
  assert.deepEqual(await observe(source), { pages: [original], processing: [queued], counts: { pages: 1, processing: 1 } });
});

test('migration rejects asynchronous consumers at the snapshot boundary without an unhandled rejection', async context => {
  const source = await fixture(context);
  await assert.rejects(source.visit(source.database, {
    async page() { throw new Error('A mistaken asynchronous destination'); }, processing() {}
  }), /Consume snapshot records synchronously/u);
  assert.deepEqual(await observe(source), { pages: [original], processing: [queued], counts: { pages: 1, processing: 1 } });
});
