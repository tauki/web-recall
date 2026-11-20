import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain } from './helpers.mjs';

const url = 'https://example.test/cedar';
const original = {
  url, title: 'Original Cedar schedule', versionId: 'cedar-original', timestamp: 10,
  text: 'Original approval. The launch date is May 19.',
  chunks: [{ text: 'Original approval.', embedding: [] }, { text: 'The launch date is May 19.', embedding: [] }]
};
const replacement = {
  url, title: 'Revised Cedar schedule', versionId: 'cedar-revised', timestamp: 20,
  text: 'Revised approval. The launch date is June 24.',
  chunks: [{ text: 'Revised approval.', embedding: [] }, { text: 'The launch date is June 24.', embedding: [] }]
};
const oldHit = { url, title: 'Original Cedar schedule', versionId: 'cedar-original', timestamp: 10, snippet: 'The launch date is May 19.', chunkIndex: 1, score: 1 };
const newHit = { url, title: 'Revised Cedar schedule', versionId: 'cedar-revised', timestamp: 20, snippet: 'The launch date is June 24.', chunkIndex: 1, score: .9 };

async function scenario(options = {}) {
  const prompts = [], events = [], reads = [];
  const model = {
    getChatConfig: async () => ({ providerId: options.provider || 'ollama', model: options.provider === 'apple' ? 'on-device' : 'fixture', contextTokens: 8192 }),
    normalizeToolArguments: value => value,
    callChatJson: async (_config, body) => { prompts.push(plain(body)); return options.ranking || null; },
    callChat: async (_config, body) => {
      prompts.push(plain(body));
      return options.research ? options.research(body) : { message: { content: 'The saved original date is May 19 [1].\nCoverage: high' } };
    },
    streamChat: async (_config, body) => {
      prompts.push(plain(body));
      return JSON.stringify({ outcome: 'answered', answer: options.answer || 'The saved original date is May 19 [1].' });
    }
  };
  const mod = await loadSource('src/background/ask/index.ts', '', {
    '../storage/manager': { storageManager: {
      getPageRecord: async requested => { reads.push(requested); return options.read ? options.read(requested) : { ...replacement, versions: [original] }; },
      listRecentPages: async () => [original]
    } },
    '../search/index': { searchStoredPages: async query => options.search ? options.search(query) : [oldHit] },
    '../settings/index': { getSettings: async () => ({ queryRewrite: false, askRerank: false, enableTools: false, ...options.settings }) },
    '../providers/chat': model,
    '../providers/apple': { callApple: async (request, callbacks) => {
      prompts.push(plain(request));
      if (options.native) await options.native(callbacks);
      return JSON.stringify({ outcome: 'answered', answer: options.answer || 'The saved original date is May 19 [1].' });
    } }
  }, { chrome: { ...chromeFixture, runtime: { sendMessage: event => events.push(plain(event)) } } });
  return { mod, prompts, events, reads };
}

for (const provider of ['ollama', 'apple']) test(`${provider} Ask resolves an older hit to its retained body, title, capture time and version ID`, async () => {
  const fixture = await scenario({ provider });
  const result = await fixture.mod.handleAskQuestion('What was the original launch date?');
  assert.equal(result.outcome, 'answered');
  assert.deepEqual(plain(result.sources).map(source => ({ index: source.index, title: source.title, timestamp: source.timestamp, versionId: source.versionId, evidence: source.evidence })), [
    { index: 1, title: 'Original Cedar schedule', timestamp: 10, versionId: 'cedar-original', evidence: 'The launch date is May 19.' }
  ]);
  assert.match(JSON.stringify(fixture.prompts), /Original Cedar schedule/);
  assert.match(JSON.stringify(fixture.prompts), /The launch date is May 19/);
  assert.doesNotMatch(JSON.stringify(fixture.prompts), /June 24|Revised Cedar/);
  assert.deepEqual(plain(result.conversation.references), [{ index: 1, url, title: 'Original Cedar schedule', timestamp: 10, versionId: 'cedar-original' }]);
});

