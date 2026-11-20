import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';
import { plain, waitFor, tick } from './helpers.mjs';

const url = 'https://example.test/notes#saved';
const version = (versionId, timestamp, text, extras = {}) => ({ versionId, timestamp, firstCapturedAt: timestamp, title: `Notes ${versionId}`, text, chunks: [{ text, embedding: [1, 0], embeddingKey: 'original-space' }], summary: `Overview ${versionId}`, kept: false, manual: true, lastVisitedAt: timestamp, lastEmbeddedAt: timestamp + 1, ...extras });
const current = () => ({ url, ...version('current', 300, 'Current evidence.'), versions: [version('middle', 150, 'Middle evidence.', { kept: true }), version('early', 50, 'Early evidence.')] });
const within = { domain: 'example.test', from: 100, before: 200 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function library(testContext, page = current(), fetch) {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts');
  await db.savePageRecord(page);
  const runtime = await backend.load('src/background/orchestration/index.ts', fetch ? { fetch } : {});
  runtime.orchestrateLifecycle();
  testContext.after(async () => (await db.openDatabase()).close());
  return { backend, db, review: filters => backend.send({ type: 'PREVIEW_FORGET_PAGES', filters }), forget: (selection, filters) => backend.send({ type: 'FORGET_PAGES', selection, filters }) };
}

test('date forgetting removes only reviewed matching versions, including Keep, and preserves other evidence exactly', async testContext => {
  const state = await library(testContext), before = plain(await state.db.getPageRecord(url));
  const review = await state.review(within);
  assert.equal(review.versionCount, 1);
  assert.deepEqual(plain(review.selection), [{ url, versionIds: ['middle'] }]);
  const result = await state.forget(review.selection, within);
  assert.equal(result.versions, 1); assert.equal(result.pages, 1);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), { ...before, versions: before.versions.filter(version => version.versionId === 'early') });
  assert.match((await state.backend.send({ type: 'GET_SAVED_PAGE', url, versionId: 'middle' })).error, /no longer available/);
  assert.equal((await state.backend.send({ type: 'GET_SAVED_PAGE', url, versionId: 'early' })).page.text, 'Early evidence.');
  assert.doesNotMatch(JSON.stringify(result), /Middle evidence|Overview middle/);
});

test('removing the current capture promotes the newest unaffected version with its own metadata and vectors', async testContext => {
  const page = current();
  page.versions.reverse(); page.versions[1].captureInfo = { source: 'main', warnings: ['Collapsed replies were omitted.'] };
  const state = await library(testContext, page), before = await state.db.getPageRecord(url);
  const filters = { domain: 'example.test', from: 300, before: 400 };
  const review = await state.review(filters), result = await state.forget(review.selection, filters);
  assert.equal(result.versions, 1); assert.equal(result.pages, 1);
  const promoted = await state.db.getPageRecord(url), expected = page.versions[1];
  for (const field of ['versionId', 'timestamp', 'firstCapturedAt', 'title', 'text', 'summary', 'kept', 'manual', 'lastVisitedAt', 'lastEmbeddedAt', 'chunks', 'captureInfo']) assert.deepEqual(plain({ value: promoted[field] }), plain({ value: expected[field] }), `Promotion must retain ${field} from the unaffected snapshot`);
  assert.deepEqual(plain(promoted.versions).map(version => version.versionId), ['early']);
  assert.ok(promoted.updatedAt > before.updatedAt); assert.equal(promoted.createdAt, before.createdAt);
  assert.equal((await state.backend.send({ type: 'GET_RECENT_PAGES' })).pages[0].title, 'Notes middle');
});

