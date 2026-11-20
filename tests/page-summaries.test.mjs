import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, chromeFixture, plain, tick, waitFor, automaticAiEnabled } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';

const url = 'https://example.test/article';
const record = text => ({ url, title: 'Saved article', versionId: 'saved-article', text, timestamp: 1, manual: true, chunks: [{ text, embedding: [1, 0], embeddingKey: 'saved-space' }] });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('the registered single-summary action changes only its selected summary, never invokes embeddings, and rejects non-UI callers', async t => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts'); t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ ...record('Selected content without vectors.'), summary: 'Old summary.', chunks: [{ text: 'Selected content without vectors.', embedding: [] }] });
  const other = 'https://example.test/other';
  await db.savePageRecord({ ...record('Other saved article.'), url: other, summary: 'Keep other summary.' });
  const before = await db.getPageRecord(url), untouched = await db.getPageRecord(other), requests = [];
  const runtime = await backend.load('src/background/orchestration/index.ts', { fetch: async (input, options = {}) => {
    const path = new URL(input).pathname; requests.push(path);
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 4096 }] });
    if (path === '/api/chat') return Response.json({ message: { content: 'A whole-page summary.' } });
    assert.fail(`Summary regeneration must not request ${path}`);
  } });
  runtime.orchestrateLifecycle();
  const response = await backend.send({ type: 'REGENERATE_PAGE_SUMMARY', url, requestId: 'one-summary' });
  assert.equal(response.updated, true);
  assert.deepEqual(plain(await db.getPageRecord(url)), plain({ ...before, summary: 'A whole-page summary.' }));
  assert.deepEqual(plain(await db.getPageRecord(other)), plain(untouched));
  assert.ok(requests.includes('/api/chat'));
  assert.equal(requests.includes('/api/embed'), false);
  const calls = requests.length;
  const denied = await backend.send({ type: 'REGENERATE_PAGE_SUMMARY', url: other, requestId: 'untrusted' }, { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://example.test/' });
  assert.match(denied.error, /Only Web Recall extension pages/);
  assert.equal(requests.length, calls);
});

test('only extension UI senders can request embedding or summary backfills', async t => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts'); t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord(record('A saved page about local search.'));
  const before = plain(await db.getPageRecord(url)), requests = [];
  const runtime = await backend.load('src/background/orchestration/index.ts', { fetch: async input => {
    const path = new URL(input).pathname; requests.push(path);
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 4096 }] });
    if (path === '/api/chat') return Response.json({ message: { content: 'The page explains local search.' } });
    assert.fail(`Backfill must not request ${path}`);
  } });
  runtime.orchestrateLifecycle();
  const senders = [
    { id: backend.runtime.id, url: 'https://example.test/' },
    { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', url: backend.runtime.getURL('dist/beta/ui/manage/index.html') },
    { id: backend.runtime.id, url: backend.runtime.getURL('dist/beta/offscreen/index.html') },
    {}
  ];
  for (const sender of senders) {
    for (const flags of [{}, { createSummaries: true }, { regenerateSummaries: true }]) {
      const denied = await backend.send({ type: 'BACKFILL_EMBEDDINGS', requestId: 'untrusted-backfill', urls: [url], ...flags }, sender);
      assert.match(denied.error || '', /Only Web Recall extension pages/, 'Untrusted backfill must be rejected before model work starts');
    }
  }
  assert.deepEqual(requests, [], 'Rejected callers must not contact any provider');
  assert.deepEqual(plain(await db.getPageRecord(url)), before);
  const accepted = await backend.send({ type: 'BACKFILL_EMBEDDINGS', requestId: 'ui-backfill', urls: [url], createSummaries: true });
  assert.equal(accepted.result.summariesUpdated, 1);
  assert.equal((await db.getPageRecord(url)).summary, 'The page explains local search.');
  assert.deepEqual(requests.filter(path => path === '/api/chat'), ['/api/chat']);
});

