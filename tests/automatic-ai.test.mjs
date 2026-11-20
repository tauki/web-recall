import test from 'node:test';
import assert from 'node:assert/strict';
import { recallFixture, recallPage } from './recall-fixture.mjs';
import { providerFixture } from './provider-fixture.mjs';
import { loadSource, plain, tick, waitFor } from './helpers.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pathOf = input => new URL(input).pathname;

test('fresh startup, manual saving, unquoted search and saved reading need no provider, native helper or model download', async testContext => {
  const modelCalls = [], offscreen = [];
  const state = await recallFixture(testContext, { fetch: async input => { modelCalls.push(String(input)); return Response.json({ error: 'No model installed' }, { status: 404 }); }, offscreen: { ensureOffscreenDocument: async () => { offscreen.push('open'); }, sendOffscreenMessage: async message => { offscreen.push(message.type); return {}; } } });
  const settings = (await state.send({ type: 'GET_SETTINGS' })).settings;
  assert.equal(settings.paused, true); assert.equal(settings.automaticAi, false); assert.equal(settings.recallSetupComplete, false);
  assert.deepEqual(modelCalls, []);
  const saved = await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); assert.equal(saved.ok, true);
  await state.drain();
  const record = await state.db.getPageRecord(recallPage.url);
  assert.equal(record.text, recallPage.text); assert.ok(record.chunks.every(chunk => chunk.embedding.length === 0)); assert.equal(record.summary, undefined);
  assert.equal((await state.send({ type: 'GET_PROCESSING' })).queue.length, 0);
  const found = await state.send({ type: 'SEARCH_QUERY', query: 'Copper terns', requestId: 'text-only' });
  assert.equal(found.error, undefined); assert.equal(found.results[0].url, recallPage.url); assert.equal(found.results[0].textMatch, true);
  const read = await state.send({ type: 'GET_SAVED_PAGE', url: found.results[0].url, versionId: found.results[0].versionId, query: 'Copper terns' });
  assert.equal(read.page.text, recallPage.text);
  assert.equal(read.page.text.slice(read.page.match.start, read.page.match.end), 'Copper terns');
  assert.deepEqual(modelCalls, []); assert.deepEqual(offscreen, []); assert.equal(state.nativeCalls(), 0);
});

test('fresh off persists across unrelated preferences, concurrent writes and a settings-worker restart', async () => {
  const backend = providerFixture(); for (const key of Object.keys(backend.stored)) delete backend.stored[key];
  const settings = await backend.load('src/background/settings/index.ts');
  await Promise.all([settings.updateSettings({ theme: 'dark' }), settings.updateSettings({ captureSetupComplete: true, paused: false, denylist: ['private.test'] })]);
  const restarted = await backend.load('src/background/settings/index.ts');
  const saved = await restarted.getSettings();
  assert.equal(saved.automaticAi, false); assert.equal(saved.recallSetupComplete, false);
  assert.equal(saved.theme, 'dark'); assert.equal(saved.paused, false); assert.deepEqual(plain(saved.denylist), ['private.test']);
  assert.equal(backend.requests.length, 0);
});

for (const initial of [
  { betaSettings: { theme: 'dark', searchRerank: false, queryRewrite: false, maxToolSteps: 0 } },
  { paused: true, whitelistDomains: ['selected.test'], blacklistDomains: ['private.test'] },
  { embeddingConfig: { provider: 'browser', model: 'retained-model', browserRevision: 'pinned' } },
  { betaProviderSettings: { ollama: { baseUrl: 'https://models.test' } } },
  { betaModelSettings: { chatModel: 'chosen-model' } }
]) test(`upgrade preserves earlier automatic-model behavior and preferences from ${Object.keys(initial)[0]}`, async () => {
  const backend = providerFixture(); for (const key of Object.keys(backend.stored)) delete backend.stored[key]; Object.assign(backend.stored, structuredClone(initial));
  const source = await backend.load('src/background/settings/index.ts');
  const settings = await source.getSettings();
  assert.equal(settings.automaticAi, true); assert.equal(settings.recallSetupComplete, true);
  for (const [key, value] of Object.entries(initial.betaSettings || {})) assert.deepEqual(plain(settings[key]), value);
  for (const [key, value] of Object.entries(initial).filter(([key]) => key !== 'betaSettings')) assert.deepEqual(backend.stored[key], value, 'Migration must not rewrite provider configuration or raw legacy policy');
  const restarted = await backend.load('src/background/settings/index.ts'); assert.equal((await restarted.getSettings()).automaticAi, true);
});

