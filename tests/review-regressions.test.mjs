import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, chromeFixture, plain, tick } from './helpers.mjs';

const url = 'https://example.test/article';
const page = (overrides = {}) => ({ url, title: 'Article', text: 'current text', timestamp: Date.now(), manual: false, chunks: [{ text: 'current text', embedding: [1, 0], embeddingKey: 'old' }], ...overrides });
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
const legacyPage = () => ({ url, title: 'Legacy article', timestamp: 20, manual: true, latestVersionIndex: 1, versions: [
  { timestamp: 10, items: [{ text: 'earlier passage', embedding: [0, 1] }], summary: 'Earlier summary' },
  { timestamp: 20, items: [{ text: 'latest passage', embedding: [1, 0] }], summary: 'Latest summary' }
] });

test('opening storage migrates the 0.1 library and versions once, without restoring deleted pages', async () => {
  const indexedDB = new IDBFactory();
  await seedLegacy(indexedDB, [legacyPage()]);
  const mod = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  const record = await mod.getPageRecord(url);
  assert.equal(record.text, 'latest passage');
  assert.equal(record.summary, 'Latest summary');
  assert.equal(record.manual, true);
  assert.deepEqual(plain(record.chunks[0].embedding), [1, 0]);
  assert.equal(record.chunks[0].embeddingKey, undefined);
  assert.equal(record.versions[0].chunks[0].text, 'earlier passage');
  const db = await mod.openDatabase();
  assert.equal(await new Promise(resolve => { const r = db.transaction('embeddings').objectStore('embeddings').count(); r.onsuccess = () => resolve(r.result); }), 1);
  await mod.deletePages([url]);
  db.close();
  const restarted = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  assert.equal(await restarted.getPageRecord(url), undefined);
  assert.ok((await indexedDB.databases()).some(db => db.name === 'webMemoryDB'), 'the original database is retained as a backup');
});

test('migration failure retains the source and retries without a partial library or completion marker', async () => {
  const indexedDB = new IDBFactory();
  await seedLegacy(indexedDB, [legacyPage(), { url: 'https://invalid.test', items: [{ text: 'bad vector', embedding: [NaN] }] }]);
  const mod = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  await assert.rejects(mod.openDatabase(), /non-numeric/);
  const target = await new Promise(resolve => { const r = indexedDB.open('webRecallBeta'); r.onsuccess = () => resolve(r.result); });
  for (const store of ['pages', 'embeddings', 'migrations']) {
    const count = await new Promise(resolve => { const r = target.transaction(store).objectStore(store).count(); r.onsuccess = () => resolve(r.result); });
    assert.equal(count, 0);
  }
  target.close();
  await seedLegacy(indexedDB, [{ id: 2, url: 'https://invalid.test', items: [{ text: 'fixed vector', embedding: [1, 0] }] }]);
  assert.equal((await mod.listAllPages()).length, 2);
});

test('empty legacy captures do not block migration or discard metadata and older versions', async () => {
  const indexedDB = new IDBFactory();
  const empty = { url: 'https://empty.test', title: 'Capture without embeddings', timestamp: 30, manual: true, items: [] };
  const versioned = { url: 'https://versions.test', title: 'Latest capture empty', timestamp: 40, latestVersionIndex: 1, versions: [
    { timestamp: 10, items: [{ text: 'Previous captured passage', embedding: [0, 1] }] },
    { timestamp: 40, items: [], summary: 'Saved summary' }
  ] };
  await seedLegacy(indexedDB, [empty, legacyPage(), versioned]);
  const mod = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  assert.equal((await mod.listAllPages()).length, 3);
  assert.equal((await mod.getPageRecord(url)).text, 'latest passage');
  const migrated = await mod.getPageRecord(empty.url);
  assert.equal(migrated.title, empty.title);
  assert.equal(migrated.timestamp, empty.timestamp);
  assert.equal(migrated.manual, true);
  assert.equal(migrated.text, '');
  assert.deepEqual(plain(migrated.chunks), []);
  const history = await mod.getPageRecord(versioned.url);
  assert.equal(history.text, '');
  assert.deepEqual(plain(history.chunks), []);
  assert.equal(history.summary, 'Saved summary');
  assert.equal(history.versions.length, 2);
  assert.equal(history.versions[0].text, 'Previous captured passage');
  assert.deepEqual(plain(history.versions[0].chunks[0].embedding), [0, 1]);
  const db = await mod.openDatabase();
  const count = await new Promise(resolve => { const r = db.transaction('embeddings').objectStore('embeddings').count(); r.onsuccess = () => resolve(r.result); });
  assert.equal(count, 1, 'empty captures must not manufacture vectors or reuse older versions as current');
  await mod.deletePages([empty.url]);
  db.close();
  const restarted = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  assert.equal((await restarted.listAllPages()).length, 2);
  assert.equal(await restarted.getPageRecord(empty.url), undefined, 'the completed migration must not restore a deleted empty capture');
  (await restarted.openDatabase()).close();
});

