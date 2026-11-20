import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, plain, tick } from './helpers.mjs';

const model = 'onnx-community/embeddinggemma-300m-ONNX';
const revision = '75a84c732f1884df76bec365346230e32f582c82';

async function configuredBackground({ cachedFiles = false, storedReady = true } = {}) {
  const requests = [], writes = [];
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../providers/inference': { runInference: action => action() },
    '../offscreen/index': {
      ensureOffscreenDocument: async () => {},
      sendOffscreenMessage: async message => {
        requests.push(plain(message));
        if (message.type === 'OFFSCREEN_EMBED_CAPABILITIES') return { runtimeAvailable: true, cachedFiles };
        throw Error(`Unexpected model work: ${message.type}`);
      }
    }
  }, { chrome: {
    ...chromeFixture,
    storage: {
      local: {
        get(_keys, callback) { callback({ embeddingConfig: { provider: 'browser', browserModel: model, browserRevision: revision }, browserEmbedReady: storedReady }); },
        set(value) { writes.push(plain(value)); return Promise.resolve(); }
      },
      onChanged: { addListener() {} }
    }
  } });
  mod.configureEmbeddings();
  await tick();
  writes.length = 0;
  return { mod, requests, writes };
}

test('a persisted ready flag cannot assert model readiness after worker restart or cache loss', async () => {
  const { mod, requests, writes } = await configuredBackground();
  assert.equal(mod.getBrowserEmbedStatus().ready, false, 'A prior worker cannot verify today’s cached assets');
  const status = await mod.probeBrowserEmbeddingRuntime();
  assert.equal(status.runtimeAvailable, true);
  assert.equal(status.ready, false);
  assert.notEqual(status.state, 'ready');
  assert.deepEqual(requests.map(request => request.type), ['OFFSCREEN_EMBED_CAPABILITIES']);
  assert.deepEqual(writes, [], 'A status check must not rewrite the library, vectors, settings or summaries');
});

test('cached files are distinguished from a model successfully loaded for inference', async () => {
  const { mod, requests } = await configuredBackground({ cachedFiles: true });
  const status = await mod.probeBrowserEmbeddingRuntime();
  assert.equal(status.ready, false, 'A partial or corrupt download must not be called ready from its inventory');
  assert.equal(status.state, 'cached');
  assert.equal(requests.length, 1, 'Reading status must neither load weights nor fetch missing files');
  assert.equal(requests[0].revision, revision);
});

test('capability checks discover only the requested cached revision without loading weights', async () => {
  let loads = 0;
  const mod = await loadSource('src/offscreen/index.ts', 'getEmbeddingCapabilities', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    './modelCache': {
      listBrowserModelDownloads: async () => [
        { model, revision, fileCount: 1, hasWeights: false },
        { model, revision: 'other-revision', fileCount: 2, hasWeights: true }
      ],
      removeBrowserModelFiles: async () => { throw Error('Status must not remove files'); }
    },
    '@huggingface/transformers': {
      env: { backends: { onnx: { wasm: {} } } },
      AutoModel: { from_pretrained: async () => { loads++; throw Error('Must not load weights'); } }
    }
  }, { chrome: chromeFixture });
  const partial = await mod.getEmbeddingCapabilities(model, revision);
  const other = await mod.getEmbeddingCapabilities(model, 'other-revision');
  assert.equal(partial.cachedFiles, true, 'Even partial assets should be visible as cached, not ready');
  assert.equal(other.cachedFiles, true);
  assert.equal((await mod.getEmbeddingCapabilities(model, 'absent-revision')).cachedFiles, false);
  assert.equal(loads, 0);
});

test('an old capability check cannot overwrite the status of a newly selected model', async () => {
  let finish;
  const delayed = new Promise((_resolve, reject) => { finish = () => reject(Error('WebGPU unavailable for the previous model')); });
  let probes = 0;
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../providers/inference': { runInference: action => action() },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ++probes === 1 ? delayed : { runtimeAvailable: true, cachedFiles: false } }
  }, { chrome: chromeFixture });
  const previous = mod.probeBrowserEmbeddingRuntime();
  await tick();
  await mod.updateEmbeddingConfig({ browserModel: 'another/model', browserRevision: 'another-pin' });
  finish();
  await previous;
  const status = mod.getBrowserEmbedStatus();
  assert.equal(status.model, 'another/model');
  assert.equal(status.revision, 'another-pin');
  assert.equal(status.ready, false);
  assert.equal(status.state, 'idle');
});