test('explicit off and independent retrieval preferences survive migration and later provider changes', async () => {
  const backend = providerFixture();
  backend.stored.betaSettings = { automaticAi: false, recallSetupComplete: false, activeProviderId: 'apple', queryRewrite: true, searchRerank: false, askRerank: true, maxToolSteps: 0 };
  const source = await backend.load('src/background/settings/index.ts');
  await source.updateSettings({ activeProviderId: 'ollama' });
  const saved = await (await backend.load('src/background/settings/index.ts')).getSettings();
  assert.equal(saved.automaticAi, false); assert.equal(saved.activeProviderId, 'ollama'); assert.equal(saved.recallSetupComplete, false);
  assert.equal(saved.queryRewrite, true); assert.equal(saved.searchRerank, false); assert.equal(saved.askRerank, true); assert.equal(saved.maxToolSteps, 0);
  assert.equal(backend.requests.length, 0);
});

test('enabling automatic AI does not backfill or download anything and disabled re-capture keeps existing enrichment', async testContext => {
  const state = await recallFixture(testContext);
  const record = { ...recallPage, chunks: [{ text: recallPage.text, embedding: [1, 0], embeddingKey: 'old-space' }], summary: 'Existing overview.' };
  await state.db.savePageRecord(record);
  const before = plain(await state.db.getPageRecord(record.url));
  await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: true } }); await tick();
  assert.equal(state.requests.length, 0); assert.deepEqual(plain(await state.db.getPageRecord(record.url)), before);
  await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: false } });
  await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); await state.drain();
  const recaptured = await state.db.getPageRecord(record.url);
  assert.equal(recaptured.summary, record.summary); assert.deepEqual(plain(recaptured.chunks), record.chunks); assert.equal(state.requests.length, 0);
});

for (const failWrite of [false, true]) test(`${failWrite ? 'failed' : 'committed'} automatic-AI opt-out ${failWrite ? 'preserves' : 'stops'} active refinement without losing text results`, async testContext => {
  const gate = deferred(), calls = []; let requestSignal;
  const state = await recallFixture(testContext, { fetch: async (input, options = {}) => {
    calls.push(pathOf(input));
    if (pathOf(input) !== '/api/embed') throw Error(`Unexpected model request ${input}`);
    requestSignal = options.signal; await gate.promise; return Response.json({ embeddings: [[0, 1]] });
  } });
  await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); await state.drain();
  await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: true, queryRewrite: false, searchRerank: false } });
  const pending = state.send({ type: 'SEARCH_QUERY', query: 'Copper terns', requestId: 'pending-search' });
  await waitFor(() => requestSignal, 'automatic query embedding');
  try {
    if (failWrite) state.failNextWrite('betaSettings');
    const preference = await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: false } });
    assert.equal(requestSignal.aborted, !failWrite);
    if (failWrite) { assert.match(preference.error, /Storage write failed/); gate.resolve(); }
    const response = await pending;
    assert.equal(response.error, undefined); assert.equal(response.results[0].url, recallPage.url);
    assert.deepEqual(calls, ['/api/embed']);
  } finally { gate.resolve(); await pending; }
});

test('turning off automatic AI cancels active capture inference without failing saved text or accepting late vectors', async testContext => {
  const gate = deferred(), calls = []; let requestSignal;
  const state = await recallFixture(testContext, { fetch: async (input, options = {}) => { calls.push(pathOf(input)); requestSignal = options.signal; await gate.promise; return Response.json({ embeddings: [[1, 0]] }); } });
  await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: true } });
  await state.send({ type: 'CAPTURE_ACTIVE_TAB' });
  await waitFor(() => requestSignal, 'automatic capture inference');
  try {
    await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: false } });
    assert.equal(requestSignal.aborted, true); await state.drain();
    assert.equal((await state.db.getPageRecord(recallPage.url)).text, recallPage.text);
    assert.equal((await state.send({ type: 'GET_PROCESSING' })).queue.length, 0);
  } finally { gate.resolve(); await tick(); }
  assert.deepEqual(calls, ['/api/embed']);
  assert.equal((await state.db.getPageRecord(recallPage.url)).chunks[0].embedding.length, 0);
  assert.equal((await state.db.getPageRecord(recallPage.url)).summary, undefined);
});