test('promoting legacy history clears unknown summary, title, embedding and visit metadata instead of inheriting forgotten values', async testContext => {
  const page = { ...current(), firstCapturedAt: 290, captureInfo: { source: 'article', warnings: ['Current warning.'] }, versions: [{ timestamp: 50, text: 'Legacy evidence.', chunks: [] }] };
  const state = await library(testContext, page), filters = { from: 250 };
  const review = await state.review(filters); await state.forget(review.selection, filters);
  const promoted = await state.db.getPageRecord(url);
  assert.equal(promoted.text, 'Legacy evidence.'); assert.equal(promoted.title, url);
  assert.equal(promoted.firstCapturedAt, 50); assert.equal(promoted.timestamp, 50);
  assert.equal(promoted.summary, undefined); assert.equal(promoted.lastEmbeddedAt, undefined);
  assert.equal(promoted.lastVisitedAt, undefined); assert.equal(promoted.captureInfo, undefined); assert.equal(promoted.kept, true);
});

test('a frozen review excludes newly captured versions in the same date range and preserves their pending job', async testContext => {
  const state = await library(testContext, { ...current(), timestamp: 150, versions: [] });
  const review = await state.review(within), processing = await state.backend.load('src/background/processing/index.ts');
  await processing.markQueued({ url, title: 'Newer evidence', text: 'New unreviewed content.', chunks: ['New unreviewed content.'], timestamp: 180, captureId: 'after-review', manual: true }, 0);
  const newer = await state.db.getPageRecord(url), job = plain(await state.db.getProcessingEntry(url));
  assert.equal((await state.forget(review.selection, within)).versions, 1);
  const after = await state.db.getPageRecord(url);
  assert.equal(after.versionId, newer.versionId); assert.equal(after.text, 'New unreviewed content.');
  assert.deepEqual(plain(after.versions), []); assert.deepEqual(plain(await state.db.getProcessingEntry(url)), job);
});

test('a reviewed version observed again outside the date range remains, along with its current job', async testContext => {
  const state = await library(testContext, { ...current(), timestamp: 150, versions: [] });
  const review = await state.review(within), processing = await state.backend.load('src/background/processing/index.ts');
  await processing.markQueued({ url, title: 'Notes current', text: 'Current evidence.', chunks: ['Current evidence.'], timestamp: 250, captureId: 'outside-range', manual: true }, 0);
  const before = plain(await state.db.getPageRecord(url)), job = plain(await state.db.getProcessingEntry(url));
  const result = await state.forget(review.selection, within);
  assert.equal(result.versions, 0); assert.equal(result.pages, 0);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), before); assert.deepEqual(plain(await state.db.getProcessingEntry(url)), job);
});

test('review assigns stable legacy identities without changing content and rechecks exact site and exclusive date bounds', async testContext => {
  const state = await library(testContext, { ...current(), versionId: undefined, versions: [{ timestamp: 100, text: 'Boundary evidence.', chunks: [] }, { timestamp: 200, text: 'Excluded upper bound.', chunks: [] }] });
  const before = await state.db.getPageRecord(url), first = await state.review(within), second = await state.review(within);
  assert.equal(first.versionCount, 1); assert.deepEqual(plain(second.selection), plain(first.selection));
  const after = await state.db.getPageRecord(url);
  assert.equal(after.text, before.text); assert.equal(after.updatedAt, before.updatedAt); assert.deepEqual(plain(after.chunks), plain(before.chunks));
  assert.equal((await state.forget(first.selection, { ...within, domain: 'notexample.test' })).versions, 0);
  assert.equal((await state.forget(first.selection, within)).versions, 1);
  assert.ok((await state.db.getPageRecord(url)).versions.some(version => version.text === 'Excluded upper bound.'));
});

test('malformed, missing and stale review identities cannot broaden forgetting, while duplicate selections count only once', async testContext => {
  const state = await library(testContext);
  for (const selection of [undefined, [url], [{ url, versionIds: 'current' }], [{ url, versionIds: [7] }], [{ url: 'javascript:alert(1)', versionIds: ['current'] }]]) {
    assert.ok((await state.forget(selection, within)).error); assert.equal((await state.db.getPageRecord(url)).versions.length, 2);
  }
  assert.equal((await state.forget([{ url, versionIds: ['unavailable'] }], within)).versions, 0);
  const result = await state.forget([{ url, versionIds: ['middle', 'middle'] }, { url, versionIds: ['middle'] }], within);
  assert.equal(result.versions, 1); assert.equal(result.pages, 1);
});

