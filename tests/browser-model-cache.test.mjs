import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, plain } from './helpers.mjs';

function cacheFixture() {
  const files = new Map(), other = new Map();
  const cache = {
    keys: async () => [...files.keys()].map(url => new Request(url)),
    match: async request => files.get(request.url),
    delete: async request => files.delete(request.url)
  };
  const caches = { has: async name => name === 'transformers-cache', open: async name => { assert.equal(name, 'transformers-cache'); return cache; } };
  const put = (model, revision, file, size = 100) => {
    const url = `https://huggingface.co/${model}/resolve/${encodeURIComponent(revision)}/${file}`;
    files.set(url, new Response(null, { headers: size === null ? {} : { 'content-length': String(size) } }));
    return url;
  };
  return { files, other, caches, put };
}

test('model inventory discovers existing cached revisions without reading large bodies or creating caches', async () => {
  const f = cacheFixture();
  f.put('org/model', 'pinned', 'config.json', 100);
  f.put('org/model', 'pinned', 'onnx/model_quantized.onnx', 1200);
  f.put('org/model', 'other', 'tokenizer.json', null);
  f.files.set('https://extension.test/ort.wasm', new Response());
  const mod = await loadSource('src/offscreen/modelCache.ts', '', {}, { caches: f.caches });
  const models = plain(await mod.listBrowserModelDownloads());
  assert.deepEqual(models, [
    { model: 'org/model', revision: 'other', fileCount: 1, sizeBytes: null, hasWeights: false },
    { model: 'org/model', revision: 'pinned', fileCount: 2, sizeBytes: 1300, hasWeights: true }
  ]);
  const empty = await loadSource('src/offscreen/modelCache.ts', '', {}, { caches: { has: async () => false, open: async () => assert.fail('Listing must not create a cache') } });
  assert.deepEqual(plain(await empty.listBrowserModelDownloads()), []);
});

test('removal deletes only the exact model revision and leaves runtime assets, other models and revisions', async () => {
  const f = cacheFixture();
  const removed = f.put('org/model', 'release/one', 'onnx/model.onnx');
  const retained = [f.put('org/model', 'release/two', 'config.json'), f.put('org/model-extra', 'release/one', 'onnx/model.onnx'), f.put('org/another', 'main', 'config.json')];
  f.files.set('https://extension.test/ort.wasm', new Response());
  const mod = await loadSource('src/offscreen/modelCache.ts', '', {}, { caches: f.caches });
  assert.equal(await mod.removeBrowserModelFiles('org/model', 'release/one'), 1);
  assert.equal(f.files.has(removed), false);
  for (const url of retained) assert.ok(f.files.has(url));
  assert.ok(f.files.has('https://extension.test/ort.wasm'));
  assert.equal(await mod.removeBrowserModelFiles('org/model', 'release/one'), 0);
  await assert.rejects(mod.removeBrowserModelFiles('', ''), /Choose a downloaded/);
});

test('unavailable cache storage reports a failure rather than an empty model inventory', async () => {
  const unavailable = await loadSource('src/offscreen/modelCache.ts');
  await assert.rejects(unavailable.listBrowserModelDownloads(), /storage is unavailable/);
  const denied = await loadSource('src/offscreen/modelCache.ts', '', {}, { caches: { has: async () => { throw Error('Storage denied'); } } });
  await assert.rejects(denied.listBrowserModelDownloads(), /Storage denied/);
});
