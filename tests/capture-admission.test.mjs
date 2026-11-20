import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, chromeFixture, plain, tick, waitFor, automaticAiEnabled } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';

const payload = { url: 'https://saved.test/article', title: 'A useful article', text: 'The copper tern nests on the coast.', timestamp: 10, chunks: ['The copper tern nests on the coast.'], manual: true };

async function seedFailedCapture(db) {
  await db.savePageRecord({ ...payload, chunks: payload.chunks.map(text => ({ text, embedding: [] })) });
  await db.appendProcessing({ url: payload.url, title: payload.title, status: 'failed', attempts: 1, updatedAt: 20,
    lastAttemptAt: 20, createdAt: 10, payload: { ...payload, captureId: 'failed-attempt' }, textSaved: true });
}

async function captureFixture(embed = async () => [[1, 0]], { allow = async () => true, seed = async () => {}, readQueue = db => db.listProcessing() } = {}) {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  await seed(db);
  let listener;
  const chrome = { ...chromeFixture, runtime: { ...chromeFixture.runtime, onMessage: { addListener(value) { listener = value; } } } };
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager: db } }, { chrome: chromeFixture });
  const processor = await loadSource('src/background/capture/processor.ts', '', {
    '../processing/automaticAi': automaticAiEnabled,
    '../storage/manager': { storageManager: db }, '../storage/index': { whenStorageReady: async () => {} },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }), embedPayloadChunks: embed },
    '../summaries/index': { queuePageSummary: async () => false }, '../offscreen/index': { invalidateOffscreenIndex: async () => {} }, '../../shared/logger/index': { log: async () => {} }
  }, { chrome });
  const capture = await loadSource('src/background/capture/index.ts', '', {
    '../storage/manager': { storageManager: { listFailedProcessingTargets: async () => (await readQueue(db))
      .filter(entry => entry.status === 'failed' && entry.payload)
      .map(entry => ({ url: entry.url, captureId: entry.payload.captureId ?? null })) } },
    './processor': processor, '../processing/index': processing, '../settings/index': { shouldCaptureUrl: allow, getCachedSettingsSnapshot: () => ({}) }, '../../shared/logger/index': { log: async () => {} }
  }, { chrome });
  const queue = capture.createCaptureQueue(); await queue.ready;
  queue.bindRuntimeListener();
  return { db, queue, processing, processor, cancel: capture.cancelCaptureJobs,
    send: message => new Promise(resolve => listener(message, {}, resolve)) };
}

test('acknowledged capture text is readable before a pending embedding model returns', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const fixture = await captureFixture(() => pending); t.after(async () => { finish([[1, 0]]); await tick(); });
  await fixture.queue.enqueue(payload);
  const saved = await fixture.db.getPageRecord(payload.url);
  assert.equal(saved?.text, payload.text);
  assert.equal(saved?.timestamp, payload.timestamp);
  assert.equal((await fixture.db.getProcessingEntry(payload.url))?.payload.text, payload.text);
  assert.equal((await fixture.db.getProcessingEntry(payload.url))?.textSaved, true);
  assert.equal(fixture.queue.isProcessing(), true);
  finish([[1, 0]]);
  await waitFor(() => !fixture.queue.isProcessing(), 'indexing after the model returns');
  assert.deepEqual(plain((await fixture.db.getPageRecord(payload.url)).chunks[0].embedding), [1, 0]);
});