test('a failed forget transaction leaves all versions and pending work intact, and the same selection is retryable', async testContext => {
  const state = await library(testContext);
  const job = { url, title: 'Notes current', status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, lastAttemptAt: 1, payload: { url, title: 'Notes current', text: 'Current evidence.', chunks: ['Current evidence.'], timestamp: 300, captureId: 'pending-current' } };
  await state.db.appendProcessing(job);
  const filters = { from: 300 }, review = await state.review(filters), before = plain(await state.db.getPageRecord(url));
  const connection = await state.db.openDatabase(), transaction = connection.transaction.bind(connection);
  let injected = false;
  connection.transaction = (...args) => {
    const tx = transaction(...args);
    if (!injected && tx.mode === 'readwrite' && tx.objectStoreNames.contains('pages') && tx.objectStoreNames.contains('processing')) {
      const store = tx.objectStore('pages'), put = store.put.bind(store);
      store.put = value => { const request = put(value); injected = true; request.addEventListener('success', () => tx.abort(), { once: true }); return request; };
    }
    return tx;
  };
  await assert.rejects(state.db.forgetPageVersions(review.selection, filters), /abort/i);
  assert.equal(injected, true);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), before); assert.deepEqual(plain(await state.db.getProcessingEntry(url)), job);
  assert.equal((await state.forget(review.selection, filters)).versions, 1);
  assert.equal((await state.db.getPageRecord(url)).versionId, 'middle'); assert.equal(await state.db.getProcessingEntry(url), undefined);
});

for (const operation of ['BACKFILL_EMBEDDINGS', 'REGENERATE_PAGE_SUMMARY']) for (const { forgetCurrent, legacy } of [{ forgetCurrent: false }, { forgetCurrent: true }, { forgetCurrent: true, legacy: true }]) test(`${operation} ${forgetCurrent ? `is cancelled when its ${legacy ? 'legacy ' : ''}version is forgotten` : 'keeps running when only unrelated history is forgotten'}`, async testContext => {
  const generation = deferred(), signals = [];
  const page = current(); if (legacy) delete page.versionId;
  const state = await library(testContext, page, async (input, options = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 8192 }] });
    if (path === '/api/embed' || path === '/api/chat') { signals.push(options.signal); return generation.promise; }
    throw Error(`Unexpected inference route ${path}`);
  });
  const pending = state.backend.send({ type: operation, url, urls: [url], force: true, requestId: `forget-${operation}` });
  const finish = () => generation.resolve(operation === 'BACKFILL_EMBEDDINGS' ? Response.json({ embeddings: [[0, 1]] }) : Response.json({ message: { content: 'Fresh current overview.' } }));
  try {
    await waitFor(() => signals.length > 0, 'inference to begin');
    const filters = forgetCurrent ? { from: 300 } : within, review = await state.review(filters);
    assert.equal((await state.forget(review.selection, filters)).versions, 1); assert.equal(signals[0].aborted, forgetCurrent);
    if (forgetCurrent) {
      const result = await pending;
      if (operation === 'BACKFILL_EMBEDDINGS') { assert.equal(result.result.failed, 1); assert.equal(result.result.updated, 0); }
      else assert.match(result.error, /forgotten/);
      assert.equal((await state.db.getPageRecord(url)).versionId, 'middle');
    }
    finish();
    const result = await pending; await tick();
    const after = await state.db.getPageRecord(url);
    if (forgetCurrent) { assert.equal(after.summary, 'Overview middle'); assert.deepEqual(plain(after.chunks[0].embedding), [1, 0]); }
    else if (operation === 'BACKFILL_EMBEDDINGS') { assert.equal(result.result.updated, 1); assert.deepEqual(plain(after.chunks[0].embedding), [0, 1]); }
    else { assert.equal(result.updated, true); assert.equal(after.summary, 'Fresh current overview.'); }
  } finally { finish(); await pending; }
});

