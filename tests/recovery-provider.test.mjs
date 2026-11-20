import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRecoveryProvider } from '../scripts/lib/recovery-provider.mjs';
import { waitFor } from './helpers.mjs';

async function fixture(testContext) {
  const provider = createRecoveryProvider();
  const server = createServer((request, response) => { void provider.handle(request, response, 'independent-test'); });
  testContext.after(async () => { provider.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const embed = (input = ['First section.', 'Last section.'], options = {}) => fetch(`${origin}/api/embed`, { method: 'POST', body: JSON.stringify({ model: 'qualification-vector', input }), ...options });
  return { provider, embed, origin };
}

test('controlled provider holds a completed request until release, then returns one finite vector per authored section', async testContext => {
  const { provider, embed } = await fixture(testContext);
  provider.setMode('hold');
  let delivered = false;
  const response = embed().then(result => { delivered = true; return result; });
  await waitFor(() => provider.requests[0]?.state === 'held', 'request body received by the fixture');
  assert.equal(delivered, false);
  assert.deepEqual(provider.requests[0].body.input, ['First section.', 'Last section.']);
  provider.release();
  assert.deepEqual(await (await response).json(), { embeddings: [[1, 2], [2, 3]] });
  assert.equal(provider.requests[0].state, 'completed');
});

test('fixture exposes a disconnected held request and cannot complete it as a successful late response', async testContext => {
  const { provider, embed } = await fixture(testContext);
  provider.setMode('hold');
  const controller = new AbortController();
  const response = embed(undefined, { signal: controller.signal });
  await waitFor(() => provider.requests[0]?.state === 'held', 'held request');
  controller.abort();
  await assert.rejects(response, { name: 'AbortError' });
  await waitFor(() => provider.requests[0].state === 'disconnected', 'request cancellation reaching the server');
  provider.release();
  assert.equal(provider.requests[0].state, 'disconnected');
});

test('provider failure is an actual unsuccessful HTTP response, and later explicit requests can recover', async testContext => {
  const { provider, embed } = await fixture(testContext);
  provider.setMode('fail');
  const failed = await embed();
  assert.equal(failed.status, 404);
  assert.deepEqual(await failed.json(), { error: 'Qualification embedding model is unavailable' });
  assert.equal(provider.requests[0].state, 'failed');
  provider.setMode('ready');
  const recovered = await embed(['New explicit attempt.']);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { embeddings: [[1, 2]] });
  assert.equal(provider.requests.length, 2);
});

test('unexpected model requests fail instead of silently returning plausible vectors', async testContext => {
  const { provider, embed, origin } = await fixture(testContext);
  for (const input of [[], 'Not an input array', [null]]) assert.equal((await embed(input)).status, 400);
  const wrongModel = await fetch(`${origin}/api/embed`, { method: 'POST', body: JSON.stringify({ model: 'unrecognized', input: ['Text'] }) });
  assert.equal(wrongModel.status, 400);
  assert.ok(provider.requests.every(request => request.state === 'invalid'));
  assert.throws(() => provider.setMode('unknown'), /Unknown qualification/);
});
