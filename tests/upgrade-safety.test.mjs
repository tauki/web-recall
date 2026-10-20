import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain } from './helpers.mjs';

const { DEFAULT_SETTINGS, DEFAULT_EMBEDDING_CONFIG, embeddingSpaceKey } = await loadSource('src/shared/config/index.ts');

async function settingsFixture(initial = {}) {
  const values = structuredClone(initial);
  const writes = [];
  let failWrite = false;
  let failRead = false;
  const chrome = { runtime: { sendMessage() {} }, storage: {
    onChanged: { addListener() {} },
    local: {
      get(keys, done) {
        const snapshot = structuredClone(Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]])));
        queueMicrotask(() => {
          if (failRead) chrome.runtime.lastError = new Error('Read failed');
          done(snapshot);
          delete chrome.runtime.lastError;
        });
      },
      set(update, done) {
        const snapshot = structuredClone(update);
        queueMicrotask(() => {
          if (failWrite) {
            failWrite = false;
            chrome.runtime.lastError = new Error('Write failed');
          } else {
            Object.assign(values, snapshot);
            writes.push(snapshot);
          }
          done();
          delete chrome.runtime.lastError;
        });
      }
    }
  } };
  const load = () => loadSource('src/background/settings/index.ts', '', {
    '../../shared/logger/index': { setLogLevel() {} }
  }, { chrome });
  const mod = await load();
  return { mod, values, writes, load, failNextWrite: () => { failWrite = true; }, setReadFailure: value => { failRead = value; } };
}

test('upgrade preserves legacy pause and domain rules before capture can resume', async () => {
  const f = await settingsFixture({ paused: true, whitelistDomains: [], blacklistDomains: [' Private.Test '] });
  const settings = await f.mod.getSettings();
  assert.equal(settings.paused, true);
  assert.equal(settings.captureSetupComplete, true);
  assert.deepEqual(plain(settings.denylist), ['private.test']);
  await f.mod.updateSettings({ paused: false });
  assert.equal(await f.mod.shouldCaptureUrl('https://private.test/secret'), false);
  assert.equal(await f.mod.shouldCaptureUrl('https://sub.private.test/secret', { ignorePaused: true }), false);
  assert.equal(await f.mod.shouldCaptureUrl('https://public.test'), true);
  assert.deepEqual(f.values.blacklistDomains, [' Private.Test '], 'keep original settings as an upgrade backup');
  assert.deepEqual(f.values.betaSettings.denylist, ['private.test']);
  const allow = await settingsFixture({ paused: false, whitelistDomains: ['Allowed.Test'], blacklistDomains: ['blocked.test'] });
  assert.equal((await allow.mod.getSettings()).paused, false);
  assert.equal(await allow.mod.shouldCaptureUrl('https://sub.allowed.test'), true);
  assert.equal(await allow.mod.shouldCaptureUrl('https://other.test'), false);
  assert.deepEqual(plain((await allow.mod.getSettings()).denylist), ['blocked.test']);
});

test('existing beta settings and later user choices take precedence over legacy keys', async () => {
  const f = await settingsFixture({ paused: true, blacklistDomains: ['old.test'], betaSettings: { ...plain(DEFAULT_SETTINGS), paused: false, denylist: [], theme: 'dark' } });
  assert.equal((await f.mod.getSettings()).theme, 'dark');
  assert.equal(await f.mod.shouldCaptureUrl('https://old.test'), true);
  assert.equal(f.writes.length, 0);
  const migrated = await settingsFixture({ paused: false, blacklistDomains: ['old.test'] });
  await migrated.mod.getSettings();
  await migrated.mod.updateSettings({ denylist: [] });
  const restarted = await migrated.load();
  assert.deepEqual(plain((await restarted.getSettings()).denylist), []);
});

test('fresh installations retain paused defaults without inventing legacy consent', async () => {
  const f = await settingsFixture();
  assert.deepEqual(plain(await f.mod.getSettings()), plain(DEFAULT_SETTINGS));
  assert.equal(await f.mod.shouldCaptureUrl('https://public.test'), false);
});