test('queued automatic summaries stop on opt-out while later explicit regeneration and re-embedding remain usable', async testContext => {
  const gate = deferred(), calls = []; let chatSignal, blocked = true;
  const state = await recallFixture(testContext, { fetch: async (input, options = {}) => {
    const path = pathOf(input); calls.push(path);
    if (path === '/api/embed') return Response.json({ embeddings: [[0, 1]] });
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 4096 }] });
    if (path === '/api/chat') { chatSignal = options.signal; if (blocked) await gate.promise; return Response.json({ message: { content: 'A deliberate overview.' } }); }
    throw Error(`Unexpected model request ${path}`);
  } });
  await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: true, activeProviderId: 'ollama' } });
  await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); await waitFor(() => chatSignal, 'first automatic summary');
  const other = { ...recallPage, url: 'https://recall.test/second', title: 'Another article', timestamp: 200 };
  state.setDocument(other); await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); await state.drain();
  try {
    await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: false } });
    assert.equal(chatSignal.aborted, true); blocked = false; gate.resolve(); await tick(); await tick();
    assert.equal(calls.filter(path => path === '/api/chat').length, 1, 'The queued automatic summary must not reach a model');
    assert.equal((await state.db.getPageRecord(recallPage.url)).summary, undefined); assert.equal((await state.db.getPageRecord(other.url)).summary, undefined);
    const explicit = await state.send({ type: 'REGENERATE_PAGE_SUMMARY', url: other.url, requestId: 'explicit-summary' });
    assert.equal(explicit.updated, true); assert.equal((await state.db.getPageRecord(other.url)).summary, 'A deliberate overview.');
    const backfill = await state.send({ type: 'BACKFILL_EMBEDDINGS', urls: [other.url], limit: 1, force: true, requestId: 'explicit-backfill' });
    assert.equal(backfill.result.updated, 1);
    assert.equal((await state.send({ type: 'GET_SETTINGS' })).settings.automaticAi, false);
  } finally { blocked = false; gate.resolve(); }
});

test('untrusted pages cannot opt into automatic model use or mark onboarding complete', async testContext => {
  const state = await recallFixture(testContext);
  const result = await state.send({ type: 'SET_SETTINGS', payload: { automaticAi: true, recallSetupComplete: true } }, { id: state.runtime.id, url: recallPage.url });
  assert.match(result.error, /extension pages/);
  const settings = (await state.send({ type: 'GET_SETTINGS' })).settings;
  assert.equal(settings.automaticAi, false); assert.equal(settings.recallSetupComplete, false); assert.equal(state.requests.length, 0);
});

test('an explicit Ask still retrieves model context and answers while automatic AI remains off', async testContext => {
  const calls = [];
  const state = await recallFixture(testContext, { fetch: async (input, options = {}) => {
    const path = pathOf(input); calls.push(path);
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 4096 }] });
    if (path === '/api/embed') return Response.json({ embeddings: [[1, 0]] });
    if (path === '/api/chat') {
      const body = JSON.parse(options.body), content = JSON.stringify({ outcome: 'answered', answer: 'Copper terns migrate along the coast. [1]' });
      return body.stream ? new Response(JSON.stringify({ message: { content } }) + '\n{"done":true}\n') : Response.json({ message: { content } });
    }
    throw Error(`Unexpected provider request ${path}`);
  } });
  await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); await state.drain();
  await state.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'ollama', queryRewrite: false, askRerank: false, enableTools: false } });
  const response = await state.send({ type: 'ASK_QUESTION', question: 'Where do copper terns migrate?', options: { maxResults: 1, requestId: 'explicit-ask' } });
  assert.equal(response.error, undefined); assert.equal(response.outcome, 'answered'); assert.match(response.answer, /along the coast/);
  assert.equal(response.sources[0].url, recallPage.url); assert.ok(calls.includes('/api/embed')); assert.ok(calls.includes('/api/chat'));
  assert.equal((await state.send({ type: 'GET_SETTINGS' })).settings.automaticAi, false);
});

test('fresh chat is disabled without probing, and disabling the provider stops an already running Ask', async testContext => {
  const requests = [], gate = deferred();
  let chatSignal, hold = false;
  const state = await recallFixture(testContext, { fetch: async (input, options = {}) => {
    const endpoint = pathOf(input);
    requests.push(endpoint);
    if (endpoint === '/api/tags') return Response.json({ models: [{ name: 'fixture-chat' }] });
    if (endpoint === '/api/ps') return Response.json({ models: [{ name: 'fixture-chat', context_length: 4096 }] });
    if (endpoint === '/api/chat' && hold) {
      chatSignal = options.signal; await gate.promise;
    }
    const content = 'Copper terns migrate along the coast. [1]';
    return new Response(JSON.stringify({ message: { content } }) + '\n');
  } });
  await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); await state.drain();
  const ask = requestId => state.send({ type: 'ASK_QUESTION', question: 'Where do copper terns migrate?', options: { requestId, useSearch: false, scopeUrls: [recallPage.url] } });
  await state.send({ type: 'GET_PROVIDERS' });
  assert.match((await ask('fresh')).error, /Chat is disabled.*Settings/i);
  assert.deepEqual(requests, [], 'Opening Models or submitting a stale Ask cannot probe a disabled chat provider');
  await state.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'ollama', queryRewrite: false, askRerank: false, enableTools: false } });
  hold = true;
  const pending = ask('held-chat');
  try {
    await waitFor(() => chatSignal, 'running chat request');
    await state.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'disabled' } });
    assert.equal(chatSignal.aborted, true);
    assert.match((await pending).error, /stopped|chat is disabled/i);
    const before = requests.length;
    assert.match((await ask('after-disable')).error, /Chat is disabled/i);
    assert.equal(requests.length, before);
  } finally { gate.resolve(); await pending; }
});

