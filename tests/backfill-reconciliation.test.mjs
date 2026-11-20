import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain } from './helpers.mjs';

const url = 'https://saved.test/reconciliation';
const page = {
  url, title: 'Saved evidence', timestamp: 10, manual: true,
  text: 'The copper tern nests on the coast. Its eggs hatch in June.',
  chunks: [
    { text: 'The copper tern nests on the coast.', embedding: [9, 9], embeddingKey: 'previous-model' },
    { text: 'Its eggs hatch in June.', embedding: [] }
  ],
  summary: 'Coastal nesting and hatching dates.'
};
const failedJob = {
  url, title: page.title, status: 'failed', textSaved: true, attempts: 1,
  createdAt: 20, updatedAt: 30, lastAttemptAt: 25, error: 'Capture model unavailable',
  payload: { url, title: page.title, timestamp: page.timestamp, manual: true, text: page.text, chunks: page.chunks.map(chunk => chunk.text), captureId: 'saved-capture' }
};

test('a recapture in the same clock millisecond invalidates an earlier compare-and-save snapshot', async t => {
  class FrozenDate extends Date { static now() { return 1000; } }
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange, Date: FrozenDate });
  const connection = await db.openDatabase(); t.after(() => connection.close());
  await db.savePageRecord(page);
  const earlier = await db.getPageRecord(url);
  const newer = { ...page, text: 'Newer evidence from another capture.', timestamp: 20, chunks: [{ text: 'Newer evidence from another capture.', embedding: [] }] };
  await db.savePageRecord(newer);
  await assert.rejects(db.savePageRecord(earlier, { expectedUpdatedAt: earlier.updatedAt }), /abort/i);
  const saved = await db.getPageRecord(url);
  assert.equal(saved.text, newer.text); assert.equal(saved.timestamp, newer.timestamp);
});

async function fixture(t, compute = async () => [[0, 1]]) {
  let now = 100;
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange, Date: { now: () => ++now } });
  const connection = await db.openDatabase();
  t.after(() => connection.close());
  await db.savePageRecord(page);
  await db.appendProcessing(failedJob);
  const requests = [], progress = [];
  const savedWork = await loadSource('src/background/processing/savedWork.ts');
  let invalidations = 0, beforeSave;
  const backfill = await loadSource('src/background/embeddings/backfill.ts', '', {
    '../storage/manager': { storageManager: { ...db, savePageRecord: async (...args) => { await beforeSave?.(); return db.savePageRecord(...args); } } },
    './index': {
      getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'reconciliation-model' }),
      computeEmbeddingsForChunks: async (texts, signal) => { requests.push(plain(texts)); return compute(db, texts, signal); }
    },
    '../summaries/index': { queuePageSummary: async () => false },
    '../processing/savedWork': savedWork,
    '../offscreen/index': { invalidateOffscreenIndex: async () => { invalidations++; } },
    '../../shared/logger/index': { log: async () => {} }
  });
  return {
    db, requests, progress,
    activateReplacement: savedWork.invalidateSavedLibraryWork,
    run: (signal, force = false) => backfill.backfillMissingEmbeddings(50, force, [url], event => progress.push(plain(event)), signal),
    invalidations: () => invalidations,
    beforeSave: callback => { beforeSave = callback; },
    replaceJobAtCommit(job) {
      const transaction = connection.transaction.bind(connection);
      let injected = false;
      connection.transaction = (...args) => {
        if (!injected && args[1] === 'readwrite' && Array.from(args[0]).includes('pages')) {
          injected = true;
          transaction('processing', 'readwrite').objectStore('processing').put(job);
        }
        return transaction(...args);
      };
    },
    abortNextWrite(storeName, method) {
      const transaction = connection.transaction.bind(connection);
      let injected = false;
      connection.transaction = (...args) => {
        const pending = transaction(...args);
        if (!injected && pending.mode === 'readwrite' && pending.objectStoreNames.contains('pages')) {
          injected = true;
          const store = pending.objectStore(storeName), mutate = store[method].bind(store);
          store[method] = (...values) => {
            const request = mutate(...values);
            request.addEventListener('success', () => pending.abort(), { once: true });
            return request;
          };
        }
        return pending;
      };
    }
  };
}