for (const action of ['BACKFILL_EMBEDDINGS', 'REGENERATE_PAGE_SUMMARY']) test(`untrusted cancellation cannot stop a UI-owned ${action} request`, async t => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts'); t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord(record('Saved text that must survive cancellation.'));
  const before = plain(await db.getPageRecord(url)), generation = deferred();
  let signal;
  const runtime = await backend.load('src/background/orchestration/index.ts', { fetch: async (input, options = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 4096 }] });
    if (path === '/api/chat') { signal = options.signal; return generation.promise; }
    assert.fail(`Summary work must not request ${path}`);
  } });
  runtime.orchestrateLifecycle();
  const work = backend.send({ type: action, requestId: 'protected-summary', url, urls: [url], createSummaries: true });
  t.after(async () => { generation.resolve(Response.json({ message: { content: 'Late summary.' } })); await work; });
  await waitFor(() => signal, 'the active summary request');
  for (const sender of [{ id: backend.runtime.id, url: 'https://example.test/' }, { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', url: backend.runtime.getURL('dist/beta/ui/manage/index.html') }]) {
    const denied = await backend.send({ type: 'CANCEL_BACKFILL', requestId: 'protected-summary' }, sender);
    assert.match(denied.error || '', /Only Web Recall extension pages/, 'Untrusted cancellation must be rejected even with a valid active request ID');
    assert.equal(signal.aborted, false, 'An untrusted sender cannot stop a protected summary');
  }
  const stopped = await backend.send({ type: 'CANCEL_BACKFILL', requestId: 'protected-summary' });
  assert.equal(stopped.cancelled, true);
  assert.equal(signal.aborted, true);
  assert.match((await work).error, /Stopped by user/);
  generation.resolve(Response.json({ message: { content: 'Late summary.' } })); await tick();
  assert.deepEqual(plain(await db.getPageRecord(url)), before, 'Stopping must preserve saved text, embeddings and summary state');
});

async function fixture(t, generate = async () => 'A concise saved summary.') {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(async () => (await db.openDatabase()).close());
  let calls = 0, reads = 0;
  const summaries = await loadSource('src/background/summaries/index.ts', '', {
    '../processing/automaticAi': automaticAiEnabled,
    '../storage/manager': { storageManager: { ...db, getPageRecord: async target => { reads++; return db.getPageRecord(target); } } },
    '../providers/chat': { getChatConfig: async signal => ({ providerId: 'ollama', model: 'fixture', contextTokens: 4096, signal }), callChat: async (config, body) => { calls++; return { message: { content: await generate(config, body) } }; } }
  }, { chrome: chromeFixture });
  return { db, summaries, calls: () => calls, reads: () => reads };
}

test('a short whole page is summarized in one inference without loading its vectors for every pass', async t => {
  const requests = [];
  const fixtureState = await fixture(t, async (_config, body) => { requests.push(body); return 'The page explains local search.'; });
  await fixtureState.db.savePageRecord(record('Beginning: local search. Conclusion: everything stays local.'));
  assert.equal(await fixtureState.summaries.queuePageSummary(url), true);
  assert.equal(requests.length, 1, 'A complete page that fits the model window needs one generation');
  assert.ok(requests[0].messages.some(message => message.content.includes('Beginning: local search. Conclusion: everything stays local.')));
  assert.equal(fixtureState.reads(), 1, 'The final database comparison owns stale-content protection');
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, 'The page explains local search.');
});

test('a summary generated for an earlier title cannot be committed after a title-only recapture', async t => {
  const started = deferred(), generation = deferred();
  const state = await fixture(t, async () => { started.resolve(); return generation.promise; });
  await state.db.savePageRecord({ ...record('The same body.'), versionId: 'first-version' });
  const pending = state.summaries.queuePageSummary(url);
  t.after(async () => { generation.resolve('Earlier title overview.'); await pending; });
  await started.promise;
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager: state.db } }, { chrome: chromeFixture });
  await processing.markQueued({ url, title: 'Changed title', text: 'The same body.', chunks: ['The same body.'], timestamp: 2, manual: true, captureId: 'renamed-capture' }, 0);
  generation.resolve('Earlier title overview.');
  assert.equal(await pending, false);
  const saved = await state.db.getPageRecord(url);
  assert.equal(saved.title, 'Changed title');
  assert.equal(saved.summary, undefined);
  assert.notEqual(saved.versionId, 'first-version');
});