test('forgetting one source cancels only its inference and lets the remaining bulk embedding work finish', async testContext => {
  const generation = deferred(), signals = [];
  const state = await library(testContext, current(), async (input, options = {}) => {
    if (new URL(input).pathname !== '/api/embed') throw Error('Unexpected provider request');
    signals.push(options.signal);
    return signals.length === 1 ? generation.promise : Response.json({ embeddings: [[0, 1]] });
  });
  const other = 'https://unrelated.test/retained';
  await state.db.savePageRecord({ url: other, ...version('unrelated', 300, 'Other retained evidence.') });
  const pending = state.backend.send({ type: 'BACKFILL_EMBEDDINGS', urls: [url, other], force: true, requestId: 'bulk-forget' });
  try {
    await waitFor(() => signals.length === 1, 'first page inference');
    const filters = { domain: 'example.test', from: 300 }, review = await state.review(filters);
    assert.equal((await state.forget(review.selection, filters)).versions, 1);
    const response = await pending;
    assert.equal(response.result.processed, 2); assert.equal(response.result.updated, 1); assert.equal(response.result.failed, 1);
    assert.equal(signals.length, 2); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
    assert.equal((await state.db.getPageRecord(url)).versionId, 'middle');
    assert.deepEqual(plain((await state.db.getPageRecord(other)).chunks[0].embedding), [0, 1]);
  } finally { generation.resolve(Response.json({ embeddings: [[9, 9]] })); await pending; }
});

test('summary commits cannot cross version identities when promotion leaves identical title and body', async testContext => {
  const page = current(); page.versions = [{ ...version('identical-earlier', 50, page.text), title: page.title, summary: undefined }];
  const state = await library(testContext, page), filters = { from: 300 };
  const review = await state.review(filters); await state.forget(review.selection, filters);
  assert.equal(await state.db.savePageSummary(url, page.text, 'Stale overview.', undefined, undefined, page.title, 'current'), false);
  assert.equal((await state.db.getPageRecord(url)).summary, undefined);
  assert.equal(await state.db.savePageSummary(url, page.text, 'Correct retained overview.', undefined, undefined, page.title, 'identical-earlier'), true);
  assert.equal((await state.db.getPageRecord(url)).summary, 'Correct retained overview.');
});

test('forgetting an epoch capture excludes the next instant and uses stable IDs when capture times collide', async testContext => {
  const page = { ...current(), versions: [version('zero-one', 0, 'First epoch evidence.'), version('zero-two', 0, 'Second epoch evidence.'), version('next', 1, 'Next evidence.')] };
  const state = await library(testContext, page), filters = { from: 0, before: 1 }, review = await state.review(filters);
  assert.equal(review.versionCount, 2);
  assert.equal((await state.forget([{ url, versionIds: ['zero-two'] }], filters)).versions, 1);
  assert.deepEqual(plain((await state.db.getPageRecord(url)).versions).map(version => version.versionId), ['zero-one', 'next']);
  assert.equal((await state.forget(review.selection, filters)).versions, 1);
  assert.deepEqual(plain((await state.db.getPageRecord(url)).versions).map(version => version.versionId), ['next']);
});