test('a backfill held before commit cannot modify the restored library when the saved page and revision are identical', async context => {
  let beginWrite, continueWrite;
  const writing = new Promise(resolve => { beginWrite = resolve; });
  const release = new Promise(resolve => { continueWrite = resolve; });
  const state = await fixture(context);
  const before = plain(await state.db.getPageRecord(url));
  state.beforeSave(() => { beginWrite(); return release; });
  const pending = state.run();
  await writing;
  state.activateReplacement();
  continueWrite();
  const result = await pending;
  assert.equal(result.updated, 0);
  assert.match(result.failures[0].error, /library was restored/iu);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
  state.beforeSave(undefined);
  assert.equal((await state.run()).updated, 1, 'Work started against the replacement remains available');
});

test('successful Memory backfill saves missing vectors and retires the matching saved-capture failure', async t => {
  const state = await fixture(t);
  const result = await state.run();
  const saved = await state.db.getPageRecord(url);
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(plain(result.updatedUrls), [url]);
  assert.deepEqual(state.requests, [['Its eggs hatch in June.']]);
  assert.equal(saved.text, page.text);
  assert.equal(saved.summary, page.summary);
  assert.deepEqual(plain(saved.chunks.map(chunk => chunk.embedding)), [[9, 9], [0, 1]]);
  assert.equal(saved.chunks[0].embeddingKey, 'previous-model');
  assert.equal(await state.db.getProcessingEntry(url), undefined);
  assert.deepEqual(plain(await state.db.listProcessing()), []);
  assert.equal(state.invalidations(), 1);
  assert.equal(state.progress.at(-1).status, 'complete');
});

test('forced re-embedding also retires only the matching saved-capture failure', async t => {
  const state = await fixture(t, async () => [[1, 0], [0, 1]]);
  const result = await state.run(undefined, true);
  assert.equal(result.updated, 1);
  assert.deepEqual(state.requests, [page.chunks.map(chunk => chunk.text)]);
  assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks.map(chunk => chunk.embedding)), [[1, 0], [0, 1]]);
  assert.equal(await state.db.getProcessingEntry(url), undefined);
});

for (const status of ['queued', 'processing', 'failed']) {
  test(`backfill preserves a newer ${status} generation even with identical saved text and job timestamps`, async t => {
    const newer = { ...failedJob, status, payload: { ...failedJob.payload, captureId: 'newer-capture' }, error: 'New generation state' };
    const state = await fixture(t, async db => { await db.appendProcessing(newer); return [[0, 1]]; });
    const result = await state.run();
    assert.equal(result.updated, 1);
    assert.deepEqual(plain(await state.db.getProcessingEntry(url)), newer);
    assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks[1].embedding), [0, 1]);
  });

  test(`the page transaction preserves a newer ${status} job committed after all backfill reads`, async t => {
    const newer = { ...failedJob, status, payload: { ...failedJob.payload, captureId: 'commit-race-capture' } };
    const state = await fixture(t);
    state.replaceJobAtCommit(newer);
    const result = await state.run();
    assert.equal(result.updated, 1);
    assert.deepEqual(plain(await state.db.getProcessingEntry(url)), newer);
    assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks[1].embedding), [0, 1]);
  });
}

test('backfill preserves a later failure transition within the same capture generation', async t => {
  const newer = { ...failedJob, updatedAt: failedJob.updatedAt + 1, attempts: 2, error: 'Later retry failed' };
  const state = await fixture(t, async db => { await db.updateProcessingEntry(newer); return [[0, 1]]; });
  const result = await state.run();
  assert.equal(result.updated, 1);
  assert.deepEqual(plain(await state.db.getProcessingEntry(url)), newer);
});

