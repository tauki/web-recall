import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';

test('saved unacknowledged remote providers remain readable with no network requests', async () => {
  const fixture = providerFixture();
  const config = await fixture.load('src/background/providers/config.ts');
  assert.equal(await config.getProviderBaseUrl('ollama'), 'https://models.example.test');
  const provider = await fixture.load('src/background/providers/ollama.ts');
  const description = await provider.describeOllamaProvider();
  assert.equal(description.settings.find(setting => setting.key === 'baseUrl').value, 'https://models.example.test');
  assert.equal(description.status.online, false);
  assert.match(description.status.lastError, /acknowledg/i);
  assert.deepEqual(plain(description.models), []);
  assert.equal(fixture.requests.length, 0);
});

test('remote saves require explicit consent and retain existing consent and capture settings', async () => {
  const fixture = providerFixture('http://localhost:11434', ['https://previous.example.test']);
  const config = await fixture.load('src/background/providers/config.ts');
  await assert.rejects(config.updateProviderSettings('ollama', { baseUrl: 'https://models.example.test' }), /acknowledg/i);
  assert.equal(await config.getProviderBaseUrl('ollama'), 'http://localhost:11434');
  await config.updateProviderSettings('ollama', { baseUrl: 'https://models.example.test/path/' }, { acknowledgeRemoteOrigin: true });
  assert.equal(await config.getProviderBaseUrl('ollama'), 'https://models.example.test/path');
  assert.deepEqual(new Set(fixture.stored.betaSettings.acknowledgedRemoteProviderOrigins), new Set(['https://previous.example.test', 'https://models.example.test']));
  assert.equal(fixture.stored.betaSettings.paused, true);
  const provider = await fixture.load('src/background/providers/ollama.ts');
  assert.equal((await provider.describeOllamaProvider()).status.online, true);
  assert.ok(fixture.requests.length > 0, 'An approved provider should be contacted');
  for (const request of fixture.requests) {
    assert.ok(request.acknowledged.includes(new URL(request.url).origin), 'Consent must be persisted before the first provider request');
  }
});

test('approved chat and streaming send the selected model and conversation to the configured endpoint', async () => {
  const fixture = providerFixture('https://models.example.test/custom', ['https://models.example.test']);
  const chat = await fixture.load('src/background/providers/chat.ts');
  const config = await chat.getChatConfig();
  const messages = [{ role: 'user', content: 'Explain the captured article.' }];
  const answer = await chat.callChat(config, { model: config.model, messages, stream: false });
  assert.equal(answer.message.content, 'A sourced answer.');
  const updates = [];
  assert.equal(await chat.streamChat(config, { model: config.model, messages }, text => updates.push(text)), 'A sourced answer.');
  assert.equal(updates.at(-1), 'A sourced answer.');
  const calls = fixture.requests.filter(request => request.method === 'POST');
  assert.equal(calls.length, 2);
  for (const request of calls) {
    assert.equal(request.url, 'https://models.example.test/custom/api/chat');
    assert.equal(request.body.model, 'chosen-model');
    assert.deepEqual(request.body.messages, messages);
  }
  assert.equal(calls.find(request => request.body.stream === true)?.url, 'https://models.example.test/custom/api/chat');
});

test('chat, streaming, probes and model overrides cannot bypass remote consent', async () => {
  const fixture = providerFixture();
  const chat = await fixture.load('src/background/providers/chat.ts');
  const config = { providerId: 'ollama', baseUrl: 'https://models.example.test', model: 'chosen-model' };
  await assert.rejects(chat.getChatConfig(), /acknowledg/i);
  await assert.rejects(chat.callChat(config, {}), /acknowledg/i);
  await assert.rejects(chat.streamChat(config, {}, () => {}), /acknowledg/i);
  assert.match((await chat.probeChat(config)).lastError, /acknowledg/i);
  const provider = await fixture.load('src/background/providers/ollama.ts');
  assert.equal((await provider.getOllamaStatus('https://other.example.test', true)).online, false);
  const models = await fixture.load('src/background/providers/ollamaModels.ts');
  assert.deepEqual(plain(await models.listOllamaModels('https://other.example.test')), []);
  assert.equal(fixture.requests.length, 0);
});

test('loopback remains usable without consent and remote consent can be revoked', async () => {
  const fixture = providerFixture('http://localhost:11434', ['https://models.example.test']);
  const chat = await fixture.load('src/background/providers/chat.ts');
  for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434', 'https://models.example.test']) {
    await chat.callChat({ providerId: 'ollama', baseUrl, model: 'chosen-model' }, { model: 'chosen-model', messages: [{ role: 'user', content: 'A local question' }] });
    const request = fixture.requests.at(-1);
    assert.equal(request.url, `${baseUrl}/api/chat`);
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body.messages, [{ role: 'user', content: 'A local question' }]);
  }
  assert.equal(fixture.requests.length, 4);
  fixture.stored.betaSettings.acknowledgedRemoteProviderOrigins = [];
  await assert.rejects(chat.callChat({ providerId: 'ollama', baseUrl: 'https://models.example.test', model: 'chosen-model' }, {}), /acknowledg/i);
  assert.equal(fixture.requests.length, 4);
});