test('disabling chat revokes in-flight provider discovery and blocks stale tests and model lists', async testContext => {
  const requests = [], gate = deferred();
  let discoverySignal;
  const state = await recallFixture(testContext, { fetch: async (input, options = {}) => {
    const endpoint = pathOf(input);
    requests.push(endpoint);
    if (endpoint === '/') { discoverySignal = options.signal; await gate.promise; return new Response('ready'); }
    return Response.json({ models: [{ name: 'fixture-chat' }] });
  } });
  await state.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'ollama' } });
  const discovery = state.send({ type: 'GET_PROVIDERS' });
  try {
    await waitFor(() => discoverySignal, 'provider ping');
    await state.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'disabled' } });
    assert.equal(discoverySignal.aborted, true);
    gate.resolve();
    await discovery;
    assert.match((await state.send({ type: 'LIST_MODELS' })).error, /Chat is disabled/);
    assert.match((await state.send({ type: 'PROVIDER_ACTION', providerId: 'ollama', action: 'test' })).error, /Chat is disabled/);
    assert.deepEqual(requests, ['/'], 'A late successful ping must not trigger model listing or test inference');
  } finally { gate.resolve(); await discovery; }
});

test('chat disable prevents a multi-part summary from sending another section or replacing the saved page', async testContext => {
  const gate = deferred();
  let summarySignal, chatRequests = 0;
  const state = await recallFixture(testContext, { fetch: async (input, options = {}) => {
    const endpoint = pathOf(input);
    if (endpoint === '/api/tags') return Response.json({ models: [{ name: 'fixture-chat' }] });
    if (endpoint === '/api/ps') return Response.json({ models: [{ name: 'fixture-chat', context_length: 4096 }] });
    if (endpoint === '/api/chat') {
      chatRequests++; summarySignal = options.signal; await gate.promise;
      return Response.json({ message: { content: 'Notes from the section.' } });
    }
    throw Error(`Unexpected request ${endpoint}`);
  } });
  const text = 'The tide changed after the second shift. The walkway must stay clear for the morning inspection. '.repeat(55);
  state.setDocument({ ...recallPage, text, chunks: [text] });
  await state.send({ type: 'CAPTURE_ACTIVE_TAB' }); await state.drain();
  await state.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'ollama' } });
  const pending = state.send({ type: 'REGENERATE_PAGE_SUMMARY', url: recallPage.url, requestId: 'multi-part-summary' });
  try {
    await waitFor(() => summarySignal, 'first summary section');
    await state.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'disabled' } });
    assert.equal(summarySignal.aborted, true);
    gate.resolve();
    assert.match((await pending).error, /Chat is disabled/);
    assert.equal(chatRequests, 1);
    const saved = await state.db.getPageRecord(recallPage.url);
    assert.equal(saved.text, text);
    assert.equal(saved.summary, undefined);
  } finally { gate.resolve(); await pending; }
});

test('existing beta preferences never inherit stale legacy capture consent during the AI migration', async () => {
  const backend = providerFixture();
  backend.stored.betaSettings = { theme: 'dark' };
  Object.assign(backend.stored, { paused: false, whitelistDomains: ['legacy.test'], blacklistDomains: ['old.test'] });
  const source = await backend.load('src/background/settings/index.ts');
  const settings = await source.getSettings();
  assert.equal(settings.paused, true); assert.equal(settings.captureSetupComplete, false);
  assert.deepEqual(plain(settings.allowlist), []); assert.deepEqual(plain(settings.denylist), []);
  assert.equal(await source.shouldCaptureUrl('https://legacy.test/'), false);
  assert.equal(settings.theme, 'dark'); assert.equal(settings.automaticAi, true);
});

