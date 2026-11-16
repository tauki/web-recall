import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, plain, tick } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';

async function nativeFixture(settings = {}) {
  const ports = [];
  const runtime = { connectNative(host) {
    const listeners = [], disconnected = [];
    const port = {
      host, messages: [], closed: false,
      postMessage(message) { port.messages.push(plain(message)); },
      disconnect() { port.closed = true; disconnected.forEach(listener => listener()); },
      onMessage: { addListener(listener) { listeners.push(listener); } },
      onDisconnect: { addListener(listener) { disconnected.push(listener); } },
      emit(event) { listeners.forEach(listener => listener({ id: port.messages[0].id, ...event })); }
    };
    ports.push(port); return port;
  } };
  const module = await loadSource('src/background/providers/apple.ts', '', { '../settings/index': { getSettings: async () => settings } }, { chrome: { runtime }, TextEncoder });
  return { module, ports, runtime };
}

test('Apple reads the helper capability rather than assuming a fixed context size', async () => {
  const { module, ports } = await nativeFixture();
  const pending = module.getAppleStatus();
  const status = { protocolVersion: 2, available: true, contextTokens: 8192, mode: 'on-device' };
  assert.equal(ports[0].host, 'com.webrecall.apple');
  ports[0].emit({ type: 'status', status });
  assert.deepEqual(plain(await pending), status);
  assert.equal(ports[0].closed, true, 'idle helpers must not keep the service worker alive');
});

test('native streaming forwards cumulative snapshots once and closes after completion', async () => {
  const { module, ports } = await nativeFixture();
  const chunks = [], progress = [];
  const pending = module.callApple({ action: 'generate', mode: 'on-device', cloudConsent: false, prompt: 'What is saved?' }, {
    onChunk: text => chunks.push(text), onProgress: text => progress.push(text)
  });
  ports[0].emit({ id: 'another-request', type: 'chunk', text: 'Unrelated content' });
  ports[0].emit({ type: 'chunk', text: 'Saved' });
  ports[0].emit({ type: 'progress', text: 'Finishing from saved evidence' });
  ports[0].emit({ type: 'chunk', text: 'Saved fact [2]' });
  ports[0].emit({ type: 'done', text: 'Saved fact [2]' });
  assert.equal(await pending, 'Saved fact [2]');
  assert.deepEqual(chunks, ['Saved', 'Saved fact [2]']);
  assert.deepEqual(progress, ['Finishing from saved evidence']);
  assert.equal(ports[0].closed, true);
});

test('Apple compaction forwards its requested output allowance rather than silently using the normal answer allowance', async () => {
  let request;
  const chat = await loadSource('src/background/providers/chat.ts', '', {
    './apple': { callApple: async value => { request = value; return 'Compact working state'; }, getAppleStatus: async () => ({}) },
    '../settings/index': { getSettings: async () => ({}), acknowledgeRemoteProviderOrigin: async () => assert.fail('On-device compaction does not contact a remote provider') }
  }, { chrome: { runtime: {}, storage: { onChanged: { addListener() {} } } } });
  const result = await chat.callChat({ providerId: 'apple', model: 'on-device' }, { messages: [{ role: 'system', content: 'Compact research context' }, { role: 'user', content: 'Earlier observations' }], options: { num_predict: 160 } });
  assert.equal(request.maxOutputTokens, 160);
  assert.equal(request.mode, 'on-device');
  assert.equal(result.message.content, 'Compact working state');
});

test('Stop cancels the native request and ignores late chunks and completion', async () => {
  const { module, ports } = await nativeFixture();
  const controller = new AbortController(), chunks = [];
  const pending = module.callApple({ action: 'generate', mode: 'on-device', cloudConsent: false, prompt: 'Read saved evidence' }, { signal: controller.signal, onChunk: text => chunks.push(text) });
  ports[0].emit({ type: 'chunk', text: 'Partial' }); controller.abort();
  await assert.rejects(pending, /stopped/);
  assert.deepEqual(ports[0].messages.at(-1), { id: ports[0].messages[0].id, action: 'cancel' });
  assert.equal(ports[0].closed, true);
  ports[0].emit({ type: 'chunk', text: 'Late answer' }); ports[0].emit({ type: 'done', text: 'Late answer' });
  assert.deepEqual(chunks, ['Partial']);
});