test('concurrent acknowledgements preserve other origins and settings updates', async () => {
  const fixture = providerFixture();
  const settings = await fixture.load('src/background/settings/index.ts');
  await Promise.all([
    settings.acknowledgeRemoteProviderOrigin('https://first.example.test'),
    settings.updateSettings({ theme: 'dark' }),
    settings.acknowledgeRemoteProviderOrigin('https://second.example.test')
  ]);
  assert.deepEqual(new Set(fixture.stored.betaSettings.acknowledgedRemoteProviderOrigins), new Set(['https://first.example.test', 'https://second.example.test']));
  assert.equal(fixture.stored.betaSettings.theme, 'dark');
  assert.equal(fixture.stored.betaSettings.paused, true);
});

test('cancelling before consent checks complete never starts a chat request', async () => {
  const fixture = providerFixture();
  const chat = await fixture.load('src/background/providers/chat.ts');
  const controller = new AbortController();
  controller.abort(Error('User stopped'));
  for (const baseUrl of ['http://localhost:11434', 'https://models.example.test']) {
    fixture.stored.betaSettings.acknowledgedRemoteProviderOrigins = ['https://models.example.test'];
    await assert.rejects(chat.callChat({ baseUrl, signal: controller.signal }, {}), /User stopped/);
    await assert.rejects(chat.streamChat({ baseUrl, signal: controller.signal }, {}, () => {}), /User stopped/);
  }
  assert.equal(fixture.requests.length, 0);
});

test('non-HTTP URLs cannot be saved or used as providers', async () => {
  const fixture = providerFixture('http://localhost:11434');
  const config = await fixture.load('src/background/providers/config.ts');
  const chat = await fixture.load('src/background/providers/chat.ts');
  for (const baseUrl of ['not-a-url', 'file:///tmp/model', 'ftp://models.example.test']) {
    await assert.rejects(config.updateProviderSettings('ollama', { baseUrl }, { acknowledgeRemoteOrigin: true }), /HTTP or HTTPS/);
    await assert.rejects(chat.callChat({ providerId: 'ollama', baseUrl, model: 'test' }, {}), /HTTP or HTTPS/);
  }
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.stored.betaSettings.acknowledgedRemoteProviderOrigins, []);
});

test('provider save messages persist consent before probes and return updated Settings', async () => {
  const fixture = providerFixture('http://localhost:11434');
  await fixture.connect();
  const request = { type: 'SET_PROVIDER_SETTING', providerId: 'ollama', key: 'baseUrl', value: 'https://models.example.test' };
  const rejected = await fixture.send({ ...request, acknowledgeRemoteOrigin: 'true' });
  assert.match(rejected.error, /acknowledg/i);
  assert.equal(fixture.requests.length, 0);
  const accepted = await fixture.send({ ...request, acknowledgeRemoteOrigin: true });
  assert.equal(accepted.error, undefined);
  assert.deepEqual(plain(accepted.settings.acknowledgedRemoteProviderOrigins), ['https://models.example.test']);
  const provider = accepted.providers.find(provider => provider.id === 'ollama');
  assert.equal(provider.settings.find(setting => setting.key === 'baseUrl').value, request.value);
  assert.equal(provider.status.online, true);
  assert.ok(fixture.requests.length > 0);
  for (const sent of fixture.requests) {
    assert.ok(sent.acknowledged.includes(new URL(sent.url).origin), 'Every provider request requires previously persisted consent');
  }
});

test('embedding save messages carry consent and return the saved endpoint and Settings', async () => {
  const fixture = providerFixture('http://localhost:11434');
  await fixture.connect();
  const request = { type: 'SET_EMBEDDING_CONFIG', payload: { baseUrl: 'https://embeddings.example.test', provider: 'ollama' } };
  assert.match((await fixture.send(request)).error, /acknowledg/i);
  const accepted = await fixture.send({ ...request, acknowledgeRemoteOrigin: true });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.config.baseUrl, request.payload.baseUrl);
  assert.deepEqual(plain(accepted.settings.acknowledgedRemoteProviderOrigins), ['https://embeddings.example.test']);
  assert.equal(fixture.requests.length, 0);
});

test('remote embedding settings and stored embedding endpoints require acknowledgement', async () => {
  const fixture = providerFixture();
  fixture.stored.embeddingConfig = { baseUrl: 'https://models.example.test', model: 'embed-model', provider: 'ollama' };
  const embeddings = await fixture.load('src/background/embeddings/index.ts');
  embeddings.configureEmbeddings();
  await assert.rejects(embeddings.computeEmbeddingsForChunks(['saved text']), /acknowledg/i);
  await assert.rejects(embeddings.updateEmbeddingConfig({ baseUrl: 'https://models.example.test' }), /acknowledg/i);
  assert.equal(fixture.requests.length, 0);
  await embeddings.updateEmbeddingConfig({ baseUrl: 'https://models.example.test' }, { acknowledgeRemoteOrigin: true });
  assert.deepEqual(plain(await embeddings.computeEmbeddingsForChunks(['saved text'])), [[0.25, 0.75]]);
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests.at(-1);
  assert.equal(request.url, 'https://models.example.test/api/embed');
  assert.equal(request.method, 'POST');
  assert.equal(request.body.model, 'embed-model');
  assert.equal(request.body.input.length, 1);
  assert.ok(request.body.input[0].includes('saved text'), 'The embedding request must include the captured text');
});