test('upgrade preserves existing 0.2 captures and copies the old versions only once across contexts', async () => {
  const indexedDB = new IDBFactory();
  const target = await new Promise(resolve => {
    const r = indexedDB.open('webRecallBeta', 2);
    r.onupgradeneeded = () => {
      const pages = r.result.createObjectStore('pages', { keyPath: 'url' });
      pages.createIndex('timestamp', 'timestamp');
      const embeddings = r.result.createObjectStore('embeddings', { keyPath: 'key' });
      embeddings.createIndex('pageUrl', 'pageUrl');
      r.result.createObjectStore('processing', { keyPath: 'url' });
      r.result.createObjectStore('highlights', { keyPath: 'date' });
      r.result.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
  });
  await new Promise(resolve => { const tx = target.transaction('pages', 'readwrite'); tx.objectStore('pages').put(page()); tx.oncomplete = resolve; });
  target.close();
  await seedLegacy(indexedDB, [legacyPage()]);
  const [first, second] = await Promise.all([1, 2].map(() => loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange })));
  const records = await Promise.all([first.getPageRecord(url), second.getPageRecord(url)]);
  records.forEach(record => { assert.equal(record.text, 'current text'); assert.equal(record.versions.length, 2); });
});

test('legacy exports retain text, vectors and version history through import and export', async () => {
  const saved = [];
  const mod = await loadSource('src/background/manage/index.ts', '', {
    '../capture/index': { cancelCaptureJobs() {} },
    '../embeddings/index': { getEmbeddingConfig: () => ({}) },
    '../storage/manager': { storageManager: { savePageRecord: async record => saved.push(plain(record)), listAllPages: async () => saved } },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  });
  await mod.importManagePages({ schemaVersion: 1, pages: [legacyPage(), { url: 'https://plain.test', items: [{ text: 'single version body', embedding: [2, 3] }] }] });
  const exported = await mod.exportManagePages();
  assert.equal(exported[0].text, 'latest passage');
  assert.equal(exported[0].versions[0].chunks[0].text, 'earlier passage');
  assert.deepEqual(exported[1].chunks[0].embedding, [2, 3]);
  assert.equal(exported[1].text, 'single version body');
  await assert.rejects(mod.importManagePages({ schemaVersion: 1, pages: [{ url, title: 'Unknown format' }] }), /content|chunks|text/i);
  assert.equal(saved.length, 2);
  await assert.rejects(mod.importManagePages({ schemaVersion: 1, pages: [legacyPage(), { url, title: 'Invalid second page' }] }));
  assert.equal(saved.length, 2, 'validate every page before replacing existing content');
  await assert.rejects(mod.importManagePages({ schemaVersion: 1, pages: [{ url, items: [] }] }), /content|chunks|text/i);
  assert.equal(saved.length, 2, 'empty imports must not replace saved content');
  await mod.importManagePages({ schemaVersion: 1, pages: [exported[0]] });
  assert.deepEqual(saved[2].versions, exported[0].versions);
});

