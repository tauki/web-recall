import test from 'node:test';
import assert from 'node:assert/strict';
import initializeSqlite from '@sqlite.org/sqlite-wasm';
import { loadSource, chromeFixture, plain, scanFixturePages } from './helpers.mjs';

async function askWithRanking(search, rewrite = false, rerank = false, scores = null, maxResults = 1) {
  const pages = ['first', 'second', 'consensus'].map(name => ({ url: `https://example.test/${name}`, title: name, text: `Saved ${name} evidence`, timestamp: 1, chunks: [] }));
  const module = await loadSource('src/background/ask/index.ts', '', {
    '../storage/manager': { storageManager: { getPageRecord: async url => pages.find(page => page.url === url) } },
    '../search/index': { searchStoredPages: async query => search(query).map(([name, score]) => ({ ...pages.find(page => page.title === name), score, snippet: `Saved ${name} evidence` })) },
    '../settings/index': { getSettings: async () => ({ queryRewrite: rewrite, askRerank: rerank, enableTools: false }) },
    '../providers/chat': { getChatConfig: async () => ({ providerId: 'ollama' }), callChat: async () => ({ message: { content: 'query one\nquery two' } }), callChatJson: async () => scores, streamChat: async () => 'Saved fact [1]', normalizeToolArguments: value => value }
  }, { chrome: chromeFixture });
  return module.handleAskQuestion('Question', { maxResults });
}

test('Ask preserves fused retrieval order instead of comparing semantic and lexical scores', async () => {
  const response = await askWithRanking(() => [['first', 0.7], ['second', 100]]);
  assert.deepEqual(plain(response.sources).map(source => source.url), ['https://example.test/first']);
});

test('Ask merges multiple query rankings by relevance consensus rather than raw score magnitude', async () => {
  const response = await askWithRanking(query => query === 'Question' ? [['first', 100], ['consensus', 0.6]] : [['consensus', 0.6], ['second', 0.8]], true);
  assert.deepEqual(plain(response.sources).map(source => source.url), ['https://example.test/consensus']);
});

for (const scores of [null, { 1: 9 }]) test(`Ask retains fused order when reranking is ${scores ? 'partial' : 'unavailable'}`, async () => {
  const response = await askWithRanking(() => [['first', 0.7], ['second', 100]], false, true, scores, 2);
  assert.deepEqual(plain(response.sources).map(source => source.url), ['https://example.test/first']);
});

test('complete Ask rerank scores can reorder relevance without mixing lexical score magnitudes', async () => {
  const response = await askWithRanking(() => [['first', 100], ['second', 0.7]], false, true, { 1: 2, 2: 9 }, 2);
  assert.deepEqual(plain(response.sources).map(source => source.url), ['https://example.test/second']);
});

test('Search honors its requested page count without hidden calibration multipliers', async () => {
  const pages = Array.from({ length: 8 }, (_, index) => ({ url: `https://example.test/${index}`, title: 'Matching article', text: 'Matching saved text', timestamp: Date.now(), chunks: [] }));
  let chatCalls = 0;
  const unexpectedChat = () => { chatCalls++; throw new Error('Plain retrieval does not require a chat provider'); };
  const module = await loadSource('src/background/search/index.ts', '', {
    '../storage/manager': { storageManager: { scanSearchPages: scanFixturePages(pages), getPageRecord: async url => pages.find(page => page.url === url) } },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }), computeEmbeddingsForQueries: async () => [] },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, searchRerank: false }) },
    '../providers/chat': { getChatConfig: unexpectedChat, callChat: unexpectedChat, callChatJson: unexpectedChat }
  }, { chrome: chromeFixture });
  assert.equal((await module.searchStoredPages('Matching', 2)).length, 2);
  assert.equal((await module.searchStoredPages('Matching', 4)).length, 4);
  assert.equal(chatCalls, 0);
});

