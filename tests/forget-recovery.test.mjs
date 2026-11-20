import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';
import { loadSource, plain, waitFor, automaticAiEnabled } from './helpers.mjs';

const payload = { url: 'https://example.test/article', title: 'Saved page', text: 'Original saved evidence.', chunks: ['Original saved evidence.'], timestamp: 150, manual: true };
const filters = { domain: 'example.test', from: 100, before: 200 };

async function fixture(t, embed) {
  const backend = providerFixture(), db = await backend.load('src/shared/db/index.ts');
  const processing = await backend.load('src/background/processing/index.ts');
  const signals = [];
  let beforeDelete, afterForget;
  const processor = await loadSource('src/background/capture/processor.ts', '', {
    '../processing/automaticAi': automaticAiEnabled,
    '../storage/manager': { storageManager: db }, '../storage/index': { whenStorageReady: async () => {} },
    '../embeddings/index': {
      getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }),
      embedPayloadChunks: async (page, signal) => {
        signals.push(signal);
        if (embed) return embed(page, signal, signals.length);
        if (signals.length > 1) return [[1, 0]];
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    },
    '../summaries/index': { queuePageSummary: async () => false }, '../offscreen/index': { invalidateOffscreenIndex: async () => {} }, '../../shared/logger/index': { log: async () => {} }
  });
  const capture = await loadSource('src/background/capture/index.ts', '', {
    './processor': processor, '../processing/index': processing, '../settings/index': { shouldCaptureUrl: async () => true, getCachedSettingsSnapshot: () => ({}) }, '../../shared/logger/index': { log: async () => {} }
  }, { chrome: { runtime: backend.runtime } });
  const queue = capture.createCaptureQueue(); await queue.ready; queue.bindRuntimeListener();
  const manage = await loadSource('src/background/manage/index.ts', '', {
    '../capture/index': capture, '../processing/index': processing,
    '../storage/manager': { storageManager: { ...db, deletePages: async (...args) => { await beforeDelete?.(); return db.deletePages(...args); }, forgetPageVersions: async (...args) => { const result = await db.forgetPageVersions(...args); await afterForget?.(); return result; } } },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }) },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }, './recents': { invalidateRecentPages: async () => {} }
  });
  t.after(async () => { await capture.cancelCaptureJobs([payload.url]); await waitFor(() => !queue.isProcessing(), 'fixture work to stop'); (await db.openDatabase()).close(); });
  await queue.enqueue(payload); await waitFor(() => signals.length === 1, 'initial indexing request');
  return { backend, db, queue, manage, signals, beforeDelete: callback => { beforeDelete = callback; }, afterForget: callback => { afterForget = callback; }, async abortNextDelete() {
    const connection = await db.openDatabase(), transaction = connection.transaction.bind(connection);
    let injected = false;
    connection.transaction = (...args) => {
      const pending = transaction(...args);
      if (!injected && pending.mode === 'readwrite' && pending.objectStoreNames.contains('pages')) {
        const store = pending.objectStore('pages'), remove = store.delete.bind(store);
        store.delete = (...values) => {
          injected = true; const request = remove(...values); request.addEventListener('success', () => pending.abort(), { once: true }); return request;
        };
      }
      return pending;
    };
  } };
}

test('an aborted whole-page deletion keeps saved evidence and makes cancelled indexing retryable without restarting Chrome', async t => {
  const state = await fixture(t); await state.abortNextDelete();
  await assert.rejects(state.manage.deleteManagePages([payload.url], filters), /abort/i);
  await waitFor(() => !state.queue.isProcessing(), 'cancelled indexing to settle');
  assert.equal(state.signals[0].aborted, true);
  assert.equal((await state.db.getPageRecord(payload.url)).text, payload.text);
  const job = await state.db.getProcessingEntry(payload.url);
  assert.equal(job.status, 'failed'); assert.equal(job.textSaved, true); assert.match(job.error, /Saved text was retained/);
  assert.equal((await state.backend.send({ type: 'RETRY_PROCESSING', url: payload.url })).retried, 1);
  await waitFor(() => !state.queue.isProcessing(), 'retried indexing');
  assert.deepEqual(plain((await state.db.getPageRecord(payload.url)).chunks[0].embedding), [1, 0]);
  assert.equal(await state.db.getProcessingEntry(payload.url), undefined);
});

test('a failed version forget does not cancel active indexing, and retry cancels only after the deletion commits', async testContext => {
  const state = await fixture(testContext), review = await state.manage.previewForgetPages(filters);
  await state.abortNextDelete();
  await assert.rejects(state.manage.forgetManagePages(review.selection, filters), /abort/i);
  assert.equal(state.signals[0].aborted, false); assert.equal(state.queue.isProcessing(), true);
  assert.equal((await state.db.getProcessingEntry(payload.url)).status, 'processing');
  assert.equal((await state.db.getPageRecord(payload.url)).text, payload.text);
  const result = await state.manage.forgetManagePages(review.selection, filters);
  assert.equal(result.versions, 1);
  await waitFor(() => !state.queue.isProcessing(), 'committed forget to stop indexing');
  assert.equal(state.signals[0].aborted, true); assert.equal(await state.db.getPageRecord(payload.url), undefined);
});

