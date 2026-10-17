import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain, tick } from './helpers.mjs';

const OLD_MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
const OLD_REVISION = '75a84c732f1884df76bec365346230e32f582c82';
const NEW_MODEL = 'onnx-community/embeddinggemma-2-ONNX';
const NEW_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0';

test('both model presets are pinned and existing embeddings keep their original identity', async () => {
  const { BROWSER_EMBEDDING_MODELS, DEFAULT_EMBEDDING_CONFIG, embeddingSpaceKey } = await loadSource('src/shared/config/index.ts');
  assert.equal(DEFAULT_EMBEDDING_CONFIG.browserModel, OLD_MODEL);
  assert.equal(DEFAULT_EMBEDDING_CONFIG.browserRevision, OLD_REVISION);
  assert.equal(BROWSER_EMBEDDING_MODELS.find(m => m.id === NEW_MODEL).revision, NEW_REVISION);
  const config = { ...DEFAULT_EMBEDDING_CONFIG, provider: 'browser' };
  assert.equal(embeddingSpaceKey(config), JSON.stringify(['browser', OLD_MODEL, OLD_REVISION, 'q8', 'embeddinggemma-prefix-v1']));
  assert.notEqual(embeddingSpaceKey(config), embeddingSpaceKey({ ...config, browserModel: NEW_MODEL, browserRevision: NEW_REVISION }));
});

test('a previous model download cannot mark the newly selected model ready', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => message.type === 'OFFSCREEN_EMBED' ? pending : { runtimeAvailable: true } }
  }, { chrome: chromeFixture });
  await mod.updateEmbeddingConfig({ provider: 'browser' });
  const first = mod.computeEmbeddingsForQueries(['test']);
  await tick();
  await mod.updateEmbeddingConfig({ browserModel: NEW_MODEL, browserRevision: NEW_REVISION });
  finish({ embeddings: [[1, 2]] });
  await assert.rejects(first, /settings changed/);
  assert.equal(mod.getBrowserEmbedStatus().model, NEW_MODEL);
  assert.equal(mod.getBrowserEmbedStatus().ready, false);
  assert.equal(mod.getBrowserEmbedStatus().state, 'idle');
});

test('switching models releases the previous session only after its inference finishes', async () => {
  const events = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const mod = await loadSource('src/offscreen/index.ts', 'computeBrowserEmbeddings', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    '@huggingface/transformers': {
      env: { backends: { onnx: { wasm: {} } } },
      AutoConfig: { from_pretrained: async () => ({ vision_config: {}, audio_config: {} }) },
      AutoTokenizer: { from_pretrained: async () => () => ({}) },
      AutoModel: { from_pretrained: async id => {
        events.push(`load:${id}`);
        const model = async () => { events.push(`infer:${id}`); if (id === OLD_MODEL) await pending; return { sentence_embedding: [[1, 2]] }; };
        model.dispose = async () => { events.push(`dispose:${id}`); };
        return model;
      } }
    }
  }, { chrome: chromeFixture });
  const first = mod.computeBrowserEmbeddings(['old'], '', OLD_MODEL, OLD_REVISION);
  await tick();
  const second = mod.computeBrowserEmbeddings(['new'], '', NEW_MODEL, NEW_REVISION);
  await tick();
  assert.deepEqual(events, [`load:${OLD_MODEL}`, `infer:${OLD_MODEL}`]);
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(events, [`load:${OLD_MODEL}`, `infer:${OLD_MODEL}`, `dispose:${OLD_MODEL}`, `load:${NEW_MODEL}`, `infer:${NEW_MODEL}`]);
});

test('selecting a model persists settings without inference or backfill, and switching back restores the old space', async () => {
  const requests = [], writes = [];
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => { requests.push(message); return { runtimeAvailable: true }; } }
  }, { chrome: { ...chromeFixture, storage: { local: { set(value, callback) { writes.push(plain(value)); callback?.(); return Promise.resolve(); } } } } });
  await mod.updateEmbeddingConfig({ provider: 'browser', browserModel: NEW_MODEL, browserRevision: NEW_REVISION });
  assert.equal(mod.getEmbeddingConfig().browserModel, NEW_MODEL);
  assert.equal(mod.getBrowserEmbedStatus().ready, false);
  await mod.updateEmbeddingConfig({ browserModel: OLD_MODEL, browserRevision: OLD_REVISION });
  assert.equal(mod.getEmbeddingConfig().browserRevision, OLD_REVISION);
  assert.ok(requests.every(message => message.type === 'OFFSCREEN_EMBED_CAPABILITIES'));
  assert.ok(writes.every(value => Object.keys(value).every(key => ['embeddingConfig', 'browserEmbedReady'].includes(key))));
});

test('EmbeddingGemma 2 loads only text with the pinned config and q4 WebGPU runtime', async () => {
  const calls = [];
  const mod = await loadSource('src/offscreen/index.ts', 'getBrowserEmbedder', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    '@huggingface/transformers': {
      env: { backends: { onnx: { wasm: {} } } },
      AutoConfig: { from_pretrained: async (id, options) => { calls.push({ type: 'config', id, options }); return { model_type: 'embedding_gemma2', vision_config: {}, audio_config: {} }; } },
      AutoTokenizer: { from_pretrained: async (id, options) => { calls.push({ type: 'tokenizer', id, options }); return () => ({}); } },
      AutoModel: { from_pretrained: async (id, options) => { calls.push({ type: 'model', id, options }); return () => ({}); } }
    }
  }, { chrome: chromeFixture });
  await mod.getBrowserEmbedder(NEW_MODEL, NEW_REVISION);
  const model = calls.find(call => call.type === 'model');
  assert.equal(model.options.config.vision_config, null);
  assert.equal(model.options.config.audio_config, null);
  assert.equal(model.options.dtype, 'q4');
  assert.equal(model.options.device, 'webgpu');
  assert.ok(calls.every(call => call.options.revision === NEW_REVISION));
});

test('devices without WebGPU can still use the original model', async () => {
  const mod = await loadSource('src/offscreen/index.ts', 'getEmbeddingCapabilities', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    '@huggingface/transformers': { env: { backends: { onnx: { wasm: {} } } } }
  }, { chrome: chromeFixture, navigator: {} });
  await assert.rejects(mod.getEmbeddingCapabilities(NEW_MODEL), /requires WebGPU/);
  assert.equal((await mod.getEmbeddingCapabilities(OLD_MODEL)).runtimeAvailable, true);
});