test('capture queue notifications do not read the backlog or broadcast saved page content', async () => {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  let backlogReads = 0;
  let admissionStarted = false;
  let releaseAdmission;
  const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
  const notices = [];
  const storageManager = {
    ...db,
    async savePageRecord(...args) {
      admissionStarted = true;
      await admissionGate;
      return db.savePageRecord(...args);
    },
    async listProcessing() { backlogReads += 1; return db.listProcessing(); }
  };
  const chrome = { runtime: {
    get lastError() { return { message: 'No open extension view' }; },
    sendMessage(notice, acknowledge) { notices.push(plain(notice)); acknowledge?.(); }
  } };
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager } }, { chrome });
  const admitted = processing.markQueued(payload, 0);
  try {
    await waitFor(() => admissionStarted, 'save to reach storage');
    assert.deepEqual(notices, [], 'Do not announce an uncommitted capture');
  } finally { releaseAdmission(); await admitted; }
  assert.equal((await db.getPageRecord(payload.url))?.text, payload.text);
  assert.equal((await db.getProcessingEntry(payload.url))?.payload.text, payload.text);
  assert.ok(notices.some(notice => notice.type === 'CAPTURE_QUEUE_UPDATED'), 'Open views need an invalidation after the save commits');
  const noticesBeforeFailure = notices.length;
  await processing.markFailed(payload, 0, 'Model is offline.');
  assert.ok(notices.slice(noticesBeforeFailure).some(notice => notice.type === 'CAPTURE_QUEUE_UPDATED'), 'Open views also need an invalidation after failure commits');
  assert.equal((await db.getProcessingEntry(payload.url))?.error, 'Model is offline.');
  assert.equal(backlogReads, 0, 'Writing a queue state must not enumerate other saved jobs');
  const emitted = JSON.stringify(notices);
  for (const privateValue of [payload.title, payload.url, payload.text]) assert.ok(!emitted.includes(privateValue), 'A notification must not carry the captured page');
});

test('the queue status reply reports retryable failures without sending captured evidence', async t => {
  const backend = providerFixture();
  const db = await backend.load('src/shared/db/index.ts');
  t.after(async () => (await db.openDatabase()).close());
  const oldUrl = 'https://saved.test/earlier';
  const recent = { url: payload.url, title: payload.title, status: 'failed', attempts: 3, error: 'Ollama is offline', textSaved: true, updatedAt: 30 };
  await db.appendProcessing({ ...recent, createdAt: 10, lastAttemptAt: 30, payload: { ...payload, captureId: 'internal-generation' } });
  await db.appendProcessing({ url: oldUrl, title: 'Earlier capture', status: 'failed', attempts: 1, updatedAt: 20, lastAttemptAt: 20, createdAt: 19 });
  await backend.connect();
  const { queue, error } = await backend.send({ type: 'GET_PROCESSING' });
  assert.equal(error, undefined);
  assert.deepEqual(plain(queue.map(entry => entry.url)), [payload.url, oldUrl], 'Newer queue updates appear first');
  for (const [key, expected] of Object.entries(recent)) assert.equal(queue[0][key], expected);
  assert.notEqual(queue[1].textSaved, true, 'An old failed job cannot claim durable capture');
  assert.ok(!JSON.stringify(queue).includes(payload.text), 'A queue read must not send the stored page body or chunks');
  assert.ok(!JSON.stringify(queue).includes('internal-generation'), 'A queue read must not send capture recovery data');
  assert.equal((await db.getProcessingEntry(payload.url)).payload.text, payload.text, 'Do not trim persisted retry data');
});

test('overlapping Retry failed requests do not restart an already accepted indexing attempt', async context => {
  let finish;
  const held = new Promise(resolve => { finish = resolve; });
  let calls = 0, snapshots = 0;
  let releaseSnapshots;
  const bothReady = new Promise(resolve => { releaseSnapshots = resolve; });
  const fixture = await captureFixture(async () => { calls++; return held; }, {
    seed: seedFailedCapture,
    async readQueue(db) {
      const snapshot = await db.listProcessing();
      assert.deepEqual(Array.from(snapshot, entry => entry.status), ['failed'], 'Both requests must see the same stale failure');
      if (++snapshots === 2) releaseSnapshots();
      await bothReady;
      return snapshot;
    }
  });
  context.after(async () => {
    finish([[1, 0]]);
    await waitFor(() => !fixture.queue.isProcessing(), 'retry to finish');
    (await fixture.db.openDatabase()).close();
  });
  const results = await Promise.all([
    fixture.send({ type: 'RETRY_FAILED_CAPTURES' }),
    fixture.send({ type: 'RETRY_FAILED_CAPTURES' })
  ]);
  assert.deepEqual(results.map(result => result.retried).sort(), [0, 1], 'Only one request may consume the failure');
  await waitFor(() => calls > 0, 'accepted retry to start');
  assert.equal((await fixture.send({ type: 'RETRY_PROCESSING', url: payload.url })).retried, 0, 'A stale single-item Retry must not restart indexing either');
  finish([[1, 0]]);
  await waitFor(() => !fixture.queue.isProcessing(), 'accepted retry to finish');
  assert.equal(calls, 1);
  const saved = await fixture.db.getPageRecord(payload.url);
  assert.equal(saved.text, payload.text);
  assert.deepEqual(plain(saved.chunks[0].embedding), [1, 0]);
  assert.equal(saved.versions?.length ?? 0, 0);
  assert.equal(await fixture.db.getProcessingEntry(payload.url), undefined);
});