for (const includeSignal of [false, true]) test(`explicit regeneration ${includeSignal ? 'with' : 'without'} a caller signal supersedes stalled automatic work without accepting late results`, async t => {
  const started = deferred(), stalled = deferred();
  let automaticSignal;
  const fixtureState = await fixture(t, async (config) => {
    if (!automaticSignal) { automaticSignal = config.signal; started.resolve(); return stalled.promise; }
    return 'Explicit replacement.';
  });
  await fixtureState.db.savePageRecord(record('Saved text.'));
  const automatic = fixtureState.summaries.queuePageSummary(url);
  const stopped = assert.rejects(automatic, /superseded/i);
  await started.promise;
  const explicit = fixtureState.summaries.queuePageSummary(url, includeSignal ? new AbortController().signal : undefined, true);
  let finished = false; explicit.then(() => { finished = true; });
  await waitFor(() => finished, 'explicit generation to bypass the stalled automatic job');
  assert.equal(await explicit, true);
  await stopped;
  assert.equal(automaticSignal.aborted, true);
  stalled.resolve('Late automatic summary.'); await tick();
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, 'Explicit replacement.');
});

test('cancelling a queued summary settles promptly and never starts that inference', async t => {
  const started = deferred(), stalled = deferred();
  const fixtureState = await fixture(t, async () => { started.resolve(); return stalled.promise; });
  await fixtureState.db.savePageRecord(record('Saved text.'));
  const firstController = new AbortController();
  const first = fixtureState.summaries.queuePageSummary(url, firstController.signal);
  const firstStopped = assert.rejects(first, /first stopped/);
  await started.promise;
  const secondController = new AbortController();
  const second = fixtureState.summaries.queuePageSummary(url, secondController.signal);
  let stopped = false;
  const secondStopped = assert.rejects(second, /queued stopped/).then(() => { stopped = true; });
  secondController.abort(Error('queued stopped'));
  await waitFor(() => stopped, 'queued cancellation without finishing its predecessor');
  await secondStopped;
  assert.equal(fixtureState.calls(), 1);
  firstController.abort(Error('first stopped')); await firstStopped;
  stalled.resolve('Late output.'); await tick();
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, undefined);
});

test('capture schedules summarization only after storage succeeds and does not wait for inference', async () => {
  const pending = deferred(), actions = [];
  const processor = await loadSource('src/background/capture/processor.ts', '', {
    '../processing/automaticAi': automaticAiEnabled,
    '../storage/index': { whenStorageReady: async () => {} },
    '../storage/manager': { storageManager: { savePageRecord: async () => actions.push('saved') } },
    '../embeddings/index': { getEmbeddingConfig: () => ({}), embedPayloadChunks: async () => [[1, 0]] },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} },
    '../summaries/index': { queuePageSummary: target => { assert.equal(target, url); actions.push('summary'); return pending.promise; } }
  });
  await processor.processCapturePayload({ ...record('Captured text'), chunks: ['Captured text'] });
  assert.deepEqual(actions, ['saved', 'summary']);
  pending.resolve(false);
});

test('backfill returns phase-specific embedding failures even when the summary succeeds', async t => {
  const fixtureState = await fixture(t);
  await fixtureState.db.savePageRecord({ ...record('Captured facts.'), chunks: [{ text: 'Captured facts.', embedding: [] }] });
  const reason = 'This browser model is not downloaded. Open Settings to download it.';
  const backfill = await loadSource('src/background/embeddings/backfill.ts', '', {
    '../storage/manager': { storageManager: fixtureState.db },
    './index': { getEmbeddingConfig: () => ({ provider: 'browser' }), computeEmbeddingsForChunks: async () => { throw Error(reason); } },
    '../summaries/index': { queuePageSummary: fixtureState.summaries.queuePageSummary },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} },
    '../../shared/logger/index': { log: async () => {} }
  });
  const result = await backfill.backfillMissingEmbeddings(1, true, [url], undefined, undefined, true);
  assert.equal(result.failed, 1);
  assert.equal(result.summariesUpdated, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].url, url);
  assert.equal(result.failures[0].phase, 'embeddings');
  assert.ok(result.failures[0].error.includes(reason));
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, 'A concise saved summary.');
  assert.deepEqual(plain((await fixtureState.db.getPageRecord(url)).chunks[0].embedding), []);
});

