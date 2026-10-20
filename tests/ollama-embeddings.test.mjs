import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain } from './helpers.mjs';

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
async function fixture(fetch, context = {}) {
  return loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({}) }
  }, {
    chrome: { ...chromeFixture, runtime: { ...chromeFixture.runtime, getURL: path => `${origin}/${path}` } },
    console: { warn() {} }, fetch,
    setTimeout: callback => setTimeout(callback, 0), ...context
  });
}

test('Ollama 403 surfaces the extension origin fix without retrying each chunk', async () => {
  let attempts = 0;
  const mod = await fixture(async () => { attempts++; return new Response('', {status:403}); });
  await assert.rejects(mod.computeEmbeddingsForChunks(['first passage', 'second passage']), error => {
    assert.match(error.message, /403/);
    assert.match(error.message, /OLLAMA_ORIGINS/);
    assert.ok(error.message.includes(origin));
    return true;
  });
  assert.equal(attempts, 1);
});

test('missing Ollama model reports the server error without retrying', async () => {
  let attempts = 0;
  const mod = await fixture(async () => { attempts++; return Response.json({error:'model "missing" not found'}, {status:404}); });
  await assert.rejects(mod.computeEmbeddingsForChunks(['passage']), /model "missing" not found/);
  assert.equal(attempts, 1);
});

test('transient Ollama failures retry the batch and preserve the final error', async () => {
  const requests = [];
  const mod = await fixture(async (_url, options) => {
    requests.push(JSON.parse(options.body).input);
    return Response.json({error:'model runner unavailable'}, {status:503});
  });
  await assert.rejects(mod.computeEmbeddingsForChunks(['first', 'second']), /503.*model runner unavailable/);
  assert.deepEqual(requests, Array.from({length:3}, () => ['first', 'second']));
});

test('Ollama batch succeeds after a transient failure without losing vector order', async () => {
  let attempts = 0;
  const mod = await fixture(async () => ++attempts === 1
    ? Response.json({error:'busy'}, {status:503})
    : Response.json({embeddings:[[1, 2], [3, 4]]}));
  assert.deepEqual(plain(await mod.computeEmbeddingsForChunks(['first', 'second'])), [[1,2], [3,4]]);
  assert.equal(attempts, 2);
});

test('unreachable Ollama rejects instead of manufacturing empty vectors', async () => {
  let attempts = 0;
  const mod = await fixture(async () => { attempts++; throw new TypeError('Failed to fetch'); });
  await assert.rejects(mod.computeEmbeddingsForChunks(['first', 'second']), /Failed to fetch/);
  assert.equal(attempts, 3);
});

test('Ollama validates the full batch before returning embeddings', async () => {
  for (const embeddings of [[], [[1,2]], [[],[]], [[1,2],[3]], [[1,2],null], [[1,2],['bad',2]]]) {
    let attempts = 0;
    const mod = await fixture(async () => { attempts++; return Response.json({embeddings}); });
    await assert.rejects(mod.computeEmbeddingsForChunks(['first', 'second']), /incomplete|invalid/i);
    assert.equal(attempts, 1);
  }
});

test('backfill exposes the Ollama rejection and preserves saved vectors', async () => {
  const embeddings = await fixture(async () => new Response('', {status:403}));
  const page = {url:'https://example.test', title:'Article', updatedAt:123, chunks:[{text:'saved',embedding:[9,9]},{text:'missing',embedding:[]}]};
  const progress = []; let saves = 0;
  const mod = await loadSource('src/background/embeddings/backfill.ts', '', {
    './index': {getEmbeddingConfig:embeddings.getEmbeddingConfig, computeEmbeddingsForChunks:embeddings.computeEmbeddingsForChunks},
    '../storage/manager': {storageManager:{listAllPages:async () => [page], savePageRecord:async () => {saves++;}}},
    '../offscreen/index': {invalidateOffscreenIndex:async () => {}},
    '../../shared/logger/index': {log:async () => {}}
  }, {Error});
  const result = await mod.backfillMissingEmbeddings(1, false, [page.url], value => progress.push(value));
  assert.equal(result.failed, 1); assert.equal(result.updated, 0); assert.equal(saves, 0);
  assert.match(progress.at(-1).error, /403.*OLLAMA_ORIGINS/);
  assert.deepEqual(page.chunks[0].embedding, [9,9]);
});