test('missing preferences after a completed migration do not revive retained legacy capture or automatic AI consent', async () => {
  const backend = providerFixture(); delete backend.stored.betaSettings;
  Object.assign(backend.stored, { betaSettingsSchema: 1, paused: false, whitelistDomains: ['legacy.test'] });
  const source = await backend.load('src/background/settings/index.ts');
  const settings = await source.getSettings();
  assert.equal(settings.paused, true); assert.equal(settings.automaticAi, false); assert.equal(settings.captureSetupComplete, false);
  assert.deepEqual(plain(settings.allowlist), []); assert.equal(await source.shouldCaptureUrl('https://legacy.test/'), false);
});

test('an off-on cycle removes pending automatic summaries without cancelling an explicit summary or reviving obsolete work', async testContext => {
  const backend = providerFixture(), db = await backend.load('src/shared/db/index.ts'); testContext.after(async () => (await db.openDatabase()).close());
  const first = { ...recallPage, chunks: [], summary: 'Old overview.', versionId: 'first' }, second = { ...first, url: 'https://recall.test/queued', versionId: 'second', summary: undefined };
  await db.savePageRecord(first); await db.savePageRecord(second);
  const gate = deferred(), entered = deferred(), requests = []; let enabled = true;
  const automatic = await loadSource('src/background/processing/automaticAi.ts', '', { '../settings/index': { getSettings: async () => ({ automaticAi: enabled }) } });
  const summary = await loadSource('src/background/summaries/index.ts', '', {
    '../processing/automaticAi': automatic, '../storage/manager': { storageManager: db },
    '../providers/chat': { getChatConfig: async () => ({ model: 'test' }), callChat: async (_config, request) => { requests.push(request); if (requests.length === 1) { entered.resolve(); await gate.promise; } return { message: { content: 'Completed overview.' } }; } }
  }, { chrome: { runtime: backend.runtime } });
  const explicit = summary.queuePageSummary(first.url, new AbortController().signal, true); await entered.promise;
  let queuedResult;
  const queued = summary.queuePageSummary(second.url).then(result => { queuedResult = result; return result; });
  try {
    enabled = false; automatic.stopAutomaticAi(); enabled = true; await tick();
    assert.equal(queuedResult, false, 'Disabling cancels queued automatic work without waiting for an unrelated explicit request');
  } finally { gate.resolve(); await Promise.all([explicit, queued]); }
  assert.equal(requests.length, 1); assert.equal((await db.getPageRecord(second.url)).summary, undefined);
  assert.equal((await db.getPageRecord(first.url)).summary, 'Completed overview.');
});

test('a cancelled automatic capture cannot resume persistence or queue a summary after AI is re-enabled', async testContext => {
  const backend = providerFixture(), db = await backend.load('src/shared/db/index.ts'); testContext.after(async () => (await db.openDatabase()).close());
  const page = { ...recallPage, manual: true, captureId: 'automatic-source' }, gate = deferred(), entered = deferred(), finished = deferred();
  await db.savePageRecord({ ...page, chunks: page.chunks.map(text => ({ text, embedding: [] })) }, { captureEntry: { url: page.url, title: page.title, status: 'processing', attempts: 0, createdAt: 1, updatedAt: 1, lastAttemptAt: 1, textSaved: true, payload: page } });
  const before = plain(await db.getPageRecord(page.url)); let enabled = true, summaries = 0;
  const automatic = await loadSource('src/background/processing/automaticAi.ts', '', { '../settings/index': { getSettings: async () => ({ automaticAi: enabled }) } });
  const processor = await loadSource('src/background/capture/processor.ts', '', {
    '../processing/automaticAi': automatic, '../storage/index': { whenStorageReady: async () => {} },
    '../storage/manager': { storageManager: { ...db, savePageRecord: async (...args) => { entered.resolve(); await gate.promise; try { return await db.savePageRecord(...args); } finally { finished.resolve(); } } } },
    '../embeddings/index': { getEmbeddingConfig: () => ({}), embedPayloadChunks: async () => [[1, 0]] },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }, '../summaries/index': { queuePageSummary: async () => { summaries++; return true; } }, '../../shared/logger/index': { log: async () => {} }
  }, { console: { ...console, info() {} } });
  const pending = processor.processCapturePayload(page); await entered.promise;
  try { enabled = false; automatic.stopAutomaticAi(); await pending; enabled = true; }
  finally { gate.resolve(); }
  await finished.promise; await tick();
  assert.equal(summaries, 0); assert.deepEqual(plain(await db.getPageRecord(page.url)), before);
});