test('automatic capture logs embedding and summary failures separately without discarding saved text', async () => {
  const events = [], saved = [];
  const processor = await loadSource('src/background/capture/processor.ts', '', {
    '../processing/automaticAi': automaticAiEnabled,
    '../storage/index': { whenStorageReady: async () => {} },
    '../storage/manager': { storageManager: { savePageRecord: async page => saved.push(page) } },
    '../embeddings/index': { getEmbeddingConfig: () => ({}), embedPayloadChunks: async () => { throw Error('Model download missing'); } },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} },
    '../summaries/index': { queuePageSummary: async () => { throw Error('Apple model unavailable'); } },
    '../../shared/logger/index': { log: async (level, message, data) => events.push({ level, message, data }) }
  });
  await processor.processCapturePayload({ ...record('Captured text'), chunks: ['Captured text'] });
  await tick();
  assert.equal(saved[0].text, 'Captured text');
  assert.ok(events.some(event => event.level === 'warn' && event.data.url === url && event.data.phase === 'embeddings' && event.data.error?.includes('Model download missing')));
  assert.ok(events.some(event => event.level === 'warn' && event.data.url === url && event.data.phase === 'summary' && event.data.error?.includes('Apple model unavailable')));
});

test('summaries are reused across recapture and embedding updates but invalidated by changed saved text', async t => {
  const fixtureState = await fixture(t);
  await fixtureState.db.savePageRecord(record('Original captured facts.'));
  assert.equal(await fixtureState.summaries.queuePageSummary(url), true);
  const initialCalls = fixtureState.calls();
  const first = await fixtureState.db.getPageRecord(url);
  await fixtureState.db.savePageRecord(record('Original captured facts.'));
  assert.equal(await fixtureState.summaries.queuePageSummary(url), false);
  assert.equal(fixtureState.calls(), initialCalls);
  assert.deepEqual(plain((await fixtureState.db.getPageRecord(url)).chunks), plain(first.chunks));
  await fixtureState.db.savePageRecord({ ...first, text: 'Changed captured facts.' });
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, undefined);
  assert.equal(await fixtureState.summaries.queuePageSummary(url), true);
  assert.ok(fixtureState.calls() > initialCalls);
});

for (const change of ['delete', 'replace']) test(`an in-flight summary cannot overwrite a page after ${change}`, async t => {
  const started = deferred(), pending = deferred();
  const fixtureState = await fixture(t, async () => { started.resolve(); return pending.promise; });
  await fixtureState.db.savePageRecord(record('Original saved facts.'));
  const job = fixtureState.summaries.queuePageSummary(url); await started.promise;
  if (change === 'delete') await fixtureState.db.deletePages([url]);
  else await fixtureState.db.savePageRecord(record('Replacement saved facts.'), { replace: true });
  pending.resolve('Old summary.');
  assert.equal(await job, false);
  assert.equal((await fixtureState.db.getPageRecord(url))?.summary, undefined);
  assert.equal((await fixtureState.db.getPageRecord(url))?.text, change === 'delete' ? undefined : 'Replacement saved facts.');
});

test('a failed model leaves captures intact and does not poison the summary queue', async t => {
  let fail = true;
  const fixtureState = await fixture(t, async () => { if (fail) throw new Error('Model unavailable'); return 'Saved summary.'; });
  await fixtureState.db.savePageRecord(record('Facts retained without a model.'));
  await assert.rejects(fixtureState.summaries.queuePageSummary(url), /Model unavailable/);
  assert.equal((await fixtureState.db.getPageRecord(url)).text, 'Facts retained without a model.');
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, undefined);
  fail = false;
  assert.equal(await fixtureState.summaries.queuePageSummary(url), true);
});

test('Stop during generation prevents a late summary write', async t => {
  const pending = deferred(), started = deferred(), controller = new AbortController();
  const fixtureState = await fixture(t, async () => { started.resolve(); return pending.promise; });
  await fixtureState.db.savePageRecord(record('Captured text.'));
  const job = fixtureState.summaries.queuePageSummary(url, controller.signal); await started.promise;
  controller.abort(new Error('Stopped')); pending.resolve('Late summary.');
  await assert.rejects(job, /Stopped/);
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, undefined);
});

