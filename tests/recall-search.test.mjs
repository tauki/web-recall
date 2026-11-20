import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain, tick, waitFor, scanFixturePages } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';

const saved = (url, title, text, timestamp = 1) => ({ url, title, text, timestamp, chunks: [], manual: false });
async function searchLibrary(pages, embed = async () => [], overrides = {}) {
  const calls = { embeddings: 0, chat: 0 };
  const api = await loadSource('src/background/search/index.ts', '', {
    '../storage/manager': { storageManager: { scanSearchPages: scanFixturePages(pages), getPageRecord: async url => pages.find(page => page.url === url) } },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }), computeEmbeddingsForQueries: async (...args) => { calls.embeddings++; return embed(...args); } },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, searchRerank: false }) },
    '../providers/chat': { getChatConfig: () => { calls.chat++; throw new Error('Chat unavailable'); }, callChat: () => { calls.chat++; throw new Error('Chat unavailable'); }, callChatJson: () => { calls.chat++; throw new Error('Chat unavailable'); } },
    ...overrides
  }, { chrome: chromeFixture });
  return { ...api, calls };
}

test('quoted phrases find old unindexed pages without matching separated words', async () => {
  const wanted = saved('https://archive.test/bird', 'Field notes', 'A ceramic falcon sits on the shelf.');
  const other = saved('https://recent.test/bird', 'Ceramic and falcon', 'The ceramic object is next to a falcon.', Date.now());
  const search = await searchLibrary([other, wanted]);
  const result = await search.searchStoredPages('"ceramic falcon"', 20);
  assert.deepEqual(plain(result).map(page => page.url), [wanted.url]);
  assert.match(result[0].snippet, /ceramic falcon/);
});

test('URLs are searchable even when neither title nor body repeats the address', async () => {
  const wanted = saved('https://reference.test/notes/rare-otter?edition=2', 'Observations', 'A coastal field survey.');
  const search = await searchLibrary([wanted]);
  assert.deepEqual(plain(await search.searchStoredPages('rare-otter', 10)).map(page => page.url), [wanted.url]);
});

test('natural recollections rank their meaningful words above common prose and word fragments', async () => {
  const wanted = saved('https://notes.test/delivery', 'Delivery notes', 'Store the database change with an event. Publish the message through a broker afterward.', 1);
  const noise = Array.from({ length: 30 }, (_, index) => saved(`https://notes.test/software/${index}`, 'Software system notes', 'The discussion records a change so the group can compare the event with a later observation.', index + 2));
  const search = await searchLibrary([...noise, wanted]);
  const [result] = await search.searchStoredPages('saving a database change and a message so the broker does not lose the event', 5);
  assert.equal(result.url, wanted.url); assert.match(result.snippet, /database change/);
  assert.match(wanted.text.slice(result.match.start, result.match.end), /database.*message.*broker/s);
});

test('whole-word evidence outranks title and URL fragments without removing literal partial lookup', async () => {
  const wanted = saved('https://notes.test/felines', 'Animal observations', 'A cat sleeps in the garden.', 1);
  const fragments = saved('https://notes.test/catalog', 'Catalogue certificates', 'A caterpillar crosses the path.', 20);
  const search = await searchLibrary([fragments, wanted]);
  assert.equal((await search.searchStoredPages('cat', 2))[0].url, wanted.url);
  assert.equal((await search.searchStoredPages('caterpill', 2))[0].url, fragments.url);
});

test('common-word-only and quoted queries remain literal rather than becoming an empty query', async () => {
  const wanted = saved('https://notes.test/grammar', 'Grammar notes', 'To be or not to be.');
  const search = await searchLibrary([wanted]);
  assert.equal((await search.searchStoredPages('not', 2))[0].url, wanted.url);
  assert.equal((await search.searchStoredPages('"to be"', 2))[0].url, wanted.url);
});

test('a natural recollection opens the dense matching passage rather than an isolated word in the captured heading', async () => {
  const passage = 'Swift winter nesting follows the sheltered coastal cliffs.';
  const content = '# Swift observations\n\n' + 'An ordinary unrelated observation. '.repeat(1200) + '\n\n' + passage;
  const wanted = saved('https://notes.test/deep-reading', 'Swift observations', content);
  const search = await searchLibrary([wanted]);
  const [result] = await search.searchStoredPages('swift winter coastal nesting', 5);
  assert.equal(result.url, wanted.url); assert.match(result.snippet, /Swift winter nesting follows the sheltered coastal cliffs/);
  assert.ok(result.match.start >= content.indexOf(passage)); assert.ok(result.match.end <= content.length);
  const reader = await loadSource('src/background/manage/reader.ts', '', { '../storage/manager': { storageManager: { getPageRecord: async () => wanted } } });
  const opened = await reader.getSavedPage(wanted.url, wanted.timestamp, 'swift winter coastal nesting');
  assert.deepEqual(plain(opened.match), plain(result.match)); assert.equal(opened.text, content);
});

