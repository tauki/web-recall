import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, chromeFixture, plain, tick } from './helpers.mjs';

const page = (url = 'https://example.test') => ({ url, title: 'Article', text: 'text', timestamp: 1, manual: false, chunks: [{ text: 'private text', embedding: [1, 0], embeddingKey: 'test' }] });
async function database() { return loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange }); }
async function rows(db, store) { return new Promise((resolve, reject) => { const req = db.transaction(store).objectStore(store).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

test('deletion removes associated text, vectors, pending work and highlight cache, preserving other pages', async () => {
  const mod = await database();
  await mod.savePageRecord(page());
  await mod.savePageRecord(page('https://keep.test'));
  await mod.appendProcessing({ url: page().url, status: 'queued', payload: { text: 'private text' } });
  await mod.upsertHighlight({ date: '2026-09-18', payload: { text: 'private text' } });
  await mod.deletePages([page().url]);
  const db = await mod.openDatabase();
  assert.equal((await rows(db, 'pages')).length, 1);
  assert.deepEqual((await rows(db, 'embeddings')).map(row => row.pageUrl), ['https://keep.test']);
  assert.equal((await rows(db, 'processing')).length, 0);
  assert.equal((await rows(db, 'highlights')).length, 0);
});

test('compare-and-save rejects stale backfill and deleted capture work atomically', async () => {
  const mod = await database();
  await mod.savePageRecord(page());
  const old = await mod.getPageRecord(page().url);
  await mod.deletePages([page().url]);
  await assert.rejects(mod.savePageRecord(old, { expectedUpdatedAt: old.updatedAt }));
  await assert.rejects(mod.savePageRecord(page(), { requireProcessing: true }));
  assert.equal(await mod.getPageRecord(page().url), undefined);
  assert.equal((await rows(await mod.openDatabase(), 'embeddings')).length, 0);
});

async function backfillFixture(vectors) {
  let current = { ...page(), updatedAt: 123, chunks: [{ text: 'already filled', embedding: [9, 9], embeddingKey: 'old' }, { text: 'missing', embedding: [] }] };
  const requests = []; let invalidations = 0;
  const mod = await loadSource('src/background/embeddings/backfill.ts', '', {
    './index': { getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }), computeEmbeddingsForChunks: async texts => { requests.push(plain(texts)); return vectors; } },
    '../storage/manager': { storageManager: { listAllPages: async () => [current], getPageRecord: async () => current, savePageRecord: async value => { current = value; } } },
    '../offscreen/index': { invalidateOffscreenIndex: async () => { invalidations++; } },
    '../../shared/logger/index': { log: async () => {} }
  });
  return { mod, requests, current: () => current, invalidations: () => invalidations };
}
test('missing-only backfill requests just missing chunks and invalidates retrieval', async () => {
  const f = await backfillFixture([[1, 2]]);
  const result = await f.mod.backfillMissingEmbeddings();
  assert.deepEqual(f.requests, [['missing']]);
  assert.deepEqual(plain(f.current().chunks[0].embedding), [9, 9]);
  assert.deepEqual(plain(f.current().chunks[1].embedding), [1, 2]);
  assert.equal(result.updated, 1); assert.equal(f.invalidations(), 1);
});
test('failed forced backfill preserves all prior vectors and reports failure', async () => {
  const f = await backfillFixture([[], []]);
  const result = await f.mod.backfillMissingEmbeddings(50, true);
  assert.equal(result.updated, 0); assert.equal(result.failed, 1);
  assert.deepEqual(f.current().chunks[0].embedding, [9, 9]);
  assert.equal(f.invalidations(), 0);
});
test('empty explicit backfill targets never select the whole library', async () => {
  const f = await backfillFixture([[1, 2]]);
  const result = await f.mod.backfillMissingEmbeddings(50, true, []);
  assert.equal(result.processed, 0); assert.equal(f.requests.length, 0);
});

test('browser provider can be disabled and partial model updates preserve custom endpoint', async () => {
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({ runtimeAvailable: true }) }
  }, { chrome: chromeFixture });
  await mod.updateEmbeddingConfig({ provider: 'browser', baseUrl: 'http://localhost:11435' });
  await mod.updateEmbeddingConfig({ provider: 'ollama' });
  assert.equal(mod.getEmbeddingConfig().provider, 'ollama');
  await mod.updateEmbeddingConfig({ model: 'different' });
  assert.equal(mod.getEmbeddingConfig().baseUrl, 'http://localhost:11435');
});