test('a forgotten pending bulk source never reaches inference after an earlier page finishes', async testContext => {
  const generation = deferred(), inputs = [], firstUrl = 'https://unrelated.test/first';
  const state = await library(testContext, current(), async (input, options = {}) => {
    if (new URL(input).pathname !== '/api/embed') throw Error('Unexpected provider request');
    inputs.push(JSON.parse(options.body).input);
    return inputs.length === 1 ? generation.promise : Response.json({ embeddings: [[0, 1]] });
  });
  await state.db.savePageRecord({ url: firstUrl, ...version('first', 300, 'First unrelated page.') });
  const pending = state.backend.send({ type: 'BACKFILL_EMBEDDINGS', urls: [firstUrl, url], force: true, requestId: 'pending-forgotten' });
  try {
    await waitFor(() => inputs.length === 1, 'first source to stall');
    const filters = { domain: 'example.test', from: 300 }, review = await state.review(filters);
    assert.equal((await state.forget(review.selection, filters)).versions, 1);
    generation.resolve(Response.json({ embeddings: [[0, 1]] }));
    const response = await pending;
    assert.deepEqual(inputs, [['First unrelated page.']]);
    assert.equal(response.result.updated, 1); assert.equal(response.result.failed, 1);
    assert.equal((await state.db.getPageRecord(url)).versionId, 'middle');
    assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks[0].embedding), [1, 0]);
  } finally { generation.resolve(Response.json({ embeddings: [[0, 1]] })); await pending; }
});

test('forgetting legacy history does not discard a valid concurrent overview for the retained ID-less current page', async testContext => {
  const generation = deferred(), signals = [], page = current(); delete page.versionId;
  const state = await library(testContext, page, async (input, options = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 8192 }] });
    if (path === '/api/chat') { signals.push(options.signal); return generation.promise; }
    throw Error(`Unexpected route ${path}`);
  });
  const pending = state.backend.send({ type: 'REGENERATE_PAGE_SUMMARY', url, requestId: 'legacy-retained' });
  try {
    await waitFor(() => signals.length === 1, 'legacy current summary inference');
    const review = await state.review(within);
    assert.equal((await state.forget(review.selection, within)).versions, 1);
    assert.equal(signals[0].aborted, false);
    generation.resolve(Response.json({ message: { content: 'A valid retained current overview.' } }));
    assert.equal((await pending).updated, true);
    assert.equal((await state.db.getPageRecord(url)).summary, 'A valid retained current overview.');
  } finally { generation.resolve(Response.json({ message: { content: 'A valid retained current overview.' } })); await pending; }
});

test('pending missing-only backfill rechecks completed vectors and does not embed the same content again', async testContext => {
  const generation = deferred(), inputs = [], firstUrl = 'https://unrelated.test/first';
  const page = current(); page.chunks[0].embedding = [];
  const state = await library(testContext, page, async (input, options = {}) => {
    if (new URL(input).pathname !== '/api/embed') throw Error('Unexpected provider request');
    inputs.push(JSON.parse(options.body).input);
    return inputs.length === 1 ? generation.promise : Response.json({ embeddings: [[9, 9]] });
  });
  await state.db.savePageRecord({ url: firstUrl, ...version('first', 300, 'First unrelated page.', { chunks: [{ text: 'First unrelated page.', embedding: [] }] }) });
  const pending = state.backend.send({ type: 'BACKFILL_EMBEDDINGS', urls: [firstUrl, url], requestId: 'already-filled-pending' });
  try {
    await waitFor(() => inputs.length === 1, 'first source to stall');
    const latest = await state.db.getPageRecord(url);
    await state.db.savePageRecord({ ...latest, chunks: [{ text: latest.text, embedding: [0.25, 0.75], embeddingKey: 'completed-elsewhere' }] }, { expectedUpdatedAt: latest.updatedAt });
    generation.resolve(Response.json({ embeddings: [[0, 1]] }));
    const response = await pending;
    assert.equal(response.result.processed, 2); assert.equal(response.result.updated, 1); assert.equal(response.result.failed, 0);
    assert.deepEqual(inputs, [['First unrelated page.']]);
    assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks[0].embedding), [0.25, 0.75]);
    assert.equal((await state.db.getPageRecord(url)).chunks[0].embeddingKey, 'completed-elsewhere');
  } finally { generation.resolve(Response.json({ embeddings: [[0, 1]] })); await pending; }
});