test('multiword recollections prefer explanatory body evidence while an explicit literal heading remains navigable', async () => {
  const title = 'Browser memories through a crash', body = 'A backup keeps the original evidence available after an interruption.';
  const wanted = saved('https://notes.test/backup', title, `# ${title}\n\n${body}`);
  const search = await searchLibrary([wanted]);
  const [recollection] = await search.searchStoredPages('browser memories crash backup', 5);
  assert.ok(recollection.match.start >= wanted.text.indexOf(body)); assert.match(recollection.snippet, /backup keeps/);
  const [literal] = await search.searchStoredPages('"Browser memories through a crash"', 5);
  assert.equal(wanted.text.slice(literal.match.start, literal.match.end), title);
});

test('an old exact phrase is not buried by a newer partial keyword match', async () => {
  const wanted = saved('https://archive.test/release', 'Moon landing checklist', 'Archived launch procedures.');
  const recent = saved('https://recent.test/moon', 'Moon weather', 'A landing is not described here.', Date.now());
  const search = await searchLibrary([recent, wanted]);
  assert.equal((await search.searchStoredPages('moon landing', 1))[0].url, wanted.url);
});

test('text search covers the whole library, including captures beyond recent-page windows', async () => {
  const pages = Array.from({ length: 1100 }, (_, index) => saved(`https://library.test/${index}`, 'Ordinary page', 'Unrelated reading.', index));
  pages[0] = saved('https://library.test/oldest', 'Oldest page', 'The silver heron migration route.');
  const search = await searchLibrary(pages);
  assert.deepEqual(plain(await search.searchStoredPages('silver heron', 20)).map(page => page.url), [pages[0].url]);
});

test('late exact snapshots displace earlier higher-scoring partial winners independently of scan order', async () => {
  const noise = Array.from({ length: 350 }, (_, index) => saved(`https://noise.test/${index}`, 'Coastal observations', 'Birds are discussed separately.', 1000 + index));
  const first = { ...saved('https://archive.test/a', 'Current observations', 'Coastal birds gather on the headland.', 30), versionId: 'first-current' };
  const second = { ...first, url: 'https://archive.test/z', versionId: 'second-current' };
  const historical = { ...saved('https://archive.test/history', 'Replacement observations', 'Unrelated current text.', 50), versionId: 'replacement', versions: [{ title: 'Earlier observations', text: 'Coastal birds nest on the island.', timestamp: 1, versionId: 'earlier', chunks: [] }] };
  const pages = [...noise, second, first, historical];
  for (const ordering of [pages, [...pages].reverse()]) {
    const search = await searchLibrary(ordering);
    const results = await search.searchStoredPages('coastal birds', 3);
    assert.deepEqual(plain(results.map(result => [result.url, result.versionId])), [[first.url, 'first-current'], [second.url, 'second-current'], [historical.url, 'earlier']]);
  }
});

test('search preserves distinct fragment and query routes and carries each saved version identity', async () => {
  const routes = ['https://app.test/#/first', 'https://app.test/#/second', 'https://app.test/?mode=first', 'https://app.test/?mode=second'];
  const pages = routes.map((url, index) => ({ ...saved(url, 'Saved route', 'A copper tern is described.'), versionId: `version-${index}` }));
  const search = await searchLibrary(pages);
  const results = await search.searchStoredPages('copper tern', 10);
  assert.deepEqual(plain(results.map(result => [result.url, result.versionId])).sort(), pages.map(page => [page.url, page.versionId]).sort());
});

test('semantic refinement preserves the identity and capture time of retained earlier text evidence during recapture', async () => {
  const original = { ...saved('https://saved.test/race', 'Field report', 'Copper birds follow an annual migration route.', 10), versionId: 'original-id' };
  const replacement = { ...saved(original.url, 'Changed field report', 'Unrelated replacement evidence about rocks.', 20), versionId: 'replacement-id', versions: [original] };
  let current = original;
  const search = await searchLibrary([original], async () => { current = replacement; return [[1, 0]]; }, {
    '../storage/manager': { storageManager: { scanSearchPages: scanFixturePages(() => [current]), getPageRecord: async () => current } },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => message.type === 'OFFSCREEN_TOP_PAGES' ? { pages: [{ url: original.url }] } : { candidates: [{ ...replacement, snippet: replacement.text, score: 1, weightedScore: 1, chunkIndex: 0 }] } }
  });
  const [hit] = await search.searchStoredPages('copper migration', 10, { rewrite: false, rerank: false });
  assert.match(hit.snippet, /Copper birds/); assert.equal(hit.versionId, original.versionId); assert.equal(hit.timestamp, original.timestamp);
});