for (const missing of ['retained version', 'whole record']) test(`Ask fails actionably for a known missing ${missing}, without sending another body to a model`, async () => {
  const fixture = await scenario({ read: async () => missing === 'whole record' ? undefined : replacement });
  await assert.rejects(fixture.mod.handleAskQuestion('What was the original launch date?'), /no longer available.*[Ss]earch again/);
  assert.deepEqual(fixture.prompts, []);
  assert.equal(fixture.events.filter(event => event.type === 'ASK_RUN_STATE').at(-1).event.phase, 'failed');
});

for (const timestamp of [0, 10]) test(`a legacy timestamp-only Ask hit reads the actual retained snapshot at time ${timestamp}`, async () => {
  const earlier = { ...original, timestamp };
  const fixture = await scenario({ search: async () => [{ ...oldHit, versionId: undefined, timestamp }], read: async () => ({ ...replacement, versions: [earlier] }) });
  const result = await fixture.mod.handleAskQuestion('What was the saved original date?');
  assert.equal(result.outcome, 'answered');
  assert.deepEqual(plain(result.sources).map(source => [source.versionId, source.timestamp, source.evidence]), [['cedar-original', timestamp, 'The launch date is May 19.']]);
  assert.doesNotMatch(JSON.stringify(fixture.prompts), /June 24|Revised Cedar/);
});

test('a legacy Ask hit resolves an unchanged version by its first capture time after a revisit', async () => {
  const fixture = await scenario({ search: async () => [{ ...oldHit, versionId: undefined }], read: async () => ({ ...original, timestamp: 30, firstCapturedAt: 10 }) });
  const result = await fixture.mod.handleAskQuestion('What was saved?');
  assert.equal(result.sources[0].versionId, 'cedar-original');
  assert.equal(result.sources[0].timestamp, 30);
  assert.equal(result.sources[0].evidence, 'The launch date is May 19.');
});

for (const change of ['removed', 'different body at the same time', 'different title at the same time']) test(`a legacy Ask hit fails before synthesis when its snapshot is ${change}`, async () => {
  const fixture = await scenario({
    search: async () => [{ ...oldHit, versionId: undefined }],
    read: async () => change === 'removed' ? replacement : ({ ...original, versions: [{ ...replacement, timestamp: 10, ...(change === 'different title at the same time' ? { text: original.text, chunks: original.chunks } : {}) }] })
  });
  await assert.rejects(fixture.mod.handleAskQuestion('What was the saved date?'), /no longer available|[Ss]everal captures share/);
  assert.deepEqual(fixture.prompts, []);
});

for (const change of ['recaptured', 'temporarily unreadable']) test(`Ask keeps its acquired evidence when storage is ${change} before synthesis`, async () => {
  let reads = 0;
  const fixture = await scenario({ settings: { enableTools: true }, read: async () => {
    if (++reads === 1) return original;
    if (change === 'temporarily unreadable') throw Error('Transient storage read failure');
    return replacement;
  } });
  const result = await fixture.mod.handleAskQuestion('What was the original launch date?');
  assert.equal(result.outcome, 'answered');
  assert.match(JSON.stringify(fixture.prompts), /Original Cedar schedule/);
  assert.doesNotMatch(JSON.stringify(fixture.prompts), /June 24|Revised Cedar/);
  assert.equal(result.sources[0].versionId, 'cedar-original');
  assert.equal(result.sources[0].timestamp, 10);
  assert.equal(result.sources[0].evidence, 'The launch date is May 19.');
  assert.equal(reads, 1, 'building model context from already-acquired evidence must not re-read storage');
});

