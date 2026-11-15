import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain } from './helpers.mjs';

const selected = { url: 'https://inside.test/a#saved', title: 'Selected', text: 'Selected evidence', timestamp: 1, chunks: [{ text: 'Selected evidence', embedding: [] }] };
const other = { ...selected, url: 'https://outside.test/private', title: 'Unselected', text: 'OUTSIDE SECRET' };
function mocks(extra = {}) {
  return {
    '../storage/manager': { storageManager: { getPageRecord: async url => url === selected.url ? selected : url === other.url ? other : undefined, listAllPages: async () => [selected, other], listRecentPages: async () => [other] } },
    '../search/index': { searchStoredPages: async () => [selected, other].map(page => ({ ...page, snippet: page.text, score: 1 })) },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, askRerank: false, enableTools: false }) },
    '../calibration/index': { getCalibrationSnapshot: () => ({ wLLM: 0 }) },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async () => ({}), callChatJson: async () => null, streamChat: async () => 'Selected fact [1]', normalizeToolArguments: value => value },
    ...extra
  };
}

test('page-scoped Ask uses chosen records, preserves fragments and never substitutes global recents', async () => {
  const mod = await loadSource('src/background/ask/index.ts', '', mocks(), { chrome: chromeFixture });
  const result = await mod.handleAskQuestion('What does this say?', { scopeUrls: [selected.url] });
  assert.deepEqual(plain(result.sources).map(source => source.url), [selected.url]);
  assert.match(result.sources[0].snippet, /Selected evidence/);
  const missing = await mod.handleAskQuestion('And this?', { scopeUrls: ['https://deleted.test/'] });
  assert.equal(missing.sources.length, 0);
  await assert.rejects(mod.handleAskQuestion('Question', { scopeUrls: [] }), /Choose at least/);
});

test('scoped tools reject outside reads and filter memory-search results before exposing them', async () => {
  const mod = await loadSource('src/background/ask/index.ts', 'createToolsRuntime', mocks(), { chrome: chromeFixture });
  const sources = [];
  const runtime = await mod.createToolsRuntime(sources, 1200, undefined, [selected.url]);
  assert.deepEqual([...runtime.allowedUrls], [selected.url]);
  const outside = JSON.parse((await runtime.runToolCall('get_page_summary', { url: other.url })).content);
  assert.equal(outside.ok, false);
  assert.doesNotMatch(JSON.stringify(outside), /OUTSIDE SECRET/);
  const search = JSON.parse((await runtime.runToolCall('search_memory', { query: 'evidence' })).content);
  assert.deepEqual(search.data.map(hit => hit.url), [selected.url]);
  assert.deepEqual(sources.map(source => source.url), [selected.url]);
});

test('scoped text fallback searches the selection before applying the result limit', async () => {
  const mod = await loadSource('src/background/search/index.ts', '', {
    '../storage/manager': mocks()['../storage/manager'],
    '../embeddings/index': { computeEmbeddingsForQueries: async () => [], getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }) },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false }) },
    '../providers/chat': mocks()['../providers/chat'],
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({}) },
    '../calibration/index': { getCalibrationSnapshot: () => ({ wSim: .6, wLLM: .4 }) }
  }, { chrome: chromeFixture });
  const results = await mod.searchStoredPages('evidence', 1, { scopeUrls: [selected.url] });
  assert.deepEqual(plain(results).map(hit => hit.url), [selected.url]);
  assert.equal((await mod.searchStoredPages('secret', 1, { scopeUrls: [selected.url] })).length, 0);
});
