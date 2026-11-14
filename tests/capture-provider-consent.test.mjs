import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';
import { createServer } from 'node:http';

test('revoking embedding consent during backoff stops before a second POST', async () => {
  const origin = 'https://embeddings.example.test';
  const fixture = providerFixture(origin, [origin]);
  fixture.stored.embeddingConfig = { provider: 'ollama', baseUrl: origin, model: 'embed-model' };
  let attempts = 0, backoffs = 0;
  const embeddings = await fixture.load('src/background/embeddings/index.ts', {
    fetch: async () => { attempts++; return Response.json({ error: 'busy' }, { status: 503 }); },
    setTimeout(callback) {
      backoffs++;
      fixture.stored.betaSettings.acknowledgedRemoteProviderOrigins = [];
      queueMicrotask(callback);
    }, console: { warn() {} }
  });
  embeddings.configureEmbeddings();
  await assert.rejects(embeddings.computeEmbeddingsForChunks(['Private captured text']), /acknowledg/i);
  assert.equal(attempts, 1);
  assert.equal(backoffs, 1);
});

test('concurrent partial configuration saves retain independent changes and recover after storage failure', async () => {
  const fixture = providerFixture('http://localhost:11434');
  const embeddings = await fixture.load('src/background/embeddings/index.ts');
  await Promise.all([
    embeddings.updateEmbeddingConfig({ model: 'new-model' }),
    embeddings.updateEmbeddingConfig({ baseUrl: 'http://127.0.0.1:11434' })
  ]);
  assert.equal(fixture.stored.embeddingConfig.model, 'new-model');
  assert.equal(fixture.stored.embeddingConfig.baseUrl, 'http://127.0.0.1:11434');
  fixture.failNextWrite('embeddingConfig');
  await assert.rejects(embeddings.updateEmbeddingConfig({ model: 'failed-model' }), /Storage write failed/);
  await embeddings.updateEmbeddingConfig({ baseUrl: 'http://localhost:1234' });
  assert.equal(embeddings.getEmbeddingConfig().model, 'new-model');
  assert.equal(fixture.stored.embeddingConfig.model, 'new-model');
  const config = await fixture.load('src/background/providers/config.ts');
  await Promise.all([
    config.updateProviderSettings('ollama', { baseUrl: 'http://localhost:1234' }),
    config.updateProviderSettings('vllm', { baseUrl: 'http://localhost:8000' })
  ]);
  assert.equal(fixture.stored.betaProviderSettings.ollama.baseUrl, 'http://localhost:1234');
  assert.equal(fixture.stored.betaProviderSettings.vllm.baseUrl, 'http://localhost:8000');
  fixture.failNextWrite('betaProviderSettings');
  await assert.rejects(config.updateProviderSettings('ollama', { baseUrl: 'http://localhost:9999' }), /Storage write failed/);
  assert.equal(await config.getProviderBaseUrl('ollama'), 'http://localhost:1234');
});

test('provider HTTP operations reject redirects without forwarding bodies and direct endpoints still work', async t => {
  let redirectStatus = 307;
  let redirectLocation = '/leak';
  const leaked = [], posted = [];
  const destination = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    leaked.push({ method: request.method, body });
    response.end('{}');
  });
  await new Promise((resolve, reject) => { destination.once('error', reject); destination.listen(0, '127.0.0.1', resolve); });
  t.after(() => { destination.closeAllConnections(); return new Promise(resolve => destination.close(resolve)); });
  const otherOrigin = `http://127.0.0.1:${destination.address().port}`;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    if (request.url === '/leak') { leaked.push(body); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ message: { content: 'Leaked reply' }, embeddings: [[1, 0]] })); return; }
    if (body) posted.push(JSON.parse(body));
    if (redirectStatus) { response.writeHead(redirectStatus, { Location: redirectLocation }); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/embed' ? { embeddings: [[1, 0]] } : request.url === '/api/tags' ? { models: [{ name: 'direct-model' }] } : { message: { content: 'Direct reply' } }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const fixture = providerFixture(baseUrl);
  const chat = await fixture.load('src/background/providers/chat.ts', { fetch });
  const models = await fixture.load('src/background/providers/ollamaModels.ts', { fetch, console: { warn() {} } });
  const provider = await fixture.load('src/background/providers/ollama.ts', { fetch });
  const embeddings = await fixture.load('src/background/embeddings/index.ts', { fetch });
  await embeddings.updateEmbeddingConfig({ baseUrl });
  const config = { providerId: 'ollama', baseUrl, model: 'test-model' };
  const body = { model: 'test-model', messages: [{ role: 'user', content: 'Private fixture passage' }] };
  for (const [status, location] of [[307, '/leak'], [308, `${otherOrigin}/leak`]]) {
    redirectStatus = status;
    redirectLocation = location;
    await assert.rejects(chat.callChat(config, body), /redirect/i);
    await assert.rejects(chat.streamChat(config, body, () => assert.fail('Redirects must not stream')), /redirect/i);
    assert.equal((await chat.probeChat(config)).ok, false);
    assert.equal((await provider.getOllamaStatus(baseUrl)).online, false);
    assert.deepEqual(plain(await models.listOllamaModels(baseUrl)), []);
    await assert.rejects(embeddings.computeEmbeddingsForChunks(['Private fixture passage']), /redirect/i);
  }
  assert.deepEqual(leaked, []);
  assert.equal(posted.length, 8, 'Each POST operation must stop at its first redirect, without embedding retries');
  redirectStatus = 0;
  assert.equal((await chat.callChat(config, body)).message.content, 'Direct reply');
  const chunks = [];
  assert.equal(await chat.streamChat(config, body, text => chunks.push(text)), 'Direct reply');
  assert.deepEqual(chunks, ['Direct reply']);
  assert.equal((await chat.probeChat(config)).ok, true);
  assert.equal((await provider.getOllamaStatus(baseUrl)).online, true);
  assert.deepEqual(plain(await models.listOllamaModels(baseUrl)), ['direct-model']);
  assert.deepEqual(plain(await embeddings.computeEmbeddingsForChunks(['Private fixture passage'])), [[1, 0]]);
  const browserChat = await fixture.load('src/background/providers/chat.ts', { fetch: async () => ({ type: 'opaqueredirect', status: 0, body: null }) });
  await assert.rejects(browserChat.callChat(config, body), /Provider redirects are not allowed/);
});

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
