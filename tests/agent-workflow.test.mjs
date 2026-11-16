import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain } from './helpers.mjs';

const overview = { url: 'https://example.test/release', title: 'Release overview', timestamp: 1, text: 'Look in the release approvals for the date.', chunks: [{ text: 'Look in the release approvals for the date.' }] };
const details = { url: 'https://example.test/approvals', title: 'Release approvals', timestamp: 2, text: 'Approvals\nThe Cedar launch is May 19.', chunks: [{ text: 'Approvals' }, { text: 'The Cedar launch is May 19.' }] };
const invoke = (name, args) => ({ function: { name, arguments: args } });

async function setup(provider, options = {}) {
  const reads = [], calls = [], events = [];
  const storage = { getPageRecord: async url => { reads.push(url); return [overview, details].find(page => page.url === url); }, listAllPages: async () => assert.fail('Ask tools must not eagerly load the library') };
  let step = 0;
  const chat = {
    getChatConfig: async () => ({ providerId: provider, model: provider === 'apple' ? 'on-device' : 'test-model', contextTokens: options.forceCompaction ? 4096 : 8192 }),
    callChatJson: async () => null, normalizeToolArguments: value => value,
    callChat: async (_config, body) => {
      calls.push(plain(body));
      if (!body.tools) return { message: { content: 'We found release approvals [2]. Read the launch date from its saved passage; do not infer it from the preview.' } };
      if (step++ === 0) return { message: { thinking: options.forceCompaction ? 'Internal continuation '.repeat(1000) : 'Provider continuation state', tool_calls: [invoke('search_memory', { query: 'release approvals' }), ...(options.maxToolSteps === 1 ? [invoke('fetch_more', { url: details.url, chunkIndex: 1 })] : [])] } };
      if (step === 2) {
        const previous = body.messages.find(message => message.role === 'assistant');
        if (options.forceCompaction) assert.match(JSON.stringify(body.messages), /release approvals \[2\]/);
        else assert.equal(previous.thinking, 'Provider continuation state', 'the provider’s continuation must survive a tool round trip');
        return { message: { tool_calls: [invoke('fetch_more', { url: details.url, chunkIndex: 1 })] } };
      }
      return { message: { content: 'Cedar launches May 19 [2].\nCoverage: high' } };
    },
    streamChat: async (_config, body, onChunk) => {
      calls.push(plain(body));
      if (options.maxToolSteps === 1) return JSON.stringify({ outcome: 'insufficient_evidence', answer: 'The date is not in the retrieved preview.' });
      assert.match(JSON.stringify(body), /May 19/);
      const answer = JSON.stringify({ outcome: 'answered', answer: 'Cedar launches May 19 [2].' });
      onChunk(answer); return answer;
    }
  };
  const native = { callApple: async (request, callbacks) => {
    calls.push(plain(request));
    assert.doesNotMatch(JSON.stringify(request), /The Cedar launch is May 19/, 'Unread passages must remain in browser storage until a tool requests them');
    const search = JSON.parse((await callbacks.onToolCall('search_memory', { query: 'release approvals' }, 'native-search')).content);
    assert.equal(search.data[0].sourceIndex, 2);
    const read = JSON.parse((await callbacks.onToolCall('fetch_more', { url: details.url, chunkIndex: 1 }, 'native-read')).content);
    assert.equal(read.data.sourceIndex, 2);
    assert.equal(read.data.text, 'The Cedar launch is May 19.');
    callbacks.onChunk('Cedar launches May 19 [2].');
    return JSON.stringify({ outcome: 'answered', answer: 'Cedar launches May 19 [2].' });
  } };
  const mod = await loadSource('src/background/ask/index.ts', '', {
    '../storage/manager': { storageManager: storage },
    '../search/index': { searchStoredPages: async query => (query === 'release approvals' ? [details] : [overview]).map(page => ({ ...page, score: 1, snippet: page === details ? 'Approvals mention a release date.' : page.text })) },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, askRerank: false, enableTools: true, maxToolSteps: 6, ...options }) },
    '../providers/chat': chat, '../providers/apple': native
  }, { chrome: { ...chromeFixture, runtime: { sendMessage: event => events.push(event) } } });
  return { mod, reads, calls, events };
}

for (const provider of ['ollama', 'apple']) test(`${provider} discovers an initially missing page, reads its supporting passage and returns the same stable citation`, async () => {
  const scenario = await setup(provider);
  const result = await scenario.mod.handleAskQuestion('When does Cedar launch?');
  assert.equal(result.outcome, 'answered');
  assert.match(result.answer, /May 19 \[2\]/);
  assert.deepEqual(plain(result.sources).map(source => [source.index, source.url]), [[2, details.url]]);
  assert.ok(result.sources[0].excerpts.includes('The Cedar launch is May 19.'));
  assert.ok(scenario.reads.includes(details.url));
  assert.ok(scenario.events.some(event => event.type === 'ASK_TOOL_ACTIVITY' && event.event.status === 'completed'));
});

test('one configured call cannot execute a multi-call model response twice', async () => {
  const scenario = await setup('ollama', { maxToolSteps: 1 });
  const result = await scenario.mod.handleAskQuestion('When does Cedar launch?');
  const started = scenario.events.filter(event => event.type === 'ASK_TOOL_ACTIVITY' && event.event.status === 'started');
  assert.deepEqual(started.map(event => event.event.tool), ['search_memory']);
  assert.equal(result.outcome, 'insufficient_evidence');
});

test('Ollama compacts an overfull tool transcript and continues retrieval without losing evidence identity', async () => {
  const scenario = await setup('ollama', { forceCompaction: true });
  const result = await scenario.mod.handleAskQuestion('When does Cedar launch?');
  assert.equal(result.outcome, 'answered');
  assert.match(result.answer, /May 19 \[2\]/);
  assert.equal(result.sources[0].url, details.url);
  assert.ok(scenario.events.some(event => event.type === 'ASK_RUN_STATE' && event.event.phase === 'compacting'));
  const states = scenario.events.filter(event => event.type === 'ASK_RUN_STATE').map(event => event.event);
  assert.equal(states.at(-1).phase, 'completed');
  assert.ok(states.every((state, index) => index === 0 || state.sequence > states[index - 1].sequence));
});

test('agent retrieval can page beyond the interactive search display limit', async () => {
  const pages = Array.from({ length: 65 }, (_, index) => ({ url: `https://example.test/page-${index}`, title: `Needle ${index}`, text: 'Needle evidence', timestamp: 1, chunks: [] }));
  const mod = await loadSource('src/background/search/index.ts', '', {
    '../storage/manager': { storageManager: { listAllPages: async () => pages, getPageRecord: async url => pages.find(page => page.url === url) } },
    '../embeddings/index': { computeEmbeddingsForQueries: async () => [[1, 0]], getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'fixture' }) },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => message.type === 'OFFSCREEN_TOP_PAGES' ? { pages: pages.map(page => ({ url: page.url })) } : { candidates: pages.map((page, index) => ({ ...page, snippet: page.text, score: 1 - index / 100 })) } },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false }) },
    '../providers/chat': { getChatConfig: async () => assert.fail('This retrieval does not need chat'), callChat: async () => ({}), callChatJson: async () => null }
  });
  const result = await mod.searchStoredPages('needle', pages.length, { rewrite: false, rerank: false, pageable: true });
  assert.equal(result.length, pages.length);
  assert.equal(new Set(result.map(page => page.url)).size, pages.length);
});