test('concurrent settings updates retain independent changes and capture policy', async () => {
  const f = await settingsFixture({ betaSettings: { ...plain(DEFAULT_SETTINGS), paused: false } });
  await f.mod.getSettings();
  await Promise.all([
    f.mod.updateSettings({ queryRewrite: false }),
    f.mod.updateSettings({ searchRerank: false }),
    f.mod.updateSettings({ paused: true, denylist: ['private.test'] }),
    f.mod.updateSettings({ theme: 'dark' })
  ]);
  const saved = await f.mod.getSettings();
  assert.equal(saved.queryRewrite, false);
  assert.equal(saved.searchRerank, false);
  assert.equal(saved.paused, true);
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(plain(saved.denylist), ['private.test']);
  assert.deepEqual(plain(f.mod.getCachedSettingsSnapshot()), f.values.betaSettings);
});

test('settings migration and immediate updates cannot overwrite each other', async () => {
  const f = await settingsFixture({ paused: false, whitelistDomains: ['allowed.test'], blacklistDomains: ['private.test'] });
  await Promise.all([f.mod.updateSettings({ paused: true }), f.mod.updateSettings({ theme: 'dark' })]);
  assert.equal(f.values.betaSettings.paused, true);
  assert.equal(f.values.betaSettings.theme, 'dark');
  assert.deepEqual(f.values.betaSettings.allowlist, ['allowed.test']);
  assert.deepEqual(f.values.betaSettings.denylist, ['private.test']);
  assert.equal(f.writes.length, 3, 'one migration followed by the two updates');
});