test('Apple guardrail failures are identified without retrying or accepting late output', async () => {
  const { module, ports } = await nativeFixture();
  for (const text of ['Response may contain sensitive or unsafe content.', 'Prompt may contain sensitive or unsafe content.', 'FoundationModels.LanguageModelSession.GenerationError.guardrailViolation(context: blocked)']) {
    const chunks = [];
    const pending = module.callApple({ action: 'generate', mode: 'on-device', cloudConsent: false, prompt: 'A question' }, { onChunk: text => chunks.push(text) });
    const port = ports.at(-1);
    port.emit({ type: 'error', text });
    await assert.rejects(pending, error => error.code === 'apple_safety_block' && /Apple.*blocked.*safety/i.test(error.message));
    port.emit({ type: 'chunk', text: 'Unverified late output' });
    assert.deepEqual(chunks, []);
    assert.equal(port.closed, true);
    assert.equal(port.messages.length, 1, 'A safety block must not trigger another attempt');
  }
  assert.equal(ports.length, 3);
});

test('ordinary Apple errors and cancelled events are not labelled as safety blocks', async () => {
  const { module, ports } = await nativeFixture();
  for (const event of [{ type: 'error', text: 'Model unavailable' }, { type: 'error', text: 'Unsafe native connection configuration' }, { type: 'cancelled', text: 'Answer stopped' }]) {
    const pending = module.callApple({ action: 'generate', mode: 'on-device', cloudConsent: false, prompt: 'A question' });
    ports.at(-1).emit(event);
    await assert.rejects(pending, error => error.code === undefined && error.message === event.text);
  }
});

test('native tool requests execute the browser-owned handler and reply only to the matching invocation', async () => {
  const { module, ports } = await nativeFixture();
  const calls = [];
  const pending = module.callApple({ action: 'generate', mode: 'on-device', cloudConsent: false, prompt: 'Find a saved fact', tools: [{ name: 'search_memory', description: 'Search saved memory', parameters: { type: 'object', properties: { query: { type: 'string' } } } }] }, {
    onToolCall: async (name, args, callId) => { calls.push({ name, args, callId }); return { content: '{"ok":true,"data":[{"sourceIndex":7,"snippet":"A saved fact"}]}' }; }
  });
  ports[0].emit({ id: 'foreign-run', type: 'tool_call', toolCall: { callId: 'foreign', name: 'search_memory', arguments: '{"query":"secret"}' } });
  ports[0].emit({ type: 'tool_call', toolCall: { callId: 'read-7', name: 'search_memory', arguments: '{"query":"saved fact"}' } });
  await tick();
  assert.deepEqual(plain(calls), [{ name: 'search_memory', args: { query: 'saved fact' }, callId: 'read-7' }]);
  assert.equal(ports[0].messages.at(-1).action, 'tool_result');
  assert.equal(ports[0].messages.at(-1).callId, 'read-7');
  ports[0].emit({ type: 'done', text: 'A saved fact [7]' });
  assert.equal(await pending, 'A saved fact [7]');
});

test('Stop prevents an in-flight native tool result from being delivered after cancellation', async () => {
  const { module, ports } = await nativeFixture();
  const controller = new AbortController(); let release;
  const pending = module.callApple({ action: 'generate', mode: 'on-device', cloudConsent: false, prompt: 'Find a fact', tools: [{ name: 'search_memory', description: 'Search', parameters: { type: 'object', properties: {} } }] }, { signal: controller.signal, onToolCall: async () => new Promise(resolve => { release = resolve; }) });
  ports[0].emit({ type: 'tool_call', toolCall: { callId: 'pending', name: 'search_memory', arguments: '{}' } });
  controller.abort(); await assert.rejects(pending, /stopped/);
  release({ content: '{"ok":true,"data":[]}' }); await tick();
  assert.equal(ports[0].messages.filter(message => message.action === 'tool_result').length, 0);
});

test('Stop also cancels the capability check before Apple generation starts', async () => {
  const fixture = await nativeFixture();
  const chat = await loadSource('src/background/providers/chat.ts', '', {
    './apple': fixture.module,
    './access': { assertProviderOriginAcknowledged: () => assert.fail('Apple must not authorize an HTTP endpoint'), fetchProvider: () => assert.fail('Apple must not contact an HTTP endpoint') },
    '../settings/index': { getSettings: async () => ({ activeProviderId: 'apple', applePrivateCloud: false }) },
    './config': { getProviderBaseUrl: async () => assert.fail('Apple must not resolve an HTTP endpoint') }
  }, { chrome: { runtime: {} } });
  const controller = new AbortController();
  const pending = chat.getChatConfig(controller.signal);
  await tick();
  assert.equal(fixture.ports[0].messages[0].action, 'status');
  controller.abort(); await assert.rejects(pending, /stopped/);
  assert.equal(fixture.ports[0].closed, true);
});