for (const retained of [false, true]) test(`reranking ${retained ? 'uses retained earlier evidence' : 'drops a removed earlier capture'} instead of rereading another version`, async () => {
  const original = { ...saved('https://saved.test/rerank', 'Old title', 'Original passage about ocean birds.', 10), versionId: 'original-id', chunks: [{ text: 'Original passage about ocean birds.', embedding: [1, 0] }] };
  const replacement = { ...saved(original.url, 'New title', 'Replacement body about rocks.', 20), versionId: 'replacement-id', chunks: [{ text: 'Replacement passage about rocks.', embedding: [1, 0] }], versions: retained ? [original] : [] };
  let current = original; const prompts = [];
  const search = await searchLibrary([original], async () => [[1, 0]], {
    '../storage/manager': { storageManager: { scanSearchPages: scanFixturePages(() => [current]), getPageRecord: async () => current } },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => message.type === 'OFFSCREEN_TOP_PAGES' ? { pages: [{ url: original.url }] } : { candidates: [{ ...original, snippet: original.chunks[0].text, score: 1, weightedScore: 1, chunkIndex: 0 }] } },
    '../providers/chat': { getChatConfig: async () => { current = replacement; return { model: 'test' }; }, callChat: async () => ({}), callChatJson: async (_config, request) => { prompts.push(JSON.stringify(request)); return { '1': 9 }; } }
  });
  const results = await search.searchStoredPages('copper migration', 10, { rewrite: false, rerank: true });
  for (const prompt of prompts) assert.doesNotMatch(prompt, /Replacement passage/);
  if (retained) {
    assert.ok(prompts.some(prompt => prompt.includes(original.text)));
    assert.equal(results[0].versionId, original.versionId); assert.equal(results[0].title, original.title);
  } else assert.equal(results.length, 0);
});

for (const retained of [false, true]) test(`final exact-hit assembly ${retained ? 'keeps retained evidence' : 'does not reintroduce an unavailable version'} after recapture`, async () => {
  const original = { ...saved('https://saved.test/exact-race', 'Original guide', 'Copper tern evidence.', 10), versionId: 'original-id' };
  const replacement = { ...saved(original.url, 'Replacement guide', 'Unrelated rock evidence.', 20), versionId: 'replacement-id', versions: retained ? [original] : [] };
  let current = original; const early = [];
  const search = await searchLibrary([original], async () => { current = replacement; return []; }, {
    '../storage/manager': { storageManager: { scanSearchPages: scanFixturePages(() => [current]), getPageRecord: async () => current } }
  });
  const results = await search.searchStoredPages('copper tern', 10, { rewrite: false, rerank: false, onTextResults: hits => early.push(plain(hits)) });
  assert.equal(early[0][0].versionId, original.versionId);
  if (retained) { assert.equal(results[0].versionId, original.versionId); assert.match(results[0].snippet, /Copper tern/); }
  else assert.deepEqual(plain(results), []);
});

test('text hits are delivered before a pending embedding request and remain available when stopped', async () => {
  const wanted = saved('https://library.test/saved', 'Saved evidence', 'A reliable observation.');
  let finishEmbedding;
  const embedding = new Promise(resolve => { finishEmbedding = resolve; });
  const search = await searchLibrary([wanted], () => embedding);
  const controller = new AbortController(), updates = [];
  const pending = search.searchStoredPages('reliable', 10, { signal: controller.signal, onTextResults: results => updates.push(plain(results)) });
  try {
    await tick(); await tick();
    assert.deepEqual(updates.map(results => results.map(page => page.url)), [[wanted.url]]);
    controller.abort(new Error('Stopped by user'));
    await assert.rejects(pending, /Stopped by user/);
    assert.equal(updates[0][0].snippet.includes('reliable observation'), true);
  } finally {
    finishEmbedding([]);
    await pending.catch(() => {});
  }
});

test('a late offscreen scoring reply after Stop cannot start another saved-record read', async () => {
  const wanted = { ...saved('https://notes.test/late-score', 'Field notes', 'A coastal bird is recorded.'), versionId: 'saved-version' };
  const reads = []; let release, scoring = false;
  const delayed = new Promise(resolve => { release = resolve; });
  const candidates = [{ url: wanted.url, title: wanted.title, timestamp: wanted.timestamp, versionId: wanted.versionId, snippet: wanted.text, score: 1 }];
  const scan = scanFixturePages([wanted]);
  const search = await searchLibrary([wanted], async () => [[1, 0]], {
    '../storage/manager': { storageManager: { scanSearchPages: (visit, options) => scan(record => { reads.push(record.url); visit(record); }, options), getPageRecord: async () => wanted } },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => {
      if (message.type === 'OFFSCREEN_TOP_PAGES') return { pages: [{ url: wanted.url }] };
      scoring = true; return delayed;
    } }
  });
  const controller = new AbortController();
  const pending = search.searchStoredPages('coastal bird', 5, { signal: controller.signal, rewrite: false, rerank: false, explicitModelUse: true });
  try {
    await waitFor(() => scoring, 'offscreen scoring before cancellation');
    controller.abort(new Error('Stopped by user'));
    await assert.rejects(pending, /Stopped by user/);
    const completed = [...reads]; release({ candidates }); await tick(); await tick();
    assert.deepEqual(reads, completed, 'A stopped request must not read another snapshot after a late worker reply');
  } finally { controller.abort(); release({ candidates }); await pending.catch(() => {}); }
});