test('an explicit retry awaiting eligibility cannot undo a committed deletion', async context => {
  let enterPolicy, resumePolicy;
  const checkingPolicy = new Promise(resolve => { enterPolicy = resolve; });
  const allow = new Promise(resolve => { resumePolicy = resolve; });
  let modelCalls = 0;
  const fixture = await captureFixture(async () => { modelCalls++; return [[1, 0]]; }, {
    seed: seedFailedCapture,
    allow: () => { enterPolicy(); return allow; }
  });
  context.after(async () => {
    resumePolicy(true);
    await waitFor(() => !fixture.queue.isProcessing(), 'any admitted indexing to finish');
    (await fixture.db.openDatabase()).close();
  });
  const retry = fixture.send({ type: 'RETRY_PROCESSING', url: payload.url });
  await checkingPolicy;
  assert.equal((await fixture.db.deletePages([payload.url])).deleted, 1);
  resumePolicy(true);
  assert.equal((await retry).retried, 0, 'The retry lost its authority when the original job was deleted');
  assert.equal(await fixture.db.getPageRecord(payload.url), undefined);
  assert.equal(await fixture.db.getProcessingEntry(payload.url), undefined);
  assert.equal(modelCalls, 0);
});

test('a delayed Retry failed selection cannot retry a different failure with the same timestamp', async context => {
  let startSelection, releaseSelection;
  const selected = new Promise(resolve => { startSelection = resolve; });
  const resume = new Promise(resolve => { releaseSelection = resolve; });
  let modelCalls = 0;
  const fixture = await captureFixture(async () => { modelCalls++; return [[1, 0]]; }, {
    seed: seedFailedCapture,
    async readQueue(db) {
      const snapshot = await db.listProcessing();
      startSelection();
      await resume;
      return snapshot;
    }
  });
  context.after(async () => {
    releaseSelection();
    await waitFor(() => !fixture.queue.isProcessing(), 'any admitted indexing to finish');
    (await fixture.db.openDatabase()).close();
  });
  const retry = fixture.send({ type: 'RETRY_FAILED_CAPTURES' });
  await selected;
  const previous = await fixture.db.getProcessingEntry(payload.url);
  const newer = { ...previous, error: 'New provider failure', payload: { ...previous.payload, captureId: 'different-failed-attempt' } };
  await fixture.db.appendProcessing(newer);
  releaseSelection();
  assert.equal((await retry).retried, 0, 'A bulk retry is for the selected failure, not any later failure at the same time');
  assert.deepEqual(plain(await fixture.db.getProcessingEntry(payload.url)), plain(newer));
  assert.equal(modelCalls, 0);
});

