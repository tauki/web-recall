import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, plain } from './helpers.mjs';

const mod = await loadSource('src/background/ask/conversation.ts');
const makeState = () => ({ schemaVersion: 1, scope: 'null', summary: '', turns: [], references: [] });

test('short conversations carry every prior turn without an unnecessary model call', async () => {
  const history = [{ question: 'Which project?', answer: 'Cedar [7]' }, { question: 'And the date?', answer: 'May 19 [7]' }];
  const state = await mod.prepareConversation({ history, contextTokens: 4096, summarize: async () => assert.fail('Short history does not need compaction') });
  assert.deepEqual(plain(state.turns), history);
  assert.match(mod.conversationText(state), /Cedar/);
  assert.match(mod.conversationText(state), /May 19/);
});

test('long histories compact older turns instead of silently dropping everything but the last three', async () => {
  const state = makeState();
  state.turns = [{ question: 'Remember Project Cedar', answer: 'Its launch is May 19 [7]. ' + 'Older explanation. '.repeat(60) }, ...Array.from({ length: 5 }, (_, index) => ({ question: `Follow-up ${index}`, answer: 'A short clarification.' }))];
  state.references = [{ index: 7, url: 'https://example.test/cedar', title: 'Cedar', timestamp: 1 }];
  const prompts = []; let compacted = false;
  const result = await mod.prepareConversation({ state, contextTokens: 2048, onCompact: () => { compacted = true; }, summarize: async prompt => { prompts.push(prompt); return 'We are discussing Project Cedar; its saved launch date was May 19 [7]. Clarifications remain open. Verify facts from the saved page.'; } });
  assert.ok(compacted);
  assert.match(prompts[0], /Remember Project Cedar/);
  assert.match(prompts.join('\n'), /Older explanation/);
  assert.match(mod.conversationText(result), /Project Cedar/);
  assert.match(mod.conversationText(result), /May 19 \[7\]/);
  assert.deepEqual(plain(result.references), state.references, 'evidence identity is not summarized or renumbered');
  assert.ok(mod.estimateTokens(mod.conversationText(result)) <= Math.floor(2048 * .2));
  assert.equal(state.summary, '', 'preparing a request must not mutate the caller’s checkpoint');
});

test('switching source scope cannot carry a prior scope’s summary, history or source identities', async () => {
  const state = { ...makeState(), summary: 'Outside private conversation', turns: [{ question: 'Private', answer: 'Secret [7]' }], references: [{ index: 7, url: 'https://outside.test', title: 'Private' }] };
  const result = await mod.prepareConversation({ state, history: state.turns, scopeUrls: ['https://inside.test'], contextTokens: 4096, summarize: async () => assert.fail('Scope reset needs no inference') });
  assert.equal(result.summary, ''); assert.equal(result.turns.length, 0); assert.equal(result.references.length, 0);
});

test('each compaction part receives the active follow-up and the prior working state', async () => {
  const question = 'Which launch date did we discuss for Cedar?';
  const history = [{ question: 'Remember Cedar', answer: 'Cedar launches May 19 [7]. ' + 'Additional discussion. '.repeat(100) }];
  let summaries = 0;
  const state = await mod.prepareConversation({ question, history, contextTokens: 1024, summarize: async prompt => {
    assert.ok(prompt.includes(question), 'compaction must know which subject and facts the current question needs');
    if (summaries++) assert.ok(prompt.includes('Cedar launches May 19 [7].'), 'later parts must receive earlier retained facts, not replace them blindly');
    return 'Cedar launches May 19 [7].';
  } });
  assert.ok(summaries > 1);
  assert.match(state.summary, /May 19 \[7\]/);
});

test('source identity survives retrieval reordering and distinguishes saved versions without storing page bodies', () => {
  const references = [];
  const cedar = mod.sourceReference(references, { url: 'https://example.test/cedar', title: 'Cedar', timestamp: 1, evidence: 'Do not store full page text in the reference index' });
  const maple = mod.sourceReference(references, { url: 'https://example.test/maple', title: 'Maple', timestamp: 1 });
  assert.equal(mod.sourceReference(references, { ...cedar }).index, cedar.index);
  assert.notEqual(maple.index, cedar.index);
  assert.notEqual(mod.sourceReference(references, { ...cedar, timestamp: 2 }).index, cedar.index);
  assert.equal(Object.hasOwn(cedar, 'evidence'), false);
});

test('version IDs keep source numbers stable across unchanged recaptures and distinguish new content at the same time', () => {
  const references = [];
  const original = mod.sourceReference(references, { url: 'https://example.test/cedar', title: 'Cedar', timestamp: 10, versionId: 'original', evidence: 'Saved body' });
  const revisited = mod.sourceReference(references, { url: 'https://example.test/cedar', title: 'Cedar', timestamp: 20, versionId: 'original' });
  const changed = mod.sourceReference(references, { url: 'https://example.test/cedar', title: 'Revised Cedar', timestamp: 20, versionId: 'revised' });
  const otherUrl = mod.sourceReference(references, { url: 'https://example.test/maple', title: 'Maple', timestamp: 10, versionId: 'original' });
  assert.equal(original.index, 1);
  assert.equal(revisited.index, 1);
  assert.equal(changed.index, 2);
  assert.equal(otherUrl.index, 3);
  assert.equal(original.versionId, 'original');
  assert.equal(changed.versionId, 'revised');
  assert.equal(Object.hasOwn(original, 'evidence'), false);
});

test('legacy timestamp references cannot alias a known version merely because capture times coincide', () => {
  const references = [{ index: 7, url: 'https://example.test/cedar', title: 'Legacy Cedar', timestamp: 10 }];
  assert.equal(mod.sourceReference(references, { url: 'https://example.test/cedar', title: 'Legacy Cedar', timestamp: 10 }).index, 7);
  assert.equal(mod.sourceReference(references, { url: 'https://example.test/cedar', title: 'Cedar', timestamp: 10, versionId: 'original' }).index, 8);
  assert.equal(mod.sourceReference(references, { url: 'https://example.test/cedar', title: 'Legacy Cedar', timestamp: 20 }).index, 9);
});

test('cancellation during compaction prevents another summarization and leaves the original checkpoint intact', async () => {
  const controller = new AbortController(), state = makeState();
  state.turns = [{ question: 'Question', answer: 'Large answer '.repeat(500) }];
  let calls = 0;
  await assert.rejects(mod.prepareConversation({ state, contextTokens: 1024, signal: controller.signal, summarize: async () => { calls++; controller.abort(Error('Stopped')); return 'Partial notes'; } }), /Stopped/);
  assert.equal(calls, 1); assert.equal(state.turns.length, 1); assert.equal(state.summary, '');
});

test('oversized summaries are condensed or rejected, never silently clipped into a supposedly complete checkpoint', async () => {
  const state = makeState(); state.turns = [{ question: 'Cedar', answer: 'Earlier answer. '.repeat(200) }];
  let calls = 0;
  const result = await mod.prepareConversation({ state, contextTokens: 1024, summarize: async () => ++calls === 1 ? 'Verbose notes. '.repeat(30) : 'Cedar remains the subject. Check source [7].' });
  assert.match(result.summary, /Check source \[7\]/);
  assert.ok(calls >= 2);
  await assert.rejects(mod.prepareConversation({ state, contextTokens: 1024, summarize: async () => 'Still too verbose. '.repeat(1000) }), /could not compact/);
  assert.equal(state.turns.length, 1); assert.equal(state.summary, '');
});