test('summary and vector updates preserve each other across either completion order', async t => {
  const started = deferred(), pending = deferred();
  const fixtureState = await fixture(t, async () => { started.resolve(); return pending.promise; });
  await fixtureState.db.savePageRecord({ ...record('Concurrent saved text.'), summary: '' });
  const before = await fixtureState.db.getPageRecord(url);
  const job = fixtureState.summaries.queuePageSummary(url); await started.promise;
  const chunks = [{ ...before.chunks[0], embedding: [0, 1], embeddingKey: 'new-space' }];
  await fixtureState.db.savePageRecord({ ...before, chunks });
  pending.resolve('Summary of concurrent saved text.'); await job;
  assert.deepEqual(plain((await fixtureState.db.getPageRecord(url)).chunks), chunks);
  await fixtureState.db.savePageRecord({ ...before, chunks });
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, 'Summary of concurrent saved text.');
});

for (const answer of ['', 'x'.repeat(5000)]) test(`invalid ${answer ? 'oversized' : 'empty'} summaries are not persisted`, async t => {
  const fixtureState = await fixture(t, async () => answer);
  await fixtureState.db.savePageRecord(record('Saved original text.'));
  await assert.rejects(fixtureState.summaries.queuePageSummary(url), /empty or oversized/);
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, undefined);
});

test('preview prefers a stored summary without replacing the captured evidence', async t => {
  const fixtureState = await fixture(t);
  await fixtureState.db.savePageRecord({ ...record('Original saved evidence.'), summary: 'Short summary.' });
  const manage = await loadSource('src/background/manage/index.ts', '', {
    '../storage/manager': { storageManager: fixtureState.db },
    '../capture/index': { cancelCaptureJobs: async () => assert.fail('Reading summary metadata must not cancel captures') },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', model: 'fixture', baseUrl: 'http://localhost:11434' }) }
  }, { chrome: chromeFixture });
  const preview = await manage.getPagePreview(url);
  assert.equal(preview.snippet, 'Short summary.'); assert.equal(preview.previewKind, 'summary');
  assert.equal((await manage.getManagePages()).find(page => page.url === url).hasSummary, true, 'Memory metadata and preview must agree about the committed summary');
  assert.equal((await fixtureState.db.getPageRecord(url)).text, 'Original saved evidence.');
});

test('summary backfill is opt-in, includes already-embedded pages, respects selected URLs and replaces summaries only on explicit regeneration', async t => {
  const fixtureState = await fixture(t);
  const other = 'https://example.test/other', filled = 'https://example.test/filled';
  await fixtureState.db.savePageRecord(record('First article.'));
  await fixtureState.db.savePageRecord({ ...record('Second article.'), url: other });
  await fixtureState.db.savePageRecord({ ...record('Summarized article.'), url: filled, summary: 'Existing summary.' });
  const backfill = await loadSource('src/background/embeddings/backfill.ts', '', {
    '../storage/manager': { storageManager: fixtureState.db },
    './index': { getEmbeddingConfig: () => ({}), computeEmbeddingsForChunks: async () => assert.fail('Already-filled vectors must not be regenerated') },
    '../summaries/index': { queuePageSummary: fixtureState.summaries.queuePageSummary },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} },
    '../../shared/logger/index': { log: async () => {} }
  });
  await backfill.backfillMissingEmbeddings(50, false);
  assert.equal(fixtureState.calls(), 0);
  const progress = [];
  const result = await backfill.backfillMissingEmbeddings(50, false, [url, filled], event => progress.push(event), undefined, true);
  assert.equal(result.summariesUpdated, 1);
  const generatedCalls = fixtureState.calls(); assert.ok(generatedCalls > 0);
  assert.equal((await fixtureState.db.getPageRecord(other)).summary, undefined);
  assert.equal((await fixtureState.db.getPageRecord(filled)).summary, 'Existing summary.');
  assert.ok(progress.some(event => event.phase === 'summaries' && event.status === 'complete'));
  await backfill.backfillMissingEmbeddings(50, false, [url, filled], undefined, undefined, true);
  assert.equal(fixtureState.calls(), generatedCalls);
  await backfill.backfillMissingEmbeddings(1, false, [], undefined, undefined, true);
  assert.equal(fixtureState.calls(), generatedCalls);
  const regenerated = await backfill.backfillMissingEmbeddings(1, false, [filled], undefined, undefined, false, true);
  assert.equal(regenerated.summariesUpdated, 1);
  assert.ok(fixtureState.calls() > generatedCalls);
  assert.equal((await fixtureState.db.getPageRecord(filled)).summary, 'A concise saved summary.');
  assert.equal((await fixtureState.db.getPageRecord(other)).summary, undefined);
});