test('search matches literal punctuation and whitespace across saved paragraphs', async () => {
  const wanted = saved('https://library.test/code', 'Build notes', 'A C++ guide covers the silver\n\theron migration.');
  const search = await searchLibrary([wanted]);
  assert.equal((await search.searchStoredPages('C++', 10))[0].url, wanted.url);
  assert.equal((await search.searchStoredPages('“silver heron”', 10))[0].url, wanted.url);
  assert.deepEqual(plain(await search.searchStoredPages('"silver heron" "missing phrase"', 10)), []);
});

for (const scenario of [
  { query: 'summer', text: 'An original ſummer observation.', matched: 'ſummer' },
  { query: 'Kelvin', text: 'The KELVIN scale is described.', matched: 'KELVIN' },
  { query: 'coastal', text: 'İstanbul notes precede COASTAL observations.', matched: 'COASTAL' },
  { query: '"c++ guide"', text: 'The C++\n\tGUIDE remains literal.', matched: 'C++\n\tGUIDE' },
  { query: 'c++', text: 'The C++ implementation is described.', matched: 'C++' }
]) test(`literal lookup ${scenario.query} preserves original-text offsets across case, Unicode and spacing`, async () => {
  const wanted = saved('https://notes.test/original-offsets', 'Original reading notes', scenario.text);
  const search = await searchLibrary([wanted]);
  const [result] = await search.searchStoredPages(scenario.query, 5);
  assert.equal(result.url, wanted.url); assert.equal(result.match.field, 'text');
  assert.equal(wanted.text.slice(result.match.start, result.match.end), scenario.matched);
});

test('term-derived punctuation offsets do not depend on a lowercased prefix, an exact-query hit or passage refinement', async () => {
  const { createTextMatcher } = await loadSource('src/shared/textSearch.ts');
  const text = 'İstanbul precedes ++ evidence.';
  const result = createTextMatcher('++ absent', { passage: false })(saved('https://notes.test/offsets', 'Original notes', text));
  assert.equal(result.containsExact, false); assert.equal(result.match.field, 'text');
  assert.equal(result.match.start, text.indexOf('++')); assert.equal(text.slice(result.match.start, result.match.end), '++');
});

test('quoted phrase lookup needs neither a running embedding model nor a chat model', async () => {
  const wanted = saved('https://library.test/offline', 'Saved offline', 'The cobalt swallow is described here.');
  const search = await searchLibrary([wanted], () => assert.fail('An explicit phrase query must not wait for a model'));
  assert.equal((await search.searchStoredPages('"cobalt swallow"', 10))[0].url, wanted.url);
  assert.deepEqual(search.calls, { embeddings: 0, chat: 0 });
});

test('the runtime delivers request-correlated text matches before completing model work', async () => {
  const backend = providerFixture('http://localhost:11434');
  Object.assign(backend.stored.betaSettings, { queryRewrite: false, searchRerank: false });
  const updates = [];
  let finishEmbedding;
  const embedding = new Promise(resolve => { finishEmbedding = resolve; });
  backend.runtime.sendMessage = message => { updates.push(plain(message)); return Promise.resolve(); };
  const db = await backend.load('src/shared/db/index.ts');
  await db.savePageRecord(saved('https://library.test/paper', 'Saved paper', 'The copper tern nests here.'));
  const runtime = await backend.load('src/background/orchestration/index.ts', { fetch: async url => {
    assert.equal(new URL(url).pathname, '/api/embed');
    return embedding;
  } });
  runtime.orchestrateLifecycle();
  const requestId = 'runtime-text-first';
  let settled = false;
  const pending = backend.send({ type: 'SEARCH_QUERY', requestId, query: 'copper tern' }).then(response => { settled = true; return response; });
  try {
    await waitFor(() => updates.some(message => message.type === 'SEARCH_RESULTS_UPDATE'), 'text results before the model responds');
    assert.equal(settled, false, 'Early results must be visible while the final request remains pending');
    assert.deepEqual(updates.filter(message => message.type === 'SEARCH_RESULTS_UPDATE').map(message => ({ requestId: message.requestId, urls: message.results.map(hit => hit.url) })), [{ requestId, urls: ['https://library.test/paper'] }]);
  } finally { finishEmbedding(Response.json({ embeddings: [[0.25, 0.75]] })); }
  const response = await pending;
  assert.equal(response.error, undefined);
  assert.equal(response.results[0].url, 'https://library.test/paper');
});