test('failed atomic capture admission reports failure and retains neither a partial page nor a phantom job', async () => {
  const fixture = await captureFixture();
  const connection = await fixture.db.openDatabase(), original = connection.transaction.bind(connection);
  connection.transaction = (...args) => {
    const transaction = original(...args);
    if (transaction.mode === 'readwrite') {
      const objectStore = transaction.objectStore.bind(transaction);
      transaction.objectStore = name => {
        const store = objectStore(name), put = store.put.bind(store);
        store.put = (...values) => { const request = put(...values); transaction.abort(); return request; };
        return store;
      };
    }
    return transaction;
  };
  await assert.rejects(fixture.queue.enqueue(payload), /abort/i);
  connection.transaction = original;
  assert.equal(await fixture.db.getPageRecord(payload.url), undefined);
  assert.equal(await fixture.db.getProcessingEntry(payload.url), undefined);
  assert.equal(fixture.queue.peekQueue().length, 0);
});

test('a newer capture is saved immediately and an older in-flight job cannot replace its text or metadata', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const fixture = await captureFixture(() => ++calls === 1 ? pending : Promise.resolve([[0, 1]]));
  t.after(async () => { finish([[1, 0]]); await tick(); });
  await fixture.queue.enqueue(payload);
  await waitFor(() => calls === 1, 'the first capture to start indexing');
  const newer = { ...payload, title: 'New article title', text: 'New saved evidence.', timestamp: 20, chunks: ['New saved evidence.'] };
  await fixture.queue.enqueue(newer);
  assert.equal((await fixture.db.getPageRecord(payload.url))?.text, newer.text);
  finish([[1, 0]]);
  await waitFor(() => !fixture.queue.isProcessing(), 'both captures to finish');
  const saved = await fixture.db.getPageRecord(payload.url);
  assert.equal(saved.text, newer.text); assert.equal(saved.title, newer.title); assert.equal(saved.timestamp, newer.timestamp);
  assert.deepEqual(plain(saved.chunks[0].embedding), [0, 1]);
});

test('an embedding failure leaves the saved text and an actionable retryable indexing error', async () => {
  const fixture = await captureFixture(async () => { throw new Error('Selected model is not downloaded'); });
  await fixture.queue.enqueue(payload);
  await waitFor(() => !fixture.queue.isProcessing(), 'the failed index request');
  assert.equal((await fixture.db.getPageRecord(payload.url))?.text, payload.text);
  const job = await fixture.db.getProcessingEntry(payload.url);
  assert.equal(job?.status, 'failed');
  assert.equal(job?.textSaved, true);
  assert.match(job?.error || '', /model is not downloaded/);
});

test('Retry uses current exclusions and leaves saved text intact without making another model request', async () => {
  let allowed = true, calls = 0;
  const fixture = await captureFixture(async () => { calls++; throw new Error('Model unavailable'); }, { allow: async () => allowed });
  await fixture.queue.enqueue(payload); await waitFor(() => !fixture.queue.isProcessing(), 'index failure');
  allowed = false;
  assert.equal((await fixture.send({ type: 'RETRY_PROCESSING', url: payload.url })).retried, 0);
  assert.equal(calls, 1);
  assert.equal((await fixture.db.getPageRecord(payload.url)).text, payload.text);
  allowed = true;
  assert.equal((await fixture.send({ type: 'RETRY_PROCESSING', url: payload.url })).retried, 1);
  await waitFor(() => !fixture.queue.isProcessing(), 'explicit retry');
  assert.equal(calls, 2);
});

test('pause blocks new automatic admissions but allows explicit indexing retries of saved automatic captures', async () => {
  let paused = false, calls = 0;
  const fixture = await captureFixture(async () => { calls++; throw new Error('Model unavailable'); }, { allow: async (_url, options) => !paused || options?.ignorePaused === true });
  await fixture.queue.enqueue({ ...payload, manual: false }); await waitFor(() => !fixture.queue.isProcessing(), 'first indexing failure');
  paused = true;
  const unsaved = { ...payload, url: 'https://new.test/page', manual: false };
  await assert.rejects(fixture.queue.enqueue(unsaved), /blocked/);
  assert.equal(await fixture.db.getPageRecord(unsaved.url), undefined);
  assert.equal((await fixture.send({ type: 'RETRY_PROCESSING', url: payload.url })).retried, 1);
  await waitFor(() => !fixture.queue.isProcessing(), 'paused indexing retry');
  assert.equal(calls, 2); assert.equal((await fixture.db.getPageRecord(payload.url)).text, payload.text);
});