test('download success requires a cold cache-only load, including when inference was already warm', async () => {
  const loads = [], updates = [], network = [];
  let persisted = false, rejectWrites = true, disposed = 0;
  const mod = await loadSource('src/offscreen/index.ts', 'downloadBrowserModel, computeBrowserEmbeddings', {
    '../shared/db/index': { openDatabase: async () => {}, PAGES_STORE: 'pages' },
    '@huggingface/transformers': {
      env: { backends: { onnx: { wasm: {} } } },
      AutoConfig: {},
      AutoTokenizer: { from_pretrained: async (_model, options) => {
        loads.push({ cacheOnly: options.local_files_only });
        if (options.local_files_only && !persisted) throw Error('local_files_only=true: cached tokenizer missing');
        if (!options.local_files_only) { network.push('explicit download'); if (!rejectWrites) persisted = true; }
        return () => ({});
      } },
      AutoModel: { from_pretrained: async () => {
        const embedder = async () => ({ sentence_embedding: [[0.25, 0.75]] });
        embedder.dispose = async () => { disposed++; };
        return embedder;
      } }
    }
  }, { chrome: { ...chromeFixture, runtime: { ...chromeFixture.runtime, sendMessage: message => { updates.push(plain(message.download)); } } } });
  await mod.computeBrowserEmbeddings(['warm session'], '', model, revision, true);
  await assert.rejects(mod.downloadBrowserModel('storage-rejected', model, revision), /not downloaded|not saved|missing/);
  assert.ok(!updates.some(update => update.state === 'ready'), 'Successful warm inference is not a saved download');
  assert.equal(updates.at(-1).state, 'error');
  assert.ok(loads.some(load => load.cacheOnly), 'The verifier must bypass the in-memory model');
  assert.ok(disposed > 0, 'Release the warm model before verification to avoid two resident models');
  rejectWrites = false;
  await mod.downloadBrowserModel('explicit-retry', model, revision);
  assert.equal(updates.at(-1).state, 'ready');
  assert.equal(loads.at(-1).cacheOnly, true);
  assert.equal(network.length, 3, 'Only the initial load and the two explicit attempts may request remote assets');
});

for (const outcome of ['missing files', 'probe failure']) test(`an earlier same-model status check cannot undo verified readiness after ${outcome}`, async () => {
  let resolveProbe, rejectProbe;
  const pendingProbe = new Promise((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; });
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../providers/inference': { runInference: action => action() },
    '../offscreen/index': {
      ensureOffscreenDocument: async () => {},
      sendOffscreenMessage: async message => message.type === 'OFFSCREEN_EMBED_CAPABILITIES' ? pendingProbe : {}
    }
  }, { chrome: chromeFixture });
  const earlier = mod.probeBrowserEmbeddingRuntime();
  await tick();
  await mod.prefetchBrowserEmbeddings({ requestId: 'new-verified-download' });
  assert.equal(mod.getBrowserEmbedStatus().ready, true);
  if (outcome === 'missing files') resolveProbe({ runtimeAvailable: true, cachedFiles: false });
  else rejectProbe(Error('Earlier capability check failed'));
  const response = await earlier;
  assert.equal(response.ready, true, 'The request response must be current as well as the broadcast status');
  assert.equal(mod.getBrowserEmbedStatus().ready, true);
  assert.equal(mod.getBrowserEmbedStatus().state, 'ready');
  assert.equal(mod.getBrowserEmbedStatus().lastError, undefined);
});

test('switching away and back cannot revive an earlier probe for the same model', async () => {
  let rejectProbe;
  const pendingProbe = new Promise((_resolve, reject) => { rejectProbe = reject; });
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../providers/inference': { runInference: action => action() },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => pendingProbe }
  }, { chrome: chromeFixture });
  const earlier = mod.probeBrowserEmbeddingRuntime();
  await tick();
  await mod.updateEmbeddingConfig({ browserModel: 'another/model', browserRevision: 'another-pin' });
  await mod.updateEmbeddingConfig({ browserModel: model, browserRevision: revision });
  rejectProbe(Error('Obsolete model check failed'));
  const status = await earlier;
  assert.equal(status.state, 'idle');
  assert.equal(mod.getBrowserEmbedStatus().state, 'idle');
  assert.equal(mod.getBrowserEmbedStatus().lastError, undefined);
});

test('a healthy inference capability check remains usable while a newer status check is pending', async () => {
  const completions = [], requests = [];
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../providers/inference': { runInference: action => action() },
    '../offscreen/index': {
      ensureOffscreenDocument: async () => {},
      sendOffscreenMessage: async message => {
        requests.push(message.type);
        if (message.type === 'OFFSCREEN_EMBED_CAPABILITIES') return new Promise(resolve => { completions.push(resolve); });
        if (message.type === 'OFFSCREEN_EMBED') return { embeddings: [[0.25, 0.75]] };
        throw Error(`Unexpected model operation: ${message.type}`);
      }
    }
  }, { chrome: {
    ...chromeFixture,
    storage: {
      local: { ...chromeFixture.storage.local, get(_keys, callback) { callback({ embeddingConfig: { provider: 'browser', browserModel: model, browserRevision: revision } }); } },
      onChanged: { addListener() {} }
    }
  } });
  mod.configureEmbeddings();
  const inference = mod.computeEmbeddingsForQueries(['saved evidence']);
  await tick();
  const newer = mod.probeBrowserEmbeddingRuntime();
  await tick();
  assert.equal(completions.length, 2);
  completions[0]({ runtimeAvailable: true, cachedFiles: true });
  let vectors;
  try { vectors = await inference; }
  finally { completions[1]({ runtimeAvailable: true, cachedFiles: true }); await newer; }
  assert.deepEqual(plain(vectors), [[0.25, 0.75]]);
  assert.equal(requests.filter(type => type === 'OFFSCREEN_EMBED').length, 1);
  assert.equal(mod.getBrowserEmbedStatus().ready, true);
});
