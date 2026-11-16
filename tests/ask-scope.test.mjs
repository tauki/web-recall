import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain, waitFor } from './helpers.mjs';

const selected = { url: 'https://inside.test/a#saved', title: 'Selected', text: 'Selected evidence', timestamp: 1, chunks: [{ text: 'Selected evidence', embedding: [] }] };
const other = { ...selected, url: 'https://outside.test/private', title: 'Unselected', text: 'OUTSIDE SECRET' };
function mocks(extra = {}) {
  return {
    '../storage/manager': { storageManager: { getPageRecord: async url => url === selected.url ? selected : url === other.url ? other : undefined, listAllPages: async () => [selected, other], listRecentPages: async () => [other] } },
    '../search/index': { searchStoredPages: async (_query, _limit, options) => [selected, other].filter(page => !options?.scopeUrls || options.scopeUrls.includes(page.url)).map(page => ({ ...page, snippet: page.text, score: 1 })) },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, askRerank: false, enableTools: false }) },
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

test('scoped Ask retrieves later matching chunks with tools disabled and falls back only without hits', async () => {
  const later = 'The launch code is maple.';
  const page = { ...selected, chunks: [...selected.chunks, { text: later, embedding: [] }] };
  const searches = [], prompts = [];
  let matches = true;
  const base = mocks();
  const mod = await loadSource('src/background/ask/index.ts', '', mocks({
    '../storage/manager': { storageManager: { ...base['../storage/manager'].storageManager, getPageRecord: async url => url === page.url ? page : undefined } },
    '../search/index': { searchStoredPages: async (query, _limit, options) => {
      searches.push({ query, scope: options.scopeUrls });
      return matches ? [{ url: page.url, title: page.title, snippet: later, chunkIndex: 1, score: 1 }] : [];
    } },
    '../providers/chat': { ...base['../providers/chat'], streamChat: async (_config, body) => { prompts.push(JSON.stringify(body)); return 'The launch code is maple [1]'; } }
  }), { chrome: chromeFixture });
  const result = await mod.handleAskQuestion('What is the launch code?', { scopeUrls: [page.url] });
  assert.deepEqual(plain(searches), [{ query: 'What is the launch code?', scope: [page.url] }]);
  assert.equal(result.sources[0].evidence, later);
  assert.match(prompts[0], /The launch code is maple/);
  matches = false;
  const fallback = await mod.handleAskQuestion('No matching passage?', { scopeUrls: [page.url] });
  assert.match(fallback.sources[0].evidence, /Selected evidence/);
  const count = searches.length;
  const noSearch = await mod.handleAskQuestion('Read this page', { scopeUrls: [page.url], useSearch: false });
  assert.equal(searches.length, count);
  assert.match(noSearch.sources[0].evidence, /Selected evidence/);
});

test('Apple Ask streams the native answer, retains tool-read evidence and returns only cited selected sources', async () => {
  const later = 'The launch date is May 19.';
  const page = { ...selected, chunks: [...selected.chunks, { text: later, embedding: [] }] };
  const base = mocks();
  const requests = [], updates = [];
  const mod = await loadSource('src/background/ask/index.ts', '', mocks({
    '../storage/manager': { storageManager: { ...base['../storage/manager'].storageManager, getPageRecord: async url => url === selected.url ? page : other } },
    '../settings/index': { getSettings: async () => ({ enableTools: true, maxToolSteps: 3, queryRewrite: false, askRerank: false }) },
    '../providers/chat': { ...base['../providers/chat'], getChatConfig: async () => ({ providerId: 'apple', model: 'on-device', contextTokens: 8192, appleCloudConsent: false }) },
    '../providers/apple': { callApple: async (request, callbacks) => {
      requests.push(plain(request));
      callbacks.onChunk('The launch date is May');
      const read = JSON.parse((await callbacks.onToolCall('fetch_more', { url: selected.url, chunkIndex: 1 }, 'native-read')).content);
      assert.equal(read.data.text, later);
      const outside = JSON.parse((await callbacks.onToolCall('fetch_more', { url: other.url, chunkIndex: 0 }, 'outside-read')).content);
      assert.equal(outside.ok, false);
      return 'The launch date is May 19 [1].';
    } }
  }), { chrome: { runtime: { sendMessage: message => updates.push(message) } } });
  const result = await mod.handleAskQuestion('When is the launch?', { scopeUrls: [selected.url] });
  assert.doesNotMatch(JSON.stringify(requests[0]), /The launch date is May 19|OUTSIDE SECRET/, 'Native requests carry previews, not whole page catalogs');
  assert.equal(requests[0].mode, 'on-device');
  assert.equal(requests[0].cloudConsent, false);
  assert.equal(requests[0].toolLimit, 3);
  assert.ok(updates.some(update => update.type === 'ASK_ANSWER_UPDATE' && update.chunk === 'The launch date is May'));
  assert.equal(result.answer, 'The launch date is May 19 [1].');
  assert.deepEqual(plain(result.sources).map(source => source.url), [selected.url]);
  assert.ok(result.sources[0].excerpts.includes(later));
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE SECRET|Invented evidence/);
});

test('Apple Ask keeps tools available with no user limit and disables them only when requested', async () => {
  const base = mocks();
  const settings = { enableTools: true, maxToolSteps: 0, queryRewrite: false, askRerank: false };
  const requests = [];
  const mod = await loadSource('src/background/ask/index.ts', '', mocks({
    '../settings/index': { getSettings: async () => settings },
    '../providers/chat': { ...base['../providers/chat'], getChatConfig: async () => ({ providerId: 'apple', model: 'on-device', contextTokens: 4096 }) },
    '../providers/apple': { callApple: async request => { requests.push(plain(request)); return 'Selected fact [1]'; } }
  }), { chrome: chromeFixture });
  await mod.handleAskQuestion('Read this page', { scopeUrls: [selected.url] });
  assert.ok(requests[0].toolLimit > 0, 'zero means no user limit, not disabled native tools');
  settings.enableTools = false;
  await mod.handleAskQuestion('Read this page', { scopeUrls: [selected.url] });
  assert.equal(requests[1].toolLimit, 0, 'the tools toggle must still prevent native tool use');
});

test('Apple Ask cannot approve invented citations and Stop reaches the native generation signal', async () => {
  const base = mocks();
  let generation;
  const mod = await loadSource('src/background/ask/index.ts', '', mocks({
    '../providers/chat': { ...base['../providers/chat'], getChatConfig: async () => ({ providerId: 'apple', model: 'on-device', contextTokens: 4096 }) },
    '../providers/apple': { callApple: async (_request, options) => {
      if (!generation) return 'Unsupported claim [99]';
      generation.signal = options.signal;
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('Native task stopped')), { once: true }));
      return 'Must not be accepted [1]';
    } }
  }), { chrome: chromeFixture });
  await assert.rejects(mod.handleAskQuestion('Question', { scopeUrls: [selected.url] }), /unverified/);
  generation = {};
  const pending = mod.handleAskQuestion('Question', { scopeUrls: [selected.url], requestId: 'native-stop' });
  await waitFor(() => generation.signal, 'native generation to start');
  assert.equal(mod.cancelAskQuestion('native-stop'), true);
  await assert.rejects(pending, /stopped/);
  assert.equal(generation.signal.aborted, true);
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
  }, { chrome: chromeFixture });
  const results = await mod.searchStoredPages('evidence', 1, { scopeUrls: [selected.url] });
  assert.deepEqual(plain(results).map(hit => hit.url), [selected.url]);
  assert.equal((await mod.searchStoredPages('secret', 1, { scopeUrls: [selected.url] })).length, 0);
});