test('Memory Manager includes older pages beyond 500 captures and returns summaries newest first', async () => {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  await Promise.all(Array.from({ length: 501 }, (_, index) => db.savePageRecord(page({ url: `https://example.test/${index}`, timestamp: index + 1 }))));
  const mod = await loadSource('src/background/manage/index.ts', '', {
    '../capture/index': { cancelCaptureJobs() {} },
    '../embeddings/index': { getEmbeddingConfig: () => ({}) },
    '../storage/manager': { storageManager: db },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  });
  const summaries = await mod.getManagePages();
  assert.equal(summaries.length, 501);
  assert.equal(summaries[0].url, 'https://example.test/500');
  assert.equal(summaries.at(-1).url, 'https://example.test/0');
  assert.ok(summaries.every((record, index) => index === 0 || summaries[index - 1].timestamp >= record.timestamp));
  assert.ok(summaries.every(record => !('text' in record) && !('chunks' in record)), 'the UI receives summaries, not captured text or vectors');
  await mod.deleteManagePages([summaries.at(-1).url]);
  assert.equal(await db.getPageRecord('https://example.test/0'), undefined);
  assert.equal((await mod.getManagePages()).length, 500);
  (await db.openDatabase()).close();
});

test('processing transitions racing deletion cannot recreate durable jobs or recover deleted text', async () => {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager: db } }, { chrome: chromeFixture });
  const payload = { url, title: 'Private', text: 'private text', chunks: ['private text'], timestamp: 1 };
  await processing.markQueued(payload, 0);
  await Promise.all([db.deletePages([url]), processing.markProcessing(payload, 1)]);
  await processing.markFailed(payload, 2);
  assert.equal(await processing.markQueued(payload, 3, false), false);
  assert.equal(await db.getProcessingEntry(url), undefined);
  let processed = 0;
  const capture = await loadSource('src/background/capture/index.ts', '', {
    './processor': { processCapturePayload: async () => { processed++; } },
    '../processing/index': processing,
    '../settings/index': { shouldCaptureUrl: async () => true, getCachedSettingsSnapshot: () => ({}) },
    '../../shared/logger/index': { log: async () => {} }
  }, { chrome: chromeFixture });
  await capture.createCaptureQueue().ready; await tick();
  assert.equal(processed, 0);
});

const settings = { activeProviderId: 'ollama', queryRewrite: false, searchRerank: false };
test('Settings and Ask choose the same installed default; describing providers never runs inference', async () => {
  const requests = [];
  const modelSettings = { chatModel: null };
  const mocks = {
    '../models/index': { getModelSettings: async () => modelSettings },
    '../settings/index': { getSettings: async () => settings },
    './config': { getProviderBaseUrl: async () => 'http://localhost:11434', updateProviderSettings: async () => {} }
  };
  const context = { fetch: async (target, options) => {
    requests.push({ target, options });
    return { ok: true, json: async () => ({ models: [{ name: 'llama3:latest' }], message: { content: 'ok' } }) };
  } };
  const provider = await loadSource('src/background/providers/ollama.ts', '', mocks, context);
  const chat = await loadSource('src/background/providers/chat.ts', '', mocks, context);
  const description = await provider.describeOllamaProvider();
  assert.equal(description.selectedModel, 'llama3:latest');
  assert.equal((await chat.getChatConfig()).model, description.selectedModel);
  assert.equal(requests.filter(request => request.target.endsWith('/api/chat')).length, 0);
  modelSettings.chatModel = 'custom:chosen';
  assert.equal((await chat.getChatConfig()).model, 'custom:chosen');
  assert.equal((await provider.describeOllamaProvider()).selectedModel, 'custom:chosen');
});