test('keyword-free filters browse saved pages without starting a model', async () => {
  const pages = [saved('https://archive.test/recent', 'Recent archive', 'Saved text.', 15), saved('https://archive.test/old', 'Old archive', 'Saved text.', 5), saved('https://other.test/recent', 'Other site', 'Saved text.', 15)];
  const search = await searchLibrary(pages, () => assert.fail('Browsing a filtered library must not require a model'));
  const results = await search.searchStoredPages('', 20, { filters: { domain: 'archive.test', from: 10, before: 20 } });
  assert.deepEqual(plain(results).map(page => page.url), ['https://archive.test/recent']);
  assert.deepEqual(search.calls, { embeddings: 0, chat: 0 });
});

test('semantic refinement cannot add a page outside the selected site, date or explicit page scope', async () => {
  const wanted = saved('https://archive.test/recent', 'Wanted observation', 'A coastal record.', 15);
  const pages = [wanted, saved('https://archive.test/old', 'Wrong date', 'A coastal record.', 5), saved('https://other.test/recent', 'Wrong site', 'A coastal record.', 15)];
  const search = await searchLibrary(pages, async () => [[1, 0]], {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({ candidates: pages.map(page => ({ ...page, snippet: page.text, score: 0.9 })) }) }
  });
  const options = { filters: { domain: 'archive.test', from: 10, before: 20 } };
  assert.deepEqual(plain(await search.searchStoredPages('coastal', 20, options)).map(page => page.url), [wanted.url]);
  assert.deepEqual(plain(await search.searchStoredPages('coastal', 20, { ...options, scopeUrls: ['https://archive.test/old'] })), []);
});

test('invalid runtime filters explain the error instead of running an unfiltered model search', async () => {
  const backend = providerFixture('http://localhost:11434');
  await backend.connect();
  const response = await backend.send({ type: 'SEARCH_QUERY', query: 'coastal', filters: { from: 20, before: 10 } });
  assert.match(response.error, /end date/);
  assert.equal(backend.requests.length, 0);
});

test('a recapture during semantic refinement cannot return or rerank newer content outside the date range', async () => {
  const pages = [saved('https://archive.test/bird', 'A coastal observation', 'The wild coastal bird was recorded.', 15)];
  let rerankCalls = 0;
  const search = await searchLibrary(pages, async () => {
    pages[0] = { ...pages[0], text: 'New evidence outside the selected date.', timestamp: 30 };
    return [[1, 0]];
  }, {
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, searchRerank: true }) },
    '../providers/chat': { getChatConfig: async () => ({}), callChatJson: async () => { rerankCalls++; return { 1: 9 }; }, callChat: () => assert.fail('No rewriting is enabled') },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({ candidates: [{ ...pages[0], snippet: pages[0].text, score: 0.9 }] }) }
  });
  const early = [];
  const results = await search.searchStoredPages('wild bird', 20, { filters: { from: 10, before: 20 }, onTextResults: hits => early.push(plain(hits)) });
  assert.equal(early[0][0].timestamp, 15);
  assert.deepEqual(plain(results), []);
  assert.equal(rerankCalls, 0, 'Out-of-range recaptures must not enter reranking');
});

test('a recapture while reranking is prepared cannot duplicate the remaining in-range results', async () => {
  const pages = Array.from({ length: 3 }, (_, index) => saved(`https://archive.test/${index}`, `Observation ${index}`, 'A wild coastal bird was recorded.', 15));
  const search = await searchLibrary(pages, async () => [[1, 0]], {
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, searchRerank: true }) },
    '../providers/chat': { getChatConfig: async () => { pages[0] = { ...pages[0], timestamp: 30 }; return {}; }, callChatJson: async () => ({ 1: 8, 2: 7 }), callChat: () => assert.fail('No rewriting is enabled') },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({ candidates: pages.map(page => ({ ...page, snippet: page.text, score: 0.9 })) }) }
  });
  const results = await search.searchStoredPages('wild bird', 20, { filters: { from: 10, before: 20 } });
  assert.deepEqual(plain(results).map(hit => hit.url).sort(), ['https://archive.test/1', 'https://archive.test/2']);
});

for (const [query, expected] of [
  ['"copper tern"', ['current-id', 40, 'Current ledger', { field: 'text', start: 9, end: 20 }]],
  ['"azure swift"', ['history-id', 15, 'Field notes: Silver Heron', { field: 'text', start: 12, end: 23 }]],
  ['"current ledger"', ['current-id', 40, 'Current ledger', { field: 'title', start: 0, end: 14 }]],
  ['"silver heron"', ['history-id', 15, 'Field notes: Silver Heron', { field: 'title', start: 13, end: 25 }]]
]) test(`whole-library quoted lookup ${query} returns the matching snapshot and its reader range`, async () => {
  const history = { title: 'Field notes: Silver Heron', text: 'Prelude.\nAn azure swift nests here.', chunks: [], versionId: 'history-id', timestamp: 15 };
  const page = { ...saved('https://archive.test/field?edition=2#notes', 'Current ledger', 'Prelude.\nCopper tern nests here.', 40), versionId: 'current-id', versions: [history] };
  const search = await searchLibrary([page]);
  const results = await search.searchStoredPages(query, 10);
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title, hit.match]), [expected]);
  assert.equal(results[0].url, 'https://archive.test/field?edition=2#notes');
  assert.deepEqual(search.calls, { embeddings: 0, chat: 0 });
});