test('queued saved text is not indexed after a site is excluded while another job is running', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const calls = [], denied = new Set();
  const fixture = await captureFixture(page => { calls.push(page.url); return pending; }, { allow: async url => !denied.has(url) });
  t.after(async () => { finish([[1, 0]]); await tick(); });
  await fixture.queue.enqueue(payload); await waitFor(() => calls.length === 1, 'first model request');
  const next = { ...payload, url: 'https://excluded.test/article' };
  await fixture.queue.enqueue(next); denied.add(next.url); finish([[1, 0]]);
  await waitFor(() => !fixture.queue.isProcessing(), 'queue to drain');
  assert.deepEqual(calls, [payload.url]);
  assert.equal((await fixture.db.getPageRecord(next.url)).text, next.text);
  assert.equal(await fixture.db.getProcessingEntry(next.url), undefined);
});

test('restart applies current exclusions before recovering admitted indexing work', async () => {
  let calls = 0;
  const fixture = await captureFixture(async () => { calls++; return [[1, 0]]; }, { allow: async () => false, seed: async db => {
    await db.savePageRecord({ ...payload, chunks: payload.chunks.map(text => ({ text, embedding: [] })) });
    await db.appendProcessing({ url: payload.url, title: payload.title, status: 'processing', payload, attempts: 1, createdAt: 1, updatedAt: 1, lastAttemptAt: 1 });
  } });
  await waitFor(() => !fixture.queue.isProcessing(), 'recovery');
  assert.equal(calls, 0);
  assert.equal((await fixture.db.getPageRecord(payload.url)).text, payload.text);
  assert.equal(await fixture.db.getProcessingEntry(payload.url), undefined);
});

test('forgetting an admitted page aborts model inference and cannot recreate text or a retry job', async () => {
  let signal;
  const fixture = await captureFixture((_payload, value) => new Promise((resolve, reject) => {
    signal = value; value.addEventListener('abort', () => reject(value.reason), { once: true });
  }));
  await fixture.queue.enqueue(payload); await waitFor(() => Boolean(signal), 'model request');
  await fixture.cancel([payload.url]); await fixture.db.deletePages([payload.url]);
  await waitFor(() => !fixture.queue.isProcessing(), 'cancelled request');
  assert.equal(signal.aborted, true);
  assert.equal(await fixture.db.getPageRecord(payload.url), undefined);
  assert.equal(await fixture.db.getProcessingEntry(payload.url), undefined);
});

test('storage rejects outdated capture writes and transitions even after an earlier continue check passed', async t => {
  let finish, started = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const fixture = await captureFixture(() => { started = true; return pending; });
  t.after(async () => { finish([[1, 0]]); await tick(); });
  const old = { ...payload, captureId: 'old-admission' };
  await fixture.processing.markQueued(old, 0);
  const work = fixture.processor.processCapturePayload(old);
  const rejected = assert.rejects(work, /abort/i);
  await waitFor(() => started, 'old generation to begin indexing');
  const next = { ...payload, text: 'Replacement saved text.', chunks: ['Replacement saved text.'], timestamp: 20, captureId: 'new-admission' };
  await fixture.processing.markQueued(next, 0);
  assert.equal(await fixture.processing.markProcessing(old, 1), false);
  await fixture.processing.markFailed(old, 1, 'Old failure');
  finish([[1, 0]]); await rejected;
  const saved = await fixture.db.getPageRecord(payload.url), job = await fixture.db.getProcessingEntry(payload.url);
  assert.equal(saved.text, next.text); assert.equal(saved.timestamp, next.timestamp);
  assert.deepEqual(plain(saved.chunks[0].embedding), []);
  assert.equal(job.status, 'queued'); assert.equal(job.payload.text, next.text); assert.equal(job.error, undefined);
});