test('long Unicode captures are processed in bounded sections before one final summary is committed', async t => {
  const fixtureState = await fixture(t, async (_config, body) => {
    const user = body.messages.find(message => message.role === 'user').content;
    const bytes = new TextEncoder().encode(body.messages.map(message => message.content).join('\n')).length;
    assert.ok(bytes + body.options.num_predict < 4096, 'input and output reservation must fit the configured model window, including multi-byte characters');
    return 'A concise summary of the article.';
  });
  await fixtureState.db.savePageRecord(record('天文記事。'.repeat(1200)));
  assert.equal(await fixtureState.summaries.queuePageSummary(url), true);
  assert.ok(fixtureState.calls() > 1);
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, 'A concise summary of the article.');
});

test('whole-page synthesis retains beginning, middle and conclusion through multiple reduction levels instead of returning the last section', async t => {
  const facts = ['Find remembered pages locally.', 'Search and Ask use saved evidence.', 'Keep private browsing data local.'];
  const markers = ['RAW_BEGIN', 'RAW_MIDDLE', 'RAW_END'];
  const calls = [];
  const fixtureState = await fixture(t, async (_config, body) => {
    const user = body.messages.find(message => message.role === 'user').content;
    calls.push(user);
    const raw = markers.map((marker, index) => user.includes(marker) ? index : -1).filter(index => index >= 0);
    const selected = raw.length ? raw.map(index => facts[index]) : facts.filter(fact => user.includes(fact));
    return [...selected, 'Supporting context. '.repeat(12)].join(' ');
  });
  const filler = 'Additional explanatory material. '.repeat(500);
  const text = 'Navigation and introductory context. '.repeat(20) + ' RAW_BEGIN ' + filler + ' RAW_MIDDLE ' + filler + ' RAW_END ';
  await fixtureState.db.savePageRecord({ ...record(text), title: 'A local-first browser memory tool' });
  assert.equal(await fixtureState.summaries.queuePageSummary(url), true);
  const saved = await fixtureState.db.getPageRecord(url);
  for (const fact of facts) assert.ok(saved.summary.includes(fact), `the final summary must retain: ${fact}`);
  assert.equal(fixtureState.reads(), 1, 'Long-page inference must reuse its snapshot instead of reloading saved vectors on every model call');
  const finalInput = calls.at(-1);
  for (const fact of facts) assert.ok(finalInput.includes(fact), 'whole-page synthesis must receive evidence from every part, not only the last notes');
  for (const input of calls.filter(input => markers.some(marker => input.includes(marker)))) {
    assert.ok(!facts.some(fact => input.includes(fact)), 'section extraction must not overwrite a rolling prior summary');
  }
  assert.ok(calls.filter(input => !markers.some(marker => input.includes(marker))).length > 2, 'large documents must reduce notes in bounded groups before final synthesis');
});

test('regeneration is explicit and preserves the old summary until a successful replacement is committed', async t => {
  const started = deferred(), pending = deferred();
  const fixtureState = await fixture(t, async () => { started.resolve(); return pending.promise; });
  await fixtureState.db.savePageRecord({ ...record('Saved article.'), summary: 'Old narrow summary.' });
  assert.equal(await fixtureState.summaries.queuePageSummary(url), false);
  assert.equal(fixtureState.calls(), 0);
  const job = fixtureState.summaries.queuePageSummary(url, undefined, true); await started.promise;
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, 'Old narrow summary.');
  pending.resolve('A whole-page overview.'); assert.equal(await job, true);
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, 'A whole-page overview.');
});