test('provider health reads are cheap and explicit connection tests still probe chat', async () => {
  const requests = [];
  const mod = await loadSource('src/background/providers/ollama.ts', '', {
    '../models/index': { getModelSettings: async () => ({ chatModel: 'chosen' }) },
    '../settings/index': { getSettings: async () => settings },
    './config': { getProviderBaseUrl: async () => 'http://localhost:11434', updateProviderSettings: async () => {} }
  }, { fetch: async (target, options) => { requests.push({ target, options }); return { ok: true, json: async () => ({ models: [{ name: 'chosen' }], message: { content: 'ok' } }) }; } });
  await Promise.all([mod.describeOllamaProvider(), mod.describeOllamaProvider(), mod.getOllamaStatus()]);
  assert.equal(requests.filter(request => request.target.endsWith('/api/chat')).length, 0);
  assert.equal((await mod.getOllamaStatus(undefined, true)).online, true);
  const chat = requests.filter(request => request.target.endsWith('/api/chat'));
  assert.equal(chat.length, 1);
  assert.equal(JSON.parse(chat[0].options.body).model, 'chosen');
});

const searchMocks = (pages = [], candidates = []) => ({
  '../storage/manager': { storageManager: { listAllPages: async () => pages, listRecentPages: async () => pages, getPageRecord: async target => pages.find(p => p.url === target) } },
  '../calibration/index': { getCalibrationSnapshot: () => ({ wSim: .6, wLLM: 0 }) },
  '../embeddings/index': { computeEmbeddingsForQueries: async () => [[1, 0]], getEmbeddingConfig: () => ({ provider: 'browser', browserModel: 'new', browserRevision: 'pin' }) },
  '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => message.type === 'OFFSCREEN_TOP_PAGES' ? { pages: candidates.map(c => ({ url: c.url })) } : { candidates } },
  '../providers/chat': { callChat: async () => ({}), callChatJson: async () => ({}), getChatConfig: async () => ({}) },
  '../settings/index': { getSettings: async () => settings }
});
test('deduplication preserves the winning captured fragment URL and chunk index', async () => {
  const mod = await loadSource('src/background/search/index.ts', 'dedupeByUrl', searchMocks());
  const result = mod.dedupeByUrl([{ url: 'https://app.test/#/article', score: .9, chunkIndex: 2 }, { url: 'https://app.test/#/article', score: .8, chunkIndex: 1 }]);
  assert.equal(result[0].url, 'https://app.test/#/article');
  assert.equal(result[0].chunkIndex, 2);
  assert.equal(result[0].hitsFromPage, 2);
});

test('mixed model search keeps exact text matches and semantic hits without duplicating pages', async () => {
  const old = page({ title: 'Axolotl guide', text: 'Axolotl care', chunks: [{ text: 'Axolotl care', embedding: [1, 0], embeddingKey: 'old' }] });
  const candidate = { url: 'https://new.test', title: 'New model page', snippet: 'unrelated', timestamp: Date.now(), score: .8, chunkIndex: 0 };
  const mod = await loadSource('src/background/search/index.ts', '', searchMocks([old, page({ url: candidate.url })], [candidate]));
  const results = await mod.searchStoredPages('Axolotl', 10, { rewrite: false, rerank: false });
  assert.ok(results.some(result => result.url === old.url));
  assert.ok(results.some(result => result.url === candidate.url));
  assert.equal((await mod.searchStoredPages('Axolotl', 1, { rewrite: false, rerank: false }))[0].url, old.url);
  assert.equal(new Set(results.map(result => result.url)).size, results.length);
});

test('Ask uses the matched text snippet when retrieval has no chunk index', async () => {
  const mod = await loadSource('src/background/ask/index.ts', 'selectContextExcerpt', {
    '../storage/manager': { storageManager: {} }, '../search/index': { searchStoredPages: async () => [] },
    '../../shared/tools/index': { ToolsRuntime: class {} },
    '../providers/chat': { callChat: async () => ({}), callChatJson: async () => null, getChatConfig: async () => ({}), normalizeToolArguments: value => value, streamChat: async () => '' },
    '../settings/index': { getSettings: async () => ({}) }, '../calibration/index': { getCalibrationSnapshot: () => ({ wLLM: 0 }) }
  }, { chrome: chromeFixture });
  const excerpt = mod.selectContextExcerpt(page({ chunks: [{ text: 'UNRELATED INTRODUCTION' }, { text: 'MATCHED ANSWER' }] }), { url, snippet: 'MATCHED ANSWER' }, 1000);
  assert.equal(excerpt, 'MATCHED ANSWER');
});