test('retained text in chunk-only history is searchable beyond the recent-page window with reader offsets in that version', async () => {
  const pages = Array.from({ length: 1100 }, (_, index) => ({ ...saved(`https://library.test/${index}`, 'Ordinary page', 'Unrelated text.', index + 30), versionId: `current-${index}` }));
  pages[0].versions = [{ title: 'Historic observation', text: '', chunks: [{ text: 'Prelude.' }, { text: 'Copper tern nests here.' }], timestamp: 10, versionId: 'chunk-history' }];
  const search = await searchLibrary(pages);
  const results = await search.searchStoredPages('"copper tern"', 10);
  assert.deepEqual(plain(results).map(hit => [hit.url, hit.versionId, hit.timestamp, hit.match]), [
    ['https://library.test/0', 'chunk-history', 10, { field: 'text', start: 9, end: 20 }]
  ]);
  assert.match(results[0].snippet, /Copper tern nests here/);
});

test('date and domain filters choose an eligible historic match before grouping or limiting URLs', async () => {
  const page = {
    ...saved('https://notes.archive.test/survey#saved', 'Current survey', 'Copper tern records.', 30), versionId: 'current',
    versions: [
      { title: 'Copper tern', text: 'Copper tern records.', chunks: [], timestamp: 20, versionId: 'too-new' },
      { title: 'Copper tern', text: 'Copper tern records.', chunks: [], timestamp: 9, versionId: 'too-old' },
      { title: 'Historic survey', text: 'Copper tern records.', chunks: [], timestamp: 10, versionId: 'in-range' }
    ]
  };
  const outside = { ...page, url: 'https://archive.test.evil/survey' };
  const search = await searchLibrary([outside, page]);
  const results = await search.searchStoredPages('"copper tern"', 1, { filters: { domain: 'archive.test', from: 10, before: 20 } });
  assert.deepEqual(plain(results).map(hit => [hit.url, hit.versionId, hit.timestamp, hit.title]), [
    ['https://notes.archive.test/survey#saved', 'in-range', 10, 'Historic survey']
  ]);
  const scoped = await search.searchStoredPages('"copper tern"', 10, { scopeUrls: [outside.url], filters: { domain: 'archive.test', from: 10, before: 20 } });
  assert.deepEqual(plain(scoped), []);
});

test('keyword-free date browsing returns the newest eligible history when current text is outside the range', async () => {
  const page = {
    ...saved('https://archive.test/survey', 'Current survey', 'Current text.', 30), versionId: 'current',
    versions: [
      { title: 'Older survey', text: 'Older text.', chunks: [], timestamp: 10, versionId: 'older' },
      { title: 'Latest eligible survey', text: 'Eligible text.', chunks: [], timestamp: 15, versionId: 'eligible' }
    ]
  };
  const search = await searchLibrary([page]);
  const results = await search.searchStoredPages('', 10, { filters: { from: 10, before: 20 } });
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title]), [['eligible', 15, 'Latest eligible survey']]);
  assert.deepEqual(search.calls, { embeddings: 0, chat: 0 });
});

test('equivalent text matches group to the newest current snapshot rather than duplicate older versions', async () => {
  const page = {
    ...saved('https://archive.test/survey', 'Current survey', 'A copper tern nests here.', 30), versionId: 'current',
    versions: [{ title: 'Earlier survey', text: 'A copper tern nests here.', chunks: [], timestamp: 10, versionId: 'older' }]
  };
  const search = await searchLibrary([page]);
  const results = await search.searchStoredPages('copper tern', 10);
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title]), [['current', 30, 'Current survey']]);
});

test('an older exact phrase beats a higher-scoring current partial match and survives semantic rerank rejection', async () => {
  const page = {
    ...saved('https://archive.test/survey', 'Copper guide for tern observers', 'Copper shavings surround the tern sculpture.', 30), versionId: 'current',
    versions: [{ title: 'Historic survey', text: 'A copper tern migrates.', chunks: [], timestamp: 10, versionId: 'exact-history' }]
  };
  const prompts = [];
  const search = await searchLibrary([page], async () => [[1, 0]], {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => message.type === 'OFFSCREEN_TOP_PAGES' ? { pages: [{ url: page.url }] } : { candidates: [{ ...page, snippet: page.text, score: 1, weightedScore: 1 }] } },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async (_config, request) => { prompts.push(plain(request)); return {}; }, callChatJson: async (_config, request) => { prompts.push(plain(request)); return { '1': 0 }; } }
  });
  const early = [];
  const results = await search.searchStoredPages('copper tern', 1, { rewrite: false, rerank: true, onTextResults: hits => early.push(plain(hits)) });
  assert.deepEqual(early[0].map(hit => [hit.versionId, hit.containsExact]), [['exact-history', true]]);
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title, hit.match]), [
    ['exact-history', 10, 'Historic survey', { field: 'text', start: 2, end: 13 }]
  ]);
  assert.equal(prompts.length, 1);
  assert.match(JSON.stringify(prompts), /A copper tern migrates/);
  assert.doesNotMatch(JSON.stringify(prompts), /shavings|Copper guide/);
});