test('missing helpers and incompatible protocols fail explicitly without another provider', async () => {
  const { module, ports } = await nativeFixture();
  const missing = module.getAppleStatus(); ports[0].disconnect();
  await assert.rejects(missing, /disconnected/);
  const incompatible = module.getAppleStatus();
  ports[1].emit({ type: 'status', status: { protocolVersion: 1, available: true, contextTokens: 8192, mode: 'on-device' } });
  await assert.rejects(incompatible, /unsupported protocol.*Update and restart.*companion/);
  assert.equal(ports.length, 2);
});

test('an unregistered or forbidden native host gives setup guidance for this extension without a fallback', async () => {
  const { module, ports, runtime } = await nativeFixture();
  runtime.id = 'abcdefghijklmnopabcdefghijklmnop';
  for (const message of ['Specified native messaging host not found.', 'Access to the specified native messaging host is forbidden.']) {
    const pending = module.getAppleStatus();
    runtime.lastError = { message };
    ports.at(-1).disconnect();
    await assert.rejects(pending, error => /register/i.test(error.message) && error.message.includes(runtime.id));
    assert.equal(ports.at(-1).closed, true);
  }
  assert.equal(ports.length, 2);
});

test('Private Cloud Compute cannot start without explicit consent', async () => {
  const { module, ports } = await nativeFixture();
  await assert.rejects(module.getAppleStatus('private-cloud', false), /explicit consent/);
  assert.equal(ports.length, 0);
});

test('revoking cloud consent blocks later dispatch even when a request retains the earlier grant', async () => {
  const settings = { applePrivateCloud: true };
  const { module, ports } = await nativeFixture(settings);
  const status = module.getAppleStatus('private-cloud', true);
  await tick();
  ports[0].emit({ type: 'status', status: { protocolVersion: 2, available: true, contextTokens: 8192, mode: 'private-cloud' } });
  await status;
  settings.applePrivateCloud = false;
  await assert.rejects(module.callApple({ action: 'generate', mode: 'private-cloud', cloudConsent: true, prompt: 'Private saved evidence' }), /consent was revoked/);
  assert.equal(ports.length, 1, 'revoked cloud requests must not start a helper or fall back to another mode');
});

test('oversized UTF-8 requests fail before starting a native host', async () => {
  const { module, ports } = await nativeFixture();
  await assert.rejects(module.callApple({ action: 'generate', mode: 'on-device', cloudConsent: false, prompt: 'é'.repeat(3 * 1024 * 1024) }), /Choose fewer pages/);
  assert.equal(ports.length, 0);
});

test('webpage senders and generic settings writes cannot enable Private Cloud Compute', async () => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const request = { type: 'SET_APPLE_CLOUD', enabled: true, acknowledgeCloud: true };
  const rejected = await backend.send(request, { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', url: 'https://untrusted.test/' });
  assert.match(rejected.error, /Only Web Recall/);
  assert.notEqual(backend.stored.betaSettings.applePrivateCloud, true);
  await backend.send({ type: 'SET_SETTINGS', payload: { applePrivateCloud: true } });
  assert.equal(backend.stored.betaSettings.applePrivateCloud, false);
  const noConsent = await backend.send({ ...request, acknowledgeCloud: false });
  assert.match(noConsent.error, /acknowledgement/);
  await backend.send(request);
  assert.equal(backend.stored.betaSettings.applePrivateCloud, true);
  await backend.send({ type: 'SET_APPLE_CLOUD', enabled: false });
  assert.equal(backend.stored.betaSettings.applePrivateCloud, false);
  assert.ok(!backend.requests.some(request => new URL(request.url).hostname !== 'localhost'));
  await tick();
});

test('listing the Apple provider does not probe inactive Ollama or start inference', async () => {
  const backend = providerFixture('http://localhost:11434');
  backend.stored.betaSettings.activeProviderId = 'apple';
  await backend.connect();
  const response = await backend.send({ type: 'GET_PROVIDERS' });
  assert.ok(response.providers.some(provider => provider.id === 'apple'));
  assert.equal(backend.requests.length, 0);
});

test('the model-setting action rejects retired summary-model writes without changing stored choices', async () => {
  const backend = providerFixture('http://localhost:11434');
  backend.stored.betaModelSettings = { chatModel: 'chosen-model', summaryModel: 'retained-legacy-choice' };
  await backend.connect();
  const response = await backend.send({ type: 'SET_MODEL', key: 'summaryModel', value: 'must-not-save' });
  assert.match(response.error, /chat model/i);
  assert.deepEqual(backend.stored.betaModelSettings, { chatModel: 'chosen-model', summaryModel: 'retained-legacy-choice' });
  assert.equal(backend.requests.length, 0);
});