test('browser loading retries after a transient model download failure', async () => {
  let attempts = 0;
  const mod = await loadSource('src/offscreen/index.ts', 'getBrowserEmbedder', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    '@huggingface/transformers': { env: { backends: { onnx: { wasm: {} } } }, AutoTokenizer: { from_pretrained: async () => { if (++attempts === 1) throw Error('network unavailable'); return () => ({}); } }, AutoModel: { from_pretrained: async () => () => ({}) } }
  }, { chrome: chromeFixture });
  await assert.rejects(mod.getBrowserEmbedder('model', 'revision'));
  await mod.getBrowserEmbedder('model', 'revision');
  assert.equal(attempts, 2);
});
test('vector dimensions must match and a missing first vector does not hide the page', async () => {
  const mod = await loadSource('src/shared/vectors.ts');
  assert.equal(mod.cosineSimilarity([1, 0], [1, 0, 999]), 0);
  assert.deepEqual(plain(mod.computeCentroid([{ embedding: [] }, { embedding: [1, 0] }])), [1, 0]);
});

const chatMocks = {
  '../models/index': { getModelSettings: async () => ({}) },
  '../settings/index': { getSettings: async () => ({}) },
  './config': { getProviderBaseUrl: async () => 'http://localhost:11434' }
};
test('provider accepts object and JSON tool arguments but rejects malformed data', async () => {
  const mod = await loadSource('src/background/providers/chat.ts', '', chatMocks);
  assert.deepEqual(plain(mod.normalizeToolArguments({ query: 'cats' })), { query: 'cats' });
  assert.deepEqual(plain(mod.normalizeToolArguments('{"url":"https://example.test"}')), { url: 'https://example.test' });
  assert.throws(() => mod.normalizeToolArguments('[]'));
});
test('streaming delivers progressive text including split unicode and trailing NDJSON', async () => {
  const encoded = new TextEncoder().encode('{"message":{"content":"café"}}\n{"message":{"content":" here"}}');
  const chunks = [encoded.slice(0, 25), encoded.slice(25, 28), encoded.slice(28)];
  const updates = [];
  const mod = await loadSource('src/background/providers/chat.ts', '', chatMocks, { fetch: async () => ({ ok: true, body: new ReadableStream({ start(controller) { chunks.forEach(chunk => controller.enqueue(chunk)); controller.close(); } }) }) });
  const answer = await mod.streamChat({ baseUrl: 'http://localhost' }, {}, text => updates.push(text));
  assert.equal(answer, 'café here'); assert.deepEqual(updates, ['café', 'café here']);
});

const askMocks = {
  '../storage/manager': { storageManager: { getPageRecord: async () => ({ title: 'Article', chunks: [{ text: 'UNRELATED HEADER' }, { text: 'RELEVANT PASSAGE' }] }) } },
  '../search/index': { searchStoredPages: async () => [] },
  '../../shared/tools/index': { ToolsRuntime: class {} },
  '../providers/chat': { callChat: async () => ({}), callChatJson: async () => null, getChatConfig: async () => ({}), normalizeToolArguments: value => value, streamChat: async () => '' },
  '../settings/index': { getSettings: async () => ({}) },
  '../calibration/index': { getCalibrationSnapshot: () => ({ wLLM: 0 }) }
};
test('Ask synthesis keeps selected passages; references resolve against all supplied sources', async () => {
  const mod = await loadSource('src/background/ask/index.ts', 'buildContextBlocks, buildContextFromSources, filterSourcesByCitations, hasValidCitations', askMocks, { chrome: chromeFixture });
  const { sources } = await mod.buildContextBlocks([{ url: 'https://a.test', chunkIndex: 1, snippet: 'RELEVANT PASSAGE' }], 1200);
  const blocks = await mod.buildContextFromSources(sources, 1200);
  assert.match(blocks, /RELEVANT PASSAGE/); assert.doesNotMatch(blocks, /UNRELATED HEADER/);
  sources.push({ index: 2, url: 'https://b.test' });
  assert.deepEqual(plain(mod.filterSourcesByCitations(sources, 'Fact [1]')).map(source => source.index), [1]);
  assert.equal(mod.filterSourcesByCitations(sources, 'Fact [99]').length, 0);
  assert.equal(mod.filterSourcesByCitations(sources, 'No citation').length, 0);
  assert.equal(mod.hasValidCitations('Fact [1], invented [99]', sources), false);
});