test('post-commit version cancellation cannot abort a newer capture admitted before cancellation runs', async testContext => {
  let finish;
  const later = new Promise(resolve => { finish = resolve; }); testContext.after(() => finish([[0, 1]]));
  const state = await fixture(testContext, (_page, signal, count) => count === 1 ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) : later);
  const review = await state.manage.previewForgetPages(filters);
  const newer = { ...payload, timestamp: 180, title: 'New unreviewed capture', text: 'Newer evidence.', chunks: ['Newer evidence.'] };
  state.afterForget(() => state.queue.enqueue(newer));
  const result = await state.manage.forgetManagePages(review.selection, filters);
  assert.equal(result.versions, 1);
  await waitFor(() => state.signals.length === 2, 'newer capture inference');
  assert.equal(state.signals[0].aborted, true); assert.equal(state.signals[1].aborted, false);
  assert.equal((await state.db.getPageRecord(payload.url)).text, newer.text);
  assert.equal((await state.db.getProcessingEntry(payload.url)).status, 'processing');
  finish([[0, 1]]); await waitFor(() => !state.queue.isProcessing(), 'newer capture completion');
  assert.deepEqual(plain((await state.db.getPageRecord(payload.url)).chunks[0].embedding), [0, 1]);
});

test('whole-page deletion failure cannot mark a newer capture failed or replace its saved evidence', async t => {
  let finish;
  const later = new Promise(resolve => { finish = resolve; }); t.after(() => finish([[0, 1]]));
  const state = await fixture(t, (_page, signal, count) => count === 1 ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) : later);
  const newer = { ...payload, timestamp: 300, text: 'Newer evidence.', chunks: ['Newer evidence.'] };
  state.beforeDelete(async () => { await state.queue.enqueue(newer); throw new Error('Delete failed'); });
  await assert.rejects(state.manage.deleteManagePages([payload.url], filters), /Delete failed/);
  await waitFor(() => state.signals.length === 2, 'newer indexing request');
  assert.equal((await state.db.getPageRecord(payload.url)).text, newer.text);
  assert.equal((await state.db.getProcessingEntry(payload.url)).status, 'processing'); assert.equal(state.signals[1].aborted, false);
  finish([[0, 1]]); await waitFor(() => !state.queue.isProcessing(), 'newer indexing to finish');
  assert.equal((await state.db.getPageRecord(payload.url)).text, newer.text); assert.equal(await state.db.getProcessingEntry(payload.url), undefined);
});

test('whole-page deletion outside the selected capture period does not cancel current indexing', async t => {
  const state = await fixture(t);
  assert.equal(await state.manage.deleteManagePages([payload.url], { domain: 'example.test', from: 200, before: 400 }), 0);
  assert.equal(state.signals[0].aborted, false); assert.equal(state.queue.isProcessing(), true);
  assert.equal((await state.db.getPageRecord(payload.url)).text, payload.text);
});

test('a delayed execution-policy reply cannot turn recovered failed indexing back into processing', async t => {
  const backend = providerFixture(), db = await backend.load('src/shared/db/index.ts');
  const processing = await backend.load('src/background/processing/index.ts');
  let release, queue, waiting = false, runs = 0;
  const pending = new Promise(resolve => { release = resolve; }); t.after(() => release(true));
  const capture = await loadSource('src/background/capture/index.ts', '', {
    './processor': { processCapturePayload: async () => { runs++; } }, '../processing/index': processing,
    '../settings/index': { shouldCaptureUrl: async () => { if (!queue?.isProcessing()) return true; waiting = true; return pending; }, getCachedSettingsSnapshot: () => ({}) },
    '../../shared/logger/index': { log: async () => {} }
  }, { chrome: { runtime: backend.runtime } });
  queue = capture.createCaptureQueue(); await queue.ready; await queue.enqueue(payload);
  await waitFor(() => waiting, 'execution policy lookup');
  const manage = await loadSource('src/background/manage/index.ts', '', {
    '../capture/index': capture, '../processing/index': processing,
    '../storage/manager': { storageManager: { ...db, deletePages: async () => { throw new Error('Delete aborted'); } } },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', model: 'test' }) },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }, './recents': { invalidateRecentPages: async () => {} }
  });
  await assert.rejects(manage.deleteManagePages([payload.url], filters), /Delete aborted/);
  release(true); await waitFor(() => !queue.isProcessing(), 'late policy reply to settle');
  assert.equal(runs, 0); assert.equal((await db.getProcessingEntry(payload.url)).status, 'failed');
  assert.equal((await db.getPageRecord(payload.url)).text, payload.text); (await db.openDatabase()).close();
});