test('filtered semantic refinement reranks the matching history date and never substitutes out-of-range current text', async () => {
  const history = { title: 'Historic survey', text: 'Copper birds follow an annual migration route.', chunks: [{ text: 'Copper birds follow an annual migration route.' }], versionId: 'history', timestamp: 15 };
  const page = { ...saved('https://archive.test/survey', 'Replacement survey', 'Replacement rocks have no wings.', 30), versionId: 'current', versions: [history] };
  const prompts = [], requests = [];
  const search = await searchLibrary([page], async () => [[1, 0]], {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => { requests.push(plain(message)); return { candidates: [{ ...page, snippet: page.text, score: 1 }] }; } },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async (_config, request) => { prompts.push(plain(request)); return {}; }, callChatJson: async (_config, request) => { prompts.push(plain(request)); return { '1': 9 }; } }
  });
  const early = [];
  const results = await search.searchStoredPages('copper migration', 10, { rewrite: false, rerank: true, filters: { domain: 'archive.test', from: 10, before: 20 }, onTextResults: hits => early.push(plain(hits)) });
  assert.deepEqual(early[0].map(hit => [hit.versionId, hit.timestamp]), [['history', 15]]);
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title]), [['history', 15, 'Historic survey']]);
  assert.deepEqual(requests.map(request => [request.type, request.pageUrls]), [['OFFSCREEN_SCORE_CHUNKS', ['https://archive.test/survey']]]);
  assert.equal(prompts.length, 1);
  assert.match(JSON.stringify(prompts), /Copper birds follow an annual migration route/);
  assert.doesNotMatch(JSON.stringify(prompts), /Replacement/);
});

test('a stale semantic timestamp is checked against its retained snapshot and reranking reads only that snapshot', async () => {
  const history = { title: 'Old field report', text: 'Historic observations about coastal terns.', chunks: [{ text: 'Historic observations about coastal terns.' }], versionId: 'history', timestamp: 15 };
  const page = { ...saved('https://archive.test/report', 'Replacement report', 'Replacement rocks.', 30), versionId: 'current', versions: [history] };
  const prompts = [];
  const search = await searchLibrary([page], async () => [[1, 0]], {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({ candidates: [
      { ...page, snippet: page.text, score: 1 },
      { url: page.url, title: 'Stale index title', snippet: 'Stale index excerpt.', versionId: 'history', timestamp: 3, score: .9, chunkIndex: 0 }
    ] }) },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async (_config, request) => { prompts.push(plain(request)); return {}; }, callChatJson: async (_config, request) => { prompts.push(plain(request)); return { '1': 9 }; } }
  });
  const results = await search.searchStoredPages('ocean flight', 10, { rewrite: false, rerank: true, filters: { domain: 'archive.test', from: 10, before: 20 } });
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title, hit.chunkIndex]), [['history', 15, 'Old field report', 0]]);
  assert.equal(prompts.length, 1);
  assert.match(JSON.stringify(prompts), /Historic observations about coastal terns/);
  assert.doesNotMatch(JSON.stringify(prompts), /Replacement|Stale index/);
});

test('an exact historic version removed during semantic refinement is not restored to final results', async () => {
  const history = { title: 'Historic survey', text: 'A copper tern nests here.', chunks: [], versionId: 'history', timestamp: 15 };
  const page = { ...saved('https://archive.test/survey', 'Current survey', 'Unrelated rocks.', 30), versionId: 'current', versions: [history] };
  const search = await searchLibrary([page], async () => { page.versions = []; return []; });
  const early = [];
  const results = await search.searchStoredPages('copper tern', 10, { onTextResults: hits => early.push(plain(hits)) });
  assert.deepEqual(early[0].map(hit => hit.versionId), ['history']);
  assert.deepEqual(plain(results), []);
});