test('queued and interrupted captures are recovered and completed on worker startup', async () => {
  const entries = new Map(['queued', 'processing'].map((status, index) => [`https://${index}.test`, { url: `https://${index}.test`, status, attempts: 1, payload: { url: `https://${index}.test`, chunks: ['text'] } }]));
  const processed = [];
  const mod = await loadSource('src/background/capture/index.ts', '', {
    './processor': { processCapturePayload: async payload => { processed.push(payload.url); } },
    '../settings/index': { shouldCaptureUrl: async () => true, getCachedSettingsSnapshot: () => ({}) },
    '../processing/index': { listProcessingEntries: async () => [...entries.values()], getProcessingEntryByUrl: async url => entries.get(url), markQueued: async () => {}, markProcessing: async () => {}, markFailed: async () => {}, markDone: async url => entries.delete(url) },
    '../../shared/logger/index': { log: async () => {} }
  }, { chrome: chromeFixture });
  const queue = mod.createCaptureQueue(); await queue.ready; await tick();
  assert.equal(processed.length, 2); assert.equal(entries.size, 0);
});

test('tool evidence receives stable source IDs across repeated reads', async () => {
  const { ToolsRuntime } = await loadSource('src/shared/tools/runtime.ts');
  const seen = new Map();
  const runtime = new ToolsRuntime({ allowedUrls: new Set(['https://example.test']), pageText: new Map(), pages: [{ ...page(), summary: 'Source evidence' }], searchMemory: async () => [], quickSearchMemory: async () => [], recordEvidence: (url, text) => { assert.equal(text, 'Source evidence'); if (!seen.has(url)) seen.set(url, seen.size + 1); return seen.get(url); } });
  const first = JSON.parse((await runtime.runToolCall('get_page_summary', { url: 'https://example.test' })).content);
  assert.equal(first.data.sourceIndex, 1);
  assert.equal(seen.size, 1);
});

test('search reranking sees the matched chunk, not the page introduction', async () => {
  const mod = await loadSource('src/background/search/index.ts', 'enrichRerankCandidates', {
    '../storage/manager': { storageManager: { getPageRecord: async () => ({ title: 'Article', chunks: [{ text: 'unrelated introduction' }, { text: 'matching evidence' }] }) } },
    '../calibration/index': { getCalibrationSnapshot: () => ({ wLLM: 0 }) },
    '../embeddings/index': { computeEmbeddingsForQueries: async () => [], getEmbeddingConfig: () => ({}) },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({}) },
    '../providers/chat': { callChat: async () => ({}), callChatJson: async () => ({}), getChatConfig: async () => ({}) },
    '../settings/index': { getSettings: async () => ({}) }
  });
  const result = await mod.enrichRerankCandidates([{ url: page().url, chunkIndex: 1 }]);
  assert.equal(result[0].snippet, 'matching evidence');
});

test('a stream-level provider error is surfaced instead of returning partial success', async () => {
  const mod = await loadSource('src/background/providers/chat.ts', '', chatMocks, { fetch: async () => ({ ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":"model failed"}\n')); controller.close(); } }) }) });
  await assert.rejects(mod.streamChat({ baseUrl: 'http://localhost' }, {}, () => {}), /model failed/);
});

test('failed job persistence is not acknowledged or processed', async () => {
  const mod = await loadSource('src/background/capture/index.ts', '', {
    './processor': { processCapturePayload: async () => { throw Error('must not process'); } },
    '../settings/index': { shouldCaptureUrl: async () => true, getCachedSettingsSnapshot: () => ({}) },
    '../processing/index': { listProcessingEntries: async () => [], getProcessingEntryByUrl: async () => {}, markQueued: async () => { throw Error('quota'); }, markProcessing: async () => {}, markFailed: async () => {}, markDone: async () => {} },
    '../../shared/logger/index': { log: async () => {} }
  }, { chrome: chromeFixture });
  const queue = mod.createCaptureQueue();
  await assert.rejects(queue.enqueue({ url: page().url, chunks: [] }), /quota/);
  assert.equal(queue.peekQueue().length, 0);
});