test('Ask keeps two versions of one URL as separate evidence rather than joining their snippets or metadata', async () => {
  const fixture = await scenario({ search: async () => [oldHit, newHit], answer: 'Originally May 19 [1], later June 24 [2].' });
  const result = await fixture.mod.handleAskQuestion('Compare the saved launch dates');
  assert.equal(result.outcome, 'answered');
  assert.deepEqual(plain(result.sources).map(source => [source.index, source.versionId, source.timestamp, source.snippet, source.evidence]), [
    [1, 'cedar-original', 10, 'The launch date is May 19.', 'The launch date is May 19.'],
    [2, 'cedar-revised', 20, 'The launch date is June 24.', 'The launch date is June 24.']
  ]);
  const prompt = fixture.prompts.at(-1).messages.find(message => message.role === 'user').content;
  assert.match(prompt, /\[1\] Title: Original Cedar schedule[\s\S]*May 19[\s\S]*\[2\] Title: Revised Cedar schedule[\s\S]*June 24/);
});

test('public Ask follow-ups reuse a version source number after an unchanged recapture but not after new content', async () => {
  let page = original, hit = oldHit;
  const options = { read: async () => page, search: async () => [hit], answer: 'Saved evidence [1].' };
  const fixture = await scenario(options);
  const first = await fixture.mod.handleAskQuestion('What was saved?');
  assert.equal(first.outcome, 'answered');
  page = { ...original, timestamp: 30 };
  hit = { ...oldHit, timestamp: 30 };
  const revisited = await fixture.mod.handleAskQuestion('And now?', { conversation: first.conversation });
  assert.equal(revisited.outcome, 'answered');
  assert.equal(revisited.sources[0].index, 1);
  assert.equal(revisited.sources[0].timestamp, 30);
  assert.equal(revisited.sources[0].versionId, 'cedar-original');
  assert.equal(revisited.conversation.references.length, 1);
  page = { ...replacement, timestamp: 30 };
  hit = { ...newHit, timestamp: 30 };
  options.answer = 'The revised date is June 24 [2].';
  const changed = await fixture.mod.handleAskQuestion('Did it change?', { conversation: revisited.conversation });
  assert.equal(changed.outcome, 'answered');
  assert.deepEqual(plain(changed.sources).map(source => [source.index, source.versionId]), [[2, 'cedar-revised']]);
  assert.deepEqual(plain(changed.conversation.references).map(reference => [reference.index, reference.versionId]), [[1, 'cedar-original'], [2, 'cedar-revised']]);
  assert.equal(first.conversation.references.length, 1, 'follow-ups must not mutate earlier conversation checkpoints');
  options.answer = 'The revised date is June 24 [1].';
  const cleared = await fixture.mod.handleAskQuestion('Start over');
  assert.equal(cleared.outcome, 'answered');
  assert.deepEqual(plain(cleared.conversation.references).map(reference => [reference.index, reference.versionId]), [[1, 'cedar-revised']]);
});

test('query fusion retains different versions found by separate queries and reranks them independently', async () => {
  const fixture = await scenario({
    settings: { queryRewrite: true, askRerank: true },
    research: async () => ({ message: { content: 'revised approval' } }),
    search: async query => query === 'revised approval' ? [newHit] : [oldHit],
    ranking: { '1': 1, '2': 9 }, answer: 'Revised June 24 [1], originally May 19 [2].'
  });
  const result = await fixture.mod.handleAskQuestion('Compare the launch approvals');
  assert.equal(result.outcome, 'answered');
  assert.deepEqual(plain(result.sources).map(source => [source.index, source.versionId, source.evidence]), [
    [1, 'cedar-revised', 'The launch date is June 24.'], [2, 'cedar-original', 'The launch date is May 19.']
  ]);
});