for (const change of ['removed', 'outside the date range']) test(`quoted history is rechecked after early delivery when its snapshot becomes ${change}`, async () => {
  const history = { title: 'Historic survey', text: 'A copper tern nests here.', chunks: [], versionId: 'history', timestamp: 15 };
  const page = { ...saved('https://archive.test/survey', 'Current survey', 'Unrelated rocks.', 30), versionId: 'current', versions: [history] };
  const search = await searchLibrary([page]);
  const early = [];
  const results = await search.searchStoredPages('"copper tern"', 10, { filters: { from: 10, before: 20 }, onTextResults: hits => {
    early.push(plain(hits));
    page.versions = change === 'removed' ? [] : [{ ...history, timestamp: 25 }];
  } });
  assert.deepEqual(early[0].map(hit => [hit.versionId, hit.timestamp]), [['history', 15]]);
  assert.deepEqual(plain(results), []);
  assert.deepEqual(search.calls, { embeddings: 0, chat: 0 });
});

for (const [label, timestamp, firstCapturedAt] of [['capture time', 0, undefined], ['first-captured time', 15, 0]]) test(`legacy semantic hits resolve a retained ${label} of zero without borrowing the current snapshot`, async () => {
  const history = { title: 'Historic report', text: 'Saved coastal observations.', chunks: [{ text: 'Saved coastal observations.' }], versionId: 'history', timestamp, firstCapturedAt };
  const page = { ...saved('https://archive.test/report', 'Replacement report', 'Replacement rocks.', 30), versionId: 'current', versions: [history] };
  const prompts = [];
  const search = await searchLibrary([page], async () => [[1, 0]], {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({ candidates: [{ url: page.url, timestamp: 0, title: 'Stale title', snippet: 'Stale excerpt.', chunkIndex: 0, score: 1 }] }) },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async (_config, request) => { prompts.push(plain(request)); return {}; }, callChatJson: async (_config, request) => { prompts.push(plain(request)); return { '1': 9 }; } }
  });
  const results = await search.searchStoredPages('ocean flight', 10, { rewrite: false, rerank: true, filters: { from: 0, before: 20 } });
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title]), [['history', timestamp, 'Historic report']]);
  assert.equal(prompts.length, 1);
  assert.match(JSON.stringify(prompts), /Saved coastal observations/);
  assert.doesNotMatch(JSON.stringify(prompts), /Replacement|Stale/);
});

for (const versionId of [undefined, 'history']) test(`semantic ${versionId ? 'version identity disambiguates' : 'timestamp alone cannot disambiguate'} captures with the same body but different titles`, async () => {
  const history = { title: 'Original report', text: 'Shared saved observations.', chunks: [{ text: 'Shared saved observations.' }], versionId: 'history', timestamp: 0 };
  const page = { ...saved('https://archive.test/report', 'Changed report title', 'Shared saved observations.', 0), chunks: history.chunks, versionId: 'current', versions: [history] };
  const prompts = [], requests = [];
  const search = await searchLibrary([page], async () => [[1, 0]], {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => {
      requests.push(message.type);
      return message.type === 'OFFSCREEN_TOP_PAGES' ? { pages: [{ url: page.url }] } : { candidates: [{ url: page.url, timestamp: 0, versionId, title: 'Stale title', snippet: 'Stale excerpt.', chunkIndex: 0, score: 1 }] };
    } },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async (_config, request) => { prompts.push(plain(request)); return {}; }, callChatJson: async (_config, request) => { prompts.push(plain(request)); return { '1': 9 }; } }
  });
  const results = await search.searchStoredPages('ocean flight', 10, { rewrite: false, rerank: true });
  assert.deepEqual(plain(results).map(hit => [hit.versionId, hit.timestamp, hit.title]), versionId ? [['history', 0, 'Original report']] : []);
  assert.equal(prompts.length, versionId ? 1 : 0);
  assert.doesNotMatch(JSON.stringify(prompts), /Changed report title|Stale/);
  assert.deepEqual(requests, ['OFFSCREEN_TOP_PAGES', 'OFFSCREEN_SCORE_CHUNKS']);
});

for (const timestamp of [0, NaN, Infinity]) test(`legacy semantic capture time ${timestamp} cannot fall back to unrelated current text when unavailable`, async () => {
  const page = { ...saved('https://archive.test/report', 'Current report', 'Current saved observations.', 30), versionId: 'current' };
  const prompts = [], requests = [];
  const search = await searchLibrary([page], async () => [[1, 0]], {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => {
      requests.push(message.type);
      return message.type === 'OFFSCREEN_TOP_PAGES' ? { pages: [{ url: page.url }] } : { candidates: [{ url: page.url, timestamp, title: 'Stale title', snippet: 'Stale excerpt.', score: 1 }] };
    } },
    '../providers/chat': { getChatConfig: async () => ({}), callChat: async (_config, request) => { prompts.push(plain(request)); return {}; }, callChatJson: async (_config, request) => { prompts.push(plain(request)); return { '1': 9 }; } }
  });
  const results = await search.searchStoredPages('ocean flight', 10, { rewrite: false, rerank: true });
  assert.deepEqual(plain(results), []);
  assert.deepEqual(prompts, []);
  assert.deepEqual(requests, ['OFFSCREEN_TOP_PAGES', 'OFFSCREEN_SCORE_CHUNKS']);
});