test('same-millisecond retry transitions cannot make a newer failure look like the backfill snapshot', async t => {
  const newer = { ...failedJob, attempts: 2, updatedAt: 32, error: 'Same-millisecond retry failed' };
  const state = await fixture(t, async db => {
    await db.updateProcessingEntry({ ...failedJob, status: 'processing', attempts: 2 });
    await db.updateProcessingEntry({ ...failedJob, attempts: 2, error: 'Same-millisecond retry failed' });
    return [[0, 1]];
  });
  const result = await state.run();
  assert.equal(result.updated, 1);
  assert.deepEqual(plain(await state.db.getProcessingEntry(url)), newer);
  assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks[1].embedding), [0, 1]);
});

for (const status of ['queued', 'processing']) {
  test(`backfill does not retire a ${status} capture that fails only after inference starts`, async t => {
    const state = await fixture(t, async db => { await db.updateProcessingEntry(failedJob); return [[0, 1]]; });
    await state.db.appendProcessing({ ...failedJob, status });
    const result = await state.run();
    assert.equal(result.updated, 1);
    assert.deepEqual(plain(await state.db.getProcessingEntry(url)), { ...failedJob, updatedAt: 31 });
  });
}

test('a failure arriving without an initial processing job is not obsolete backfill state', async t => {
  const state = await fixture(t, async db => { await db.appendProcessing(failedJob); return [[0, 1]]; });
  await state.db.deleteProcessing(url);
  const result = await state.run();
  assert.equal(result.updated, 1);
  assert.deepEqual(plain(await state.db.getProcessingEntry(url)), failedJob);
});

const unmatchedJobs = [
  ['unsaved text', { ...failedJob, textSaved: false }],
  ['unknown text persistence', { ...failedJob, textSaved: undefined }],
  ['missing payload', { ...failedJob, payload: undefined }],
  ['legacy generation', { ...failedJob, payload: { ...failedJob.payload, captureId: undefined } }],
  ['empty generation', { ...failedJob, payload: { ...failedJob.payload, captureId: '' } }],
  ['different URL', { ...failedJob, payload: { ...failedJob.payload, url: 'https://saved.test/other' } }],
  ['different timestamp', { ...failedJob, payload: { ...failedJob.payload, timestamp: 11 } }],
  ['different text', { ...failedJob, payload: { ...failedJob.payload, text: 'Another saved article.' } }],
  ['different chunk text', { ...failedJob, payload: { ...failedJob.payload, chunks: [page.chunks[0].text, 'Another passage.'] } }],
  ['different chunk count', { ...failedJob, payload: { ...failedJob.payload, chunks: [page.chunks[0].text] } }],
  ['different chunk order', { ...failedJob, payload: { ...failedJob.payload, chunks: [...failedJob.payload.chunks].reverse() } }]
];

for (const [reason, job] of unmatchedJobs) {
  test(`backfill saves vectors but retains a failed job with ${reason}`, async t => {
    const state = await fixture(t);
    await state.db.appendProcessing(job);
    const result = await state.run();
    assert.equal(result.updated, 1);
    assert.deepEqual(plain(await state.db.getProcessingEntry(url)), plain(job));
    assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks[1].embedding), [0, 1]);
  });
}

