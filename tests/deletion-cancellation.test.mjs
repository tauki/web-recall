import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';
import { loadSource, plain, waitFor, tick } from './helpers.mjs';

const url = 'https://deletion.test/page';
const page = { url, title: 'Original saved source', text: 'Original protected evidence.', timestamp: 100, versionId: 'original', manual: true, summary: 'Original overview.', chunks: [{ text: 'Original protected evidence.', embedding: [1, 0], embeddingKey: 'saved-space' }] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const responseFor = operation => operation === 'BACKFILL_EMBEDDINGS' ? Response.json({ embeddings: [[0, 1]] }) : Response.json({ message: { content: 'Completed overview.' } });

async function scenario(testContext, operation, source = page) {
  const generation = deferred(), signals = [], backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts'); await db.savePageRecord(source);
  const runtime = await backend.load('src/background/orchestration/index.ts', { fetch: async (input, options = {}) => {
    const pathname = new URL(input).pathname;
    if (pathname === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (pathname === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 8192 }] });
    if (pathname === '/api/embed' || pathname === '/api/chat') { signals.push(options.signal); return generation.promise; }
    throw Error(`Unexpected provider request ${pathname}`);
  } });
  runtime.orchestrateLifecycle(); testContext.after(async () => (await db.openDatabase()).close());
  const pending = backend.send({ type: operation, url, urls: [url], force: true, requestId: `delete-${operation}` });
  await waitFor(() => signals.length === 1, 'saved-source inference');
  return { backend, db, pending, signals, finish: () => generation.resolve(responseFor(operation)), async recapture() {
    const processing = await backend.load('src/background/processing/index.ts');
    await processing.markQueued({ url, title: 'Retained new source', text: 'New unaffected evidence.', chunks: ['New unaffected evidence.'], timestamp: 200, manual: true, captureId: 'recapture' }, 0);
    await processing.markDone(url);
  } };
}

async function failNextMutation(database, testContext) {
  const connection = await database.openDatabase(), prototype = Object.getPrototypeOf(connection), original = prototype.transaction;
  let injected = false;
  prototype.transaction = function (...args) {
    const transaction = original.apply(this, args);
    if (!injected && transaction.mode === 'readwrite' && transaction.objectStoreNames.contains('pages')) {
      const store = transaction.objectStore('pages');
      for (const method of ['put', 'delete']) {
        const mutate = store[method].bind(store);
        store[method] = (...values) => { const request = mutate(...values); injected = true; request.addEventListener('success', () => transaction.abort(), { once: true }); return request; };
      }
    }
    return transaction;
  };
  testContext.after(() => { prototype.transaction = original; });
  return () => injected;
}

for (const operation of ['BACKFILL_EMBEDDINGS', 'REGENERATE_PAGE_SUMMARY']) for (const removal of ['page', 'history']) test(`${removal} removal cancels only committed ${operation} source work and rejects late writes`, async testContext => {
  const state = await scenario(testContext, operation);
  try {
    if (removal === 'history') await state.recapture();
    const before = plain(await state.db.getPageRecord(url));
    const result = await state.backend.send(removal === 'page' ? { type: 'DELETE_PAGE', url } : { type: 'UPDATE_SAVED_VERSION', url, versionId: 'original', action: 'delete' });
    assert.equal(result.error, undefined); assert.equal(state.signals[0].aborted, true);
    assert.doesNotMatch(JSON.stringify(result), /Original protected evidence/);
    const work = await state.pending;
    if (operation === 'BACKFILL_EMBEDDINGS') { assert.equal(work.result.updated, 0); assert.equal(work.result.failed, 1); }
    else assert.match(work.error, /forgotten/);
    state.finish(); await tick();
    const after = await state.db.getPageRecord(url);
    if (removal === 'page') { assert.equal(result.deleted, 1); assert.equal(after, undefined); }
    else { assert.equal(result.ok, true); assert.deepEqual(plain(after), { ...before, versions: [] }); }
  } finally { state.finish(); await state.pending; }
});

for (const operation of ['BACKFILL_EMBEDDINGS', 'REGENERATE_PAGE_SUMMARY']) for (const removal of ['page', 'history']) test(`an aborted ${removal} removal preserves ${operation} data and does not cancel its inference`, async testContext => {
  const state = await scenario(testContext, operation);
  try {
    if (removal === 'history') await state.recapture();
    const before = plain(await state.db.getPageRecord(url)), injected = await failNextMutation(state.db, testContext);
    const result = await state.backend.send(removal === 'page' ? { type: 'DELETE_PAGE', url } : { type: 'UPDATE_SAVED_VERSION', url, versionId: 'original', action: 'delete' });
    assert.match(result.error, /abort/i); assert.equal(injected(), true);
    assert.equal(state.signals[0].aborted, false); assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
  } finally { state.finish(); await state.pending; }
});

for (const action of ['keep', 'release']) test(`history ${action} never cancels retained source inference`, async testContext => {
  const state = await scenario(testContext, 'REGENERATE_PAGE_SUMMARY');
  try {
    await state.recapture();
    const response = await state.backend.send({ type: 'UPDATE_SAVED_VERSION', url, versionId: 'original', action });
    assert.equal(response.ok, true); assert.equal(state.signals[0].aborted, false);
    assert.equal((await state.db.getPageRecord(url)).versions[0].kept, action === 'keep');
  } finally { state.finish(); await state.pending; }
});

