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

test('removing a loaded model waits for inference, disposes it, then removes only its download', async () => {
  const events = []; let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const mod = await loadSource('src/offscreen/index.ts', 'computeBrowserEmbeddings, removeBrowserModel', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    './modelCache': { listBrowserModelDownloads: async () => [], removeBrowserModelFiles: async (model, revision) => { events.push(`delete:${model}@${revision}`); return 3; } },
    '@huggingface/transformers': {
      env: { backends: { onnx: { wasm: {} } } }, AutoConfig: {},
      AutoTokenizer: { from_pretrained: async () => () => ({}) },
      AutoModel: { from_pretrained: async () => { const model = async () => { events.push('infer'); await pending; return { sentence_embedding: [[1, 2]] }; }; model.dispose = async () => { events.push('dispose'); }; return model; } }
    }
  }, { chrome: chromeFixture });
  const inference = mod.computeBrowserEmbeddings(['text'], '', OLD_MODEL, OLD_REVISION);
  await tick(); const remove = mod.removeBrowserModel(OLD_MODEL, OLD_REVISION); await tick();
  assert.deepEqual(events, ['infer']); finish(); await inference;
  assert.equal(await remove, 3);
  assert.deepEqual(events, ['infer', 'dispose', `delete:${OLD_MODEL}@${OLD_REVISION}`]);
});

test('only explicit downloads permit remote model files, including after removal', async () => {
  let cached = false, downloads = 0;
  const runtimeEnv = { backends: { onnx: { wasm: {} } } };
  const mod = await loadSource('src/offscreen/index.ts', 'computeBrowserEmbeddings, removeBrowserModel', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    './modelCache': { listBrowserModelDownloads: async () => [], removeBrowserModelFiles: async () => { cached = false; return 2; } },
    '@huggingface/transformers': {
      env: runtimeEnv, AutoConfig: {},
      AutoTokenizer: { from_pretrained: async (_model, options) => { if (options.local_files_only) assert.equal(runtimeEnv.allowLocalModels, true, 'Transformers requires allowLocalModels for cached-file-only loads'); else { cached = true; downloads++; } if (!cached) throw Error('local_files_only=true: no cached file'); return () => ({}); } },
      AutoModel: { from_pretrained: async () => { const model = async () => ({ sentence_embedding: [[1, 2]] }); model.dispose = async () => {}; return model; } }
    }
  }, { chrome: chromeFixture });
  await assert.rejects(mod.computeBrowserEmbeddings(['text'], '', OLD_MODEL, OLD_REVISION), /not downloaded/);
  assert.equal(downloads, 0);
  await mod.computeBrowserEmbeddings(['text'], '', OLD_MODEL, OLD_REVISION, true); assert.equal(downloads, 1);
  await mod.removeBrowserModel(OLD_MODEL, OLD_REVISION);
  await assert.rejects(mod.computeBrowserEmbeddings(['text'], '', OLD_MODEL, OLD_REVISION), /not downloaded/);
  assert.equal(downloads, 1);
});

test('removal invalidates old ready responses without changing model selection or stored pages', async () => {
  let finish; const requests = [];
  const pending = new Promise(resolve => { finish = resolve; });
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => {
      requests.push(message);
      return message.type === 'OFFSCREEN_EMBED' ? pending : message.type === 'OFFSCREEN_REMOVE_BROWSER_MODEL' ? { deletedFiles: 3 } : { runtimeAvailable: true };
    } }
  }, { chrome: chromeFixture });
  await mod.updateEmbeddingConfig({ provider: 'browser' });
  const inference = mod.computeEmbeddingsForQueries(['query']); await tick();
  await mod.deleteBrowserModel(OLD_MODEL, OLD_REVISION); finish({ embeddings: [[1, 2]] });
  await assert.rejects(inference, /settings changed/);
  assert.equal(mod.getBrowserEmbedStatus().ready, false);
  assert.equal(mod.getEmbeddingConfig().browserModel, OLD_MODEL);
  assert.equal(requests.find(message => message.type === 'OFFSCREEN_EMBED').allowDownload, false);
  assert.ok(!requests.some(message => ['DELETE_PAGE', 'BACKFILL_EMBEDDINGS', 'OFFSCREEN_INVALIDATE_INDEX'].includes(message.type)));
});

test('explicit download permits model files and keeps the worker active until it finishes', async () => {
  let held = false, downloaded = false;
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../providers/inference': { runInference: async action => { held = true; try { return await action(); } finally { held = false; } } },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => {
      if (message.type === 'OFFSCREEN_DOWNLOAD_BROWSER_MODEL') { assert.equal(held, true); assert.ok(message.requestId); downloaded = true; return {}; }
      return { runtimeAvailable: true };
    } }
  }, { chrome: chromeFixture });
  await mod.prefetchBrowserEmbeddings();
  assert.equal(downloaded, true); assert.equal(held, false); assert.equal(mod.getBrowserEmbedStatus().ready, true);
});