for (const [reason, compute] of [
  ['provider rejection', async () => { throw new Error('Backfill model unavailable'); }],
  ['missing vectors', async () => []],
  ['empty vector', async () => [[]]],
  ['nonfinite vector', async () => [[NaN, 1]]],
  ['extra vectors', async () => [[1, 0], [0, 1]]]
]) {
  test(`backfill ${reason} preserves the entire saved page and prior failed job`, async t => {
    const state = await fixture(t, compute);
    const before = plain(await state.db.getPageRecord(url));
    const result = await state.run();
    assert.equal(state.requests.length, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
    assert.deepEqual(plain(await state.db.getProcessingEntry(url)), failedJob);
    assert.equal(state.invalidations(), 0);
    assert.equal(state.progress.at(-1).status, 'error');
  });
}

test('cancellation after provider output preserves the saved page and failed job', async t => {
  const controller = new AbortController();
  const state = await fixture(t, async () => { controller.abort(new Error('Stopped by user')); return [[0, 1]]; });
  const before = plain(await state.db.getPageRecord(url));
  await assert.rejects(state.run(controller.signal), /Stopped by user/);
  assert.equal(state.requests.length, 1);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
  assert.deepEqual(plain(await state.db.getProcessingEntry(url)), failedJob);
  assert.equal(state.invalidations(), 0);
});

test('an already cancelled backfill makes no provider request or reconciliation write', async t => {
  const controller = new AbortController();
  const state = await fixture(t);
  const before = plain(await state.db.getPageRecord(url));
  controller.abort(new Error('Stopped before backfill'));
  await assert.rejects(state.run(controller.signal), /Stopped before backfill/);
  assert.deepEqual(state.requests, []);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
  assert.deepEqual(plain(await state.db.getProcessingEntry(url)), failedJob);
});

test('a newer capture committed after the last backfill read survives the transactional page guard', async t => {
  const state = await fixture(t);
  const newerPage = { ...page, timestamp: 50, text: 'New captured evidence.', chunks: [{ text: 'New captured evidence.', embedding: [] }] };
  const newerJob = { ...failedJob, payload: { ...failedJob.payload, timestamp: 50, text: newerPage.text, chunks: ['New captured evidence.'], captureId: 'replacement-capture' } };
  let committed;
  state.beforeSave(async () => {
    await state.db.savePageRecord(newerPage);
    await state.db.appendProcessing(newerJob);
    committed = plain(await state.db.getPageRecord(url));
  });
  const result = await state.run();
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), committed);
  assert.deepEqual(plain(await state.db.getProcessingEntry(url)), newerJob);
  assert.equal(state.invalidations(), 0);
});

test('deletion after the last backfill read cannot resurrect a page or its failed job', async t => {
  const state = await fixture(t);
  state.beforeSave(() => state.db.deletePages([url]));
  const result = await state.run();
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 1);
  assert.equal(await state.db.getPageRecord(url), undefined);
  assert.equal(await state.db.getProcessingEntry(url), undefined);
  assert.equal(state.invalidations(), 0);
});

for (const [operation, storeName, method] of [['page write', 'pages', 'put'], ['job retirement', 'processing', 'delete']]) {
  test(`an aborted ${operation} rolls back both the vectors and failed-job retirement`, async t => {
    const state = await fixture(t);
    const before = plain(await state.db.getPageRecord(url));
    state.abortNextWrite(storeName, method);
    const result = await state.run();
    assert.equal(result.updated, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
    assert.deepEqual(plain(await state.db.getProcessingEntry(url)), failedJob);
    assert.equal(state.invalidations(), 0);
  });
}

test('selected-page reconciliation leaves an unrelated saved page and its failed capture untouched', async t => {
  const state = await fixture(t);
  const otherUrl = 'https://saved.test/unrelated';
  const otherJob = { ...failedJob, url: otherUrl, payload: { ...failedJob.payload, url: otherUrl, captureId: 'unrelated-capture' } };
  await state.db.savePageRecord({ ...page, url: otherUrl });
  await state.db.appendProcessing(otherJob);
  const before = plain(await state.db.getPageRecord(otherUrl));
  const result = await state.run();
  assert.equal(result.updated, 1);
  assert.equal(await state.db.getProcessingEntry(url), undefined);
  assert.deepEqual(plain(await state.db.getPageRecord(otherUrl)), before);
  assert.deepEqual(plain(await state.db.getProcessingEntry(otherUrl)), otherJob);
});