test('post-commit whole-page cancellation cannot stop a new same-URL source with identical text and capture time', async testContext => {
  const backend = providerFixture(), database = await backend.load('src/shared/db/index.ts');
  await database.savePageRecord(page); testContext.after(async () => (await database.openDatabase()).close());
  const work = await loadSource('src/background/processing/savedWork.ts');
  const oldGeneration = deferred(), nextGeneration = deferred(), signals = [];
  const original = await database.getPageRecord(url);
  let nextPending;
  const manage = await loadSource('src/background/manage/index.ts', '', {
    '../capture/index': { cancelCaptureJobs: async () => [] }, '../processing/savedWork': work,
    '../storage/manager': { storageManager: { ...database, deletePages: async (...args) => {
      const removed = await database.deletePages(...args);
      await database.savePageRecord({ ...page, versionId: 'new-generation' }, { replace: true });
      nextPending = work.runSavedWork(await database.getPageRecord(url), undefined, signal => { signals.push(signal); return nextGeneration.promise; });
      return removed;
    } } },
    '../embeddings/index': { getEmbeddingConfig: () => ({}) },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }, './recents': { invalidateRecentPages: async () => {} }
  });
  const oldPending = work.runSavedWork(original, undefined, signal => { signals.push(signal); return oldGeneration.promise; });
  const oldOutcome = oldPending.then(() => ({}), error => ({ error }));
  try {
    assert.equal(await manage.deleteManagePages([url]), 1);
    assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
    assert.match(String((await oldOutcome).error), /forgotten/);
    assert.equal((await database.getPageRecord(url)).versionId, 'new-generation');
  } finally { oldGeneration.resolve(); nextGeneration.resolve(); await oldOutcome; await nextPending; }
});

for (const operation of ['BACKFILL_EMBEDDINGS', 'REGENERATE_PAGE_SUMMARY']) test(`removing unrelated history preserves active ${operation} and does not resurrect the removed snapshot`, async testContext => {
  const state = await scenario(testContext, operation, { ...page, versions: [{ versionId: 'other-history', timestamp: 50, title: 'Earlier source', text: 'Earlier unrelated content.', chunks: [], kept: true }] });
  try {
    const response = await state.backend.send({ type: 'UPDATE_SAVED_VERSION', url, versionId: 'other-history', action: 'delete' });
    assert.equal(response.ok, true); assert.equal(state.signals[0].aborted, false);
    state.finish(); const result = await state.pending;
    const after = await state.db.getPageRecord(url);
    assert.deepEqual(plain(after.versions), []);
    if (operation === 'BACKFILL_EMBEDDINGS') { assert.equal(result.result.updated, 1); assert.deepEqual(plain(after.chunks[0].embedding), [0, 1]); }
    else { assert.equal(result.updated, true); assert.equal(after.summary, 'Completed overview.'); }
  } finally { state.finish(); await state.pending; }
});

test('whole-page Delete cancels an ID-less legacy embedding source by its actual saved content', async testContext => {
  const legacy = { ...page }; delete legacy.versionId;
  const state = await scenario(testContext, 'BACKFILL_EMBEDDINGS', legacy);
  try {
    assert.equal((await state.backend.send({ type: 'DELETE_PAGE', url })).deleted, 1);
    assert.equal(state.signals[0].aborted, true);
    assert.equal((await state.pending).result.failed, 1);
    assert.equal(await state.db.getPageRecord(url), undefined);
  } finally { state.finish(); await state.pending; }
});

test('whole-page Delete stops one bulk source while the remaining selected page still indexes', async testContext => {
  const generation = deferred(), signals = [], backend = providerFixture('http://localhost:11434');
  const database = await backend.load('src/shared/db/index.ts'), other = 'https://retained.test/page';
  await database.savePageRecord(page); await database.savePageRecord({ ...page, url: other, versionId: 'other' });
  testContext.after(async () => (await database.openDatabase()).close());
  const runtime = await backend.load('src/background/orchestration/index.ts', { fetch: async (input, options = {}) => {
    if (new URL(input).pathname !== '/api/embed') throw Error('Unexpected provider request');
    signals.push(options.signal);
    return signals.length === 1 ? generation.promise : Response.json({ embeddings: [[0, 1]] });
  } }); runtime.orchestrateLifecycle();
  const pending = backend.send({ type: 'BACKFILL_EMBEDDINGS', urls: [url, other], force: true, requestId: 'delete-one-bulk-source' });
  try {
    await waitFor(() => signals.length === 1, 'first bulk source inference');
    assert.equal((await backend.send({ type: 'DELETE_PAGE', url })).deleted, 1);
    const response = await pending;
    assert.equal(response.result.updated, 1); assert.equal(response.result.failed, 1);
    assert.equal(signals.length, 2); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
    assert.equal(await database.getPageRecord(url), undefined);
    assert.deepEqual(plain((await database.getPageRecord(other)).chunks[0].embedding), [0, 1]);
  } finally { generation.resolve(Response.json({ embeddings: [[9, 9]] })); await pending; }
});

test('Delete reports committed existing pages rather than duplicated or missing requested URLs', async testContext => {
  const backend = providerFixture(), database = await backend.load('src/shared/db/index.ts');
  await database.savePageRecord(page); await database.savePageRecord({ ...page, url: 'https://retained.test/page' });
  testContext.after(async () => (await database.openDatabase()).close());
  await backend.connect();
  const response = await backend.send({ type: 'DELETE_PAGE', urls: [url, url, 'https://missing.test/page'] });
  assert.equal(response.deleted, 1);
  assert.equal((await backend.send({ type: 'DELETE_PAGE', url })).deleted, 0);
  assert.ok(await database.getPageRecord('https://retained.test/page'));
});
