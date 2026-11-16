import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain } from './helpers.mjs';

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
  const module = await loadSource('src/background/search/index.ts', '', {
    '../storage/manager': { storageManager: { listAllPages: async () => pages } },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }), computeEmbeddingsForQueries: async () => [] },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, searchRerank: false }) },
    '../providers/chat': { getChatConfig: () => assert.fail('Plain retrieval must not load a chat provider'), callChat: () => assert.fail('Plain retrieval must not call a chat model'), callChatJson: () => assert.fail('Plain retrieval must not rerank') }
  }, { chrome: chromeFixture });
  assert.equal((await module.searchStoredPages('Matching', 2)).length, 2);
  assert.equal((await module.searchStoredPages('Matching', 4)).length, 4);
});

test('shortlisted chunk scoring reads only requested pages, not the entire saved library', async () => {
  const listeners = [], reads = [];
  const page = { url: 'https://example.test/selected', title: 'Selected', timestamp: Date.now(), chunks: [{ text: 'Selected evidence', embedding: [1, 0], embeddingKey: 'space' }] };
  const store = {
    getAll: () => assert.fail('Shortlisted scoring must not enumerate unrelated pages'),
    get(url) {
      reads.push(url);
      const request = {};
      queueMicrotask(() => { request.result = url === page.url ? page : undefined; request.onsuccess(); });
      return request;
    }
  };
  await loadSource('src/offscreen/index.ts', '', { '../shared/db/index': { PAGES_STORE: 'pages', openDatabase: async () => ({ transaction: () => ({ objectStore: () => store }) }) } }, { chrome: { runtime: { onMessage: { addListener: listener => listeners.push(listener) } } } });
  const result = await new Promise(resolve => listeners[0]({ type: 'OFFSCREEN_SCORE_CHUNKS', pageUrls: [page.url], variationEmbeddings: [[1, 0]], originalQuery: 'Selected', embeddingKey: 'space' }, {}, resolve));
  assert.deepEqual(reads, [page.url]);
  assert.equal(result.error, undefined);
  assert.deepEqual(plain(result.candidates).map(candidate => candidate.url), [page.url]);
});