test('shortlisted chunk scoring in the active library only reads requested pages', async context => {
  const sqlite = await initializeSqlite();
  const database = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => database.close());
  const { stageSavedLibrary, activateSavedLibrary } = await loadSource('src/shared/db/sqliteLibrary.ts');
  const { SqliteRecords } = await loadSource('src/shared/db/sqliteRecords.ts');
  const id = '3aef1fe3-4d90-4370-935d-c878071c4780';
  await stageSavedLibrary(database, id, null);
  activateSavedLibrary(database, id);
  const records = new SqliteRecords(database, id);
  const page = { url: 'https://example.test/selected', title: 'Selected', text: 'Selected evidence', manual: true,
    timestamp: Date.now(), chunks: [{ text: 'Selected evidence', embedding: [1, 0], embeddingKey: 'space' }] };
  records.save(page);
  records.save({ ...page, url: 'https://example.test/unrelated' });
  const select = database.selectValue.bind(database), prepare = database.prepare.bind(database), reads = [];
  database.selectValue = (sql, values) => { reads.push(values); return select(sql, values); };
  database.prepare = sql => { assert.match(sql, /\bwhere\b/iu, 'Shortlisted scoring must not enumerate unrelated pages'); return prepare(sql); };
  const reply = records.run({ op: 'semanticChunks', urls: [page.url, page.url], queries: [[1, 0]], question: 'Selected', key: 'space' });
  assert.deepEqual(plain(reads), [[page.url]]);
  assert.deepEqual(plain(reply.candidates).map(candidate => ({ url: candidate.url, score: candidate.score, exact: candidate.containsExact })), [{ url: page.url, score: 1, exact: true }]);
});

test('scoped semantic search keeps the strongest passage and counts all matching chunks across batches', async () => {
  const config = { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' };
  const key = JSON.stringify(['ollama', config.baseUrl, config.model]);
  const { SemanticRecords } = await loadSource('src/shared/db/semanticRecords.ts');
  const records = new SemanticRecords();
  const base = { title: 'Sea birds', text: 'A field journal', timestamp: Date.now(), chunks: [] };
  const alias = { ...base, url: 'https://SCOPE.test:443/selected', chunks: [
    { text: 'Wings above the ocean', embedding: [0, 1], embeddingKey: key },
    { text: 'Cliffs provide shelter', embedding: [0.1, 1], embeddingKey: key }
  ] };
  const selected = { ...base, url: 'https://scope.test/selected', chunks: [
    { text: 'Feathers shelter chicks', embedding: [0.5, 0.5], embeddingKey: key },
    { text: 'Moon and stars guide the long flight', embedding: [1, 0], embeddingKey: key },
    { text: 'Wrong model space', embedding: [1, 0], embeddingKey: 'unrelated-model' }
  ] };
  const pages = [alias, ...Array.from({ length: 70 }, (_, index) => ({ ...base, url: `https://scope.test/${index}` })), selected];
  const byUrl = new Map(pages.map(page => [page.url, page]));
  const search = await loadSource('src/background/search/index.ts', '', {
    '../storage/manager': { storageManager: { scanSearchPages: scanFixturePages(pages) } },
    '../embeddings/index': { getEmbeddingConfig: () => config, computeEmbeddingsForQueries: async () => [[1, 0]] },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, searchRerank: false }) },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async () => ({}), callChatJson: async () => ({}) },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => {
      assert.equal(message.type, 'OFFSCREEN_SCORE_CHUNKS');
      assert.ok(message.pageUrls.length < pages.length, 'The scope must not all cross the worker boundary at once');
      return { candidates: records.chunks(message.pageUrls.map(url => byUrl.get(url)), message.variationEmbeddings, message.originalQuery, message.embeddingKey) };
    } }
  }, { chrome: chromeFixture });
  const results = await search.searchStoredPages('pelagic navigation', 10, { explicitModelUse: true, filters: { domain: 'scope.test' } });
  assert.deepEqual(plain(results).map(({ url, snippet, hitsFromPage }) => ({ url, snippet, hitsFromPage })), [
    { url: selected.url, snippet: 'Moon and stars guide the long flight', hitsFromPage: 4 }
  ]);
});