test('a failed settings write rejects only that update and later writes retain saved choices', async () => {
  const f = await settingsFixture({ betaSettings: { ...plain(DEFAULT_SETTINGS), denylist: ['private.test'] } });
  await f.mod.getSettings();
  f.failNextWrite();
  const results = await Promise.allSettled([f.mod.updateSettings({ queryRewrite: false }), f.mod.updateSettings({ theme: 'dark' })]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  const saved = await f.mod.getSettings();
  assert.equal(saved.queryRewrite, true);
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(plain(saved.denylist), ['private.test']);
});

test('storage read failures cannot replace capture policy with defaults', async () => {
  const f = await settingsFixture({ betaSettings: { ...plain(DEFAULT_SETTINGS), denylist: ['private.test'] } });
  await f.mod.getSettings();
  f.setReadFailure(true);
  await assert.rejects(f.mod.updateSettings({ theme: 'dark' }), /Read failed/);
  assert.equal(f.writes.length, 0);
  f.setReadFailure(false);
  assert.deepEqual(plain((await f.mod.getSettings()).denylist), ['private.test']);
});

async function seedLegacy(indexedDB, records) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('webMemoryDB', 4);
    request.onupgradeneeded = () => request.result.createObjectStore('pages', { keyPath: 'id', autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('pages', 'readwrite');
    records.forEach(record => tx.objectStore('pages').put(record));
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
  db.close();
}

const article = { url: 'https://legacy.test/article', title: 'Article', timestamp: 10, items: [{ text: 'Captured passage', embedding: [1, 0] }] };
const oversizedCases = [
  ['page text', { items: Array.from({ length: 200 }, () => ({ text: 'x'.repeat(3000), embedding: [1, 0] })) }],
  ['chunk count', { items: Array.from({ length: 513 }, () => ({ text: 'Passage', embedding: [1, 0] })) }],
  ['chunk text', { items: [{ text: 'x'.repeat(20_001), embedding: [1, 0] }] }],
  ['vector dimension', { items: [{ text: 'Passage', embedding: Array(4097).fill(0.01) }] }],
  ['title', { title: 't'.repeat(2049) }],
  ['summary', { summary: 's'.repeat(20_001) }],
  ['URL', { url: 'https://legacy.test/' + 'u'.repeat(4096) }]
];
for (const [field, oversized] of oversizedCases) {
  test(`legacy ${field} beyond import bounds survives upgrade while external imports remain bounded`, async () => {
    const indexedDB = new IDBFactory();
    const large = { ...article, ...oversized };
    const short = { ...article, url: 'https://short.test', timestamp: 20 };
    await seedLegacy(indexedDB, [large, short]);
    const mod = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
    assert.equal((await mod.listAllPages()).length, 2);
    const saved = await mod.getPageRecord(large.url);
    assert.equal(saved.text, large.items.map(item => item.text).join('\n\n'));
    assert.equal(saved.title, large.title);
    assert.equal(saved.summary, large.summary);
    assert.deepEqual(plain(saved.chunks), large.items);
    assert.equal((await mod.getPageRecord(short.url)).title, short.title);
    (await mod.openDatabase()).close();
    const normalizer = await loadSource('src/shared/db/records.ts');
    assert.throws(() => normalizer.normalizeImportedPage(large, 0), /exceeds/);
  });
}

test('large historical versions are retained even when the active version is small', async () => {
  const indexedDB = new IDBFactory();
  const old = { timestamp: 1, ...oversizedCases[0][1], summary: 's'.repeat(20_001) };
  await seedLegacy(indexedDB, [{ url: article.url, latestVersionIndex: 1, versions: [old, { timestamp: 2, items: article.items }] }]);
  const mod = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  const saved = await mod.getPageRecord(article.url);
  assert.equal(saved.text, article.items[0].text);
  assert.equal(saved.versions[0].text, old.items.map(item => item.text).join('\n\n'));
  assert.equal(saved.versions[0].summary, old.summary);
  assert.deepEqual(plain(saved.versions[0].chunks), old.items);
  (await mod.openDatabase()).close();
});

async function captureFixture(embeddingResult) {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  const config = { ...plain(DEFAULT_EMBEDDING_CONFIG) };
  const payload = { url: 'https://capture.test', title: 'Updated title', text: 'Same passage\n\nChanged passage', timestamp: 100, chunks: ['Same passage', 'Changed passage'] };
  const old = { ...payload, title: 'Old title', timestamp: 10, manual: false, lastEmbeddedAt: 5, chunks: [
    { text: 'Same passage', embedding: [1, 0], embeddingKey: 'previous-model' },
    { text: 'Old passage', embedding: [0, 1] }
  ] };
  await db.savePageRecord(old);
  await db.updateProcessingEntry({ url: payload.url, title: payload.title, status: 'queued', attempts: 0, lastAttemptAt: 1, createdAt: 1, updatedAt: 1, payload }, true);
  let invalidations = 0;
  const processor = await loadSource('src/background/capture/processor.ts', '', {
    '../embeddings/index': { getEmbeddingConfig: () => config, embedPayloadChunks: async () => embeddingResult({ db, config, old, payload }) },
    '../storage/index': { whenStorageReady: async () => {} },
    '../storage/manager': { storageManager: db },
    '../offscreen/index': { invalidateOffscreenIndex: async () => { invalidations++; } }
  }, { console: { warn() {}, info() {} } });
  return { db, config, payload, old, processor, invalidations: () => invalidations };
}

test('failed recapture preserves exact matching vectors and their model identity in both stores', async () => {
  const f = await captureFixture(async () => { throw Error('Provider offline'); });
  // Reordered chunks must retain the vector belonging to their text, not their index.
  f.payload.chunks = ['Changed passage', 'Same passage', 'Old passage'];
  await f.processor.processCapturePayload(f.payload);
  const saved = await f.db.getPageRecord(f.payload.url);
  assert.deepEqual(plain(saved.chunks), [
    { text: 'Changed passage', embedding: [] },
    f.old.chunks[0],
    f.old.chunks[1]
  ]);
  assert.equal(saved.timestamp, 100);
  assert.equal(saved.title, 'Updated title');
  assert.equal(saved.lastEmbeddedAt, 5, 'retaining vectors is not a new embedding run');
  const db = await f.db.openDatabase();
  const vectors = await new Promise(resolve => { const r = db.transaction('embeddings').objectStore('embeddings').getAll(); r.onsuccess = () => resolve(r.result); });
  assert.deepEqual(vectors.map(({ text, embedding, embeddingKey }) => plain({ text, embedding, embeddingKey })), plain(saved.chunks));
  assert.equal(f.invalidations(), 1);
  db.close();
});

test('partial recapture responses preserve only matching missing chunks', async () => {
  const f = await captureFixture(async () => [[], [0.5, 0.5]]);
  await f.processor.processCapturePayload(f.payload);
  const saved = await f.db.getPageRecord(f.payload.url);
  assert.deepEqual(plain(saved.chunks[0]), f.old.chunks[0]);
  assert.deepEqual(plain(saved.chunks[1]), { text: 'Changed passage', embedding: [0.5, 0.5], embeddingKey: embeddingSpaceKey(f.config) });
  assert.ok(saved.lastEmbeddedAt > 5);
  (await f.db.openDatabase()).close();
});

test('successful recapture replaces saved vectors with the selected model', async () => {
  const f = await captureFixture(async () => [[0.2, 0.8], [0.5, 0.5]]);
  await f.processor.processCapturePayload(f.payload);
  const saved = await f.db.getPageRecord(f.payload.url);
  assert.deepEqual(plain(saved.chunks.map(chunk => chunk.embedding)), [[0.2, 0.8], [0.5, 0.5]]);
  assert.ok(saved.chunks.every(chunk => chunk.embeddingKey === embeddingSpaceKey(f.config)));
  assert.ok(saved.lastEmbeddedAt > 5);
  (await f.db.openDatabase()).close();
});

test('a failed recapture retains vectors saved while inference was running', async () => {
  const f = await captureFixture(async ({ db, old }) => {
    await db.savePageRecord({ ...old, chunks: [{ text: 'Same passage', embedding: [0.5, 0.5], embeddingKey: 'newer-model' }], lastEmbeddedAt: 50 });
    throw Error('Provider offline');
  });
  await f.processor.processCapturePayload(f.payload);
  const saved = await f.db.getPageRecord(f.payload.url);
  assert.deepEqual(plain(saved.chunks[0]), { text: 'Same passage', embedding: [0.5, 0.5], embeddingKey: 'newer-model' });
  assert.equal(saved.lastEmbeddedAt, 50);
  (await f.db.openDatabase()).close();
});

test('capture writes merge missing vectors with a concurrently committed backfill', async () => {
  const f = await captureFixture(async () => []);
  const newer = { text: 'Same passage', embedding: [0.3, 0.7], embeddingKey: 'newer-model' };
  await Promise.all([
    f.db.savePageRecord({ ...f.old, chunks: [newer], lastEmbeddedAt: 50 }),
    f.db.savePageRecord({ ...f.payload, manual: false, chunks: f.payload.chunks.map(text => ({ text, embedding: [] })) }, { requireProcessing: true, preserveMissingEmbeddings: true })
  ]);
  const saved = await f.db.getPageRecord(f.payload.url);
  assert.deepEqual(plain(saved.chunks[0]), newer);
  assert.equal(saved.lastEmbeddedAt, 50);
  assert.equal(saved.timestamp, f.payload.timestamp);
  (await f.db.openDatabase()).close();
});

test('capture failures preserve new text without resurrecting a page deleted during inference', async () => {
  const f = await captureFixture(async ({ db, payload }) => { await db.deletePages([payload.url]); throw Error('Provider offline'); });
  await assert.rejects(f.processor.processCapturePayload(f.payload), /aborted/i);
  assert.equal(await f.db.getPageRecord(f.payload.url), undefined);
  (await f.db.openDatabase()).close();
  const fresh = await captureFixture(async () => { throw Error('Provider offline'); });
  fresh.payload.url = 'https://new.test';
  await fresh.db.updateProcessingEntry({ url: fresh.payload.url, title: fresh.payload.title, status: 'queued', attempts: 0, lastAttemptAt: 1, createdAt: 1, updatedAt: 1, payload: fresh.payload }, true);
  await fresh.processor.processCapturePayload(fresh.payload);
  assert.ok((await fresh.db.getPageRecord(fresh.payload.url)).chunks.every(chunk => chunk.embedding.length === 0));
  (await fresh.db.openDatabase()).close();
});