test('Ask without search preserves the listed version identity if the page is recaptured before its context read', async () => {
  const fixture = await scenario({ answer: 'The original schedule has an approval [1].' });
  const result = await fixture.mod.handleAskQuestion('Read the saved schedule', { useSearch: false });
  assert.equal(result.outcome, 'answered');
  assert.deepEqual(plain(result.sources).map(source => [source.versionId, source.timestamp, source.evidence]), [['cedar-original', 10, 'Original approval.']]);
  assert.match(JSON.stringify(fixture.prompts), /Original Cedar schedule/);
  assert.doesNotMatch(JSON.stringify(fixture.prompts), /June 24|Revised Cedar/);
});

for (const provider of ['ollama', 'apple']) test(`${provider} tool evidence forwards actual page and hit identities without aliasing versions or renumbering recaptures`, async () => {
  const outputs = [];
  const calls = [
    ['fetch_more', { url, chunkIndex: 1 }],
    ['search_memory', { query: 'original approval' }],
    ['search_memory', { query: 'revised approval' }]
  ];
  let step = 0;
  const fixture = await scenario({
    provider, settings: { enableTools: true, maxToolSteps: 6 },
    search: async query => query === 'original approval' ? [{ ...oldHit, timestamp: 11 }] : query === 'revised approval' ? [{ ...newHit, timestamp: 21 }] : [oldHit],
    answer: 'Originally May 19 [1], later June 24 [2].',
    research: async body => {
      outputs.push(...body.messages.filter(message => message.role === 'tool').slice(outputs.length).map(message => JSON.parse(message.content)));
      const call = calls[step++];
      return { message: call ? { tool_calls: [{ function: { name: call[0], arguments: call[1] } }] } : { content: 'Originally May 19 [1], later June 24 [2].\nCoverage: high' } };
    },
    native: async callbacks => {
      for (const [name, args] of calls) outputs.push(JSON.parse((await callbacks.onToolCall(name, args, `native-${name}-${outputs.length}`)).content));
    }
  });
  const result = await fixture.mod.handleAskQuestion('Compare the launch approvals', { scopeUrls: [url] });
  assert.equal(result.outcome, 'answered');
  assert.equal(outputs.length, 3);
  assert.deepEqual(outputs.map(output => { const row = Array.isArray(output.data) ? output.data[0] : output.data; return [output.ok, row.sourceIndex, row.versionId, row.timestamp]; }), [
    [true, 2, 'cedar-revised', 20], [true, 1, 'cedar-original', 11], [true, 2, 'cedar-revised', 21]
  ]);
  assert.deepEqual(plain(result.sources).map(source => [source.index, source.versionId]), [[1, 'cedar-original'], [2, 'cedar-revised']]);
  assert.doesNotMatch(JSON.stringify(result.sources[0]), /June 24|Revised Cedar/);
  assert.doesNotMatch(JSON.stringify(result.sources[1]), /May 19|Original Cedar/);
  assert.equal(fixture.events.filter(event => event.type === 'ASK_TOOL_ACTIVITY' && event.event.status === 'started').length, 3);
});

test('search_memory preserves separate same-URL versions across pagination and forwards each hit identity', async () => {
  const { ToolsRuntime } = await loadSource('src/shared/tools/runtime.ts');
  const runtime = new ToolsRuntime({ allowedUrls: new Set([url]), pageText: new Map(), pages: [replacement], searchMemory: async () => [oldHit, newHit] });
  const first = JSON.parse((await runtime.runToolCall('search_memory', { query: 'launch', k: 1 })).content);
  assert.deepEqual(first.data.map(hit => [hit.versionId, hit.timestamp, hit.snippet]), [['cedar-original', 10, 'The launch date is May 19.']]);
  assert.deepEqual(first.nextArgs, { query: 'launch', k: 1, offset: 1 });
  const next = JSON.parse((await runtime.runToolCall('search_memory', first.nextArgs)).content);
  assert.deepEqual(next.data.map(hit => [hit.versionId, hit.timestamp, hit.snippet]), [['cedar-revised', 20, 'The launch date is June 24.']]);
  assert.equal(next.nextArgs, null);
});