test('an embedding update from an older snapshot cannot revert a regenerated summary', async t => {
  const fixtureState = await fixture(t);
  await fixtureState.db.savePageRecord({ ...record('Same captured content.'), summary: 'Old summary.' });
  const snapshot = await fixtureState.db.getPageRecord(url);
  assert.equal(await fixtureState.db.savePageSummary(url, snapshot.text, 'Regenerated overview.', undefined, snapshot.summary), true);
  const chunks = [{ ...snapshot.chunks[0], embedding: [0, 1] }];
  await fixtureState.db.savePageRecord({ ...snapshot, chunks }, { expectedUpdatedAt: snapshot.updatedAt });
  const current = await fixtureState.db.getPageRecord(url);
  assert.equal(current.summary, 'Regenerated overview.');
  assert.deepEqual(plain(current.chunks), chunks);
});

for (const change of ['failure', 'cancel', 'newer-summary', 'newer-content']) test(`regeneration cannot discard a saved summary on ${change}`, async t => {
  const started = deferred(), pending = deferred(), controller = new AbortController();
  const fixtureState = await fixture(t, async () => { started.resolve(); const value = await pending.promise; if (change === 'failure') throw new Error('Unavailable'); return value; });
  await fixtureState.db.savePageRecord({ ...record('Saved article.'), summary: 'Original summary.' });
  const job = fixtureState.summaries.queuePageSummary(url, controller.signal, true); await started.promise;
  if (change === 'cancel') controller.abort(new Error('Stopped'));
  if (change === 'newer-summary') {
    assert.equal(await fixtureState.db.savePageSummary(url, 'Saved article.', 'Newer summary.', undefined, 'Original summary.'), true);
    assert.equal(await fixtureState.db.savePageSummary(url, 'Saved article.', 'Outdated result.', undefined, 'Original summary.'), false, 'the atomic commit must compare the previous summary, not overwrite a newer replacement');
  }
  if (change === 'newer-content') await fixtureState.db.savePageRecord({ ...record('New article.'), summary: 'New content summary.' }, { replace: true });
  pending.resolve('Late replacement.');
  if (change === 'failure' || change === 'cancel') await assert.rejects(job, /Unavailable|Stopped/);
  else assert.equal(await job, false);
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, change === 'newer-summary' ? 'Newer summary.' : change === 'newer-content' ? 'New content summary.' : 'Original summary.');
});

for (const existing of [undefined, 'Keep this saved summary.']) test(`individual forced re-embedding ${existing ? 'preserves an existing summary' : 'creates a missing summary after replacing vectors'}`, async t => {
  let fixtureState;
  fixtureState = await fixture(t, async () => {
    assert.equal(existing, undefined, 'existing summaries must not trigger generation');
    assert.deepEqual(plain((await fixtureState.db.getPageRecord(url)).chunks[0].embedding), [0, 1], 'summary generation must follow the committed embedding update');
    return 'New summary for this page.';
  });
  await fixtureState.db.savePageRecord({ ...record('Selected saved text.'), summary: existing });
  const other = 'https://example.test/not-selected';
  await fixtureState.db.savePageRecord({ ...record('Other saved text.'), url: other });
  const backfill = await loadSource('src/background/embeddings/backfill.ts', '', {
    '../storage/manager': { storageManager: fixtureState.db },
    './index': { getEmbeddingConfig: () => ({ provider: 'ollama', model: 'test', baseUrl: 'http://localhost:11434' }), computeEmbeddingsForChunks: async () => [[0, 1]] },
    '../summaries/index': { queuePageSummary: fixtureState.summaries.queuePageSummary },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} },
    '../../shared/logger/index': { log: async () => {} }
  });
  const result = await backfill.backfillMissingEmbeddings(1, true, [url], undefined, undefined, true);
  assert.equal(result.updated, 1);
  assert.equal(result.summariesUpdated, existing ? 0 : 1);
  assert.equal(fixtureState.calls() > 0, !existing);
  assert.equal((await fixtureState.db.getPageRecord(url)).summary, existing || 'New summary for this page.');
  assert.equal((await fixtureState.db.getPageRecord(other)).summary, undefined);
  assert.deepEqual(plain((await fixtureState.db.getPageRecord(other)).chunks[0].embedding), [1, 0]);
});
