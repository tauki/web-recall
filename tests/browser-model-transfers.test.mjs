import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, chromeFixture, tick, waitFor, plain } from './helpers.mjs';

const MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
const REV = '75a84c732f1884df76bec365346230e32f582c82';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const dbMock = { openDatabase: async () => {}, PAGES_STORE: 'pages' };

test('cancel aborts the fetch signal, retains completed files and retry restores the fetch hook', async () => {
  const updates = [], signals = [];
  let tokenizerCached = false, tokenizerDownloads = 0, weightAttempts = 0, weightsCached = false;
  const originalFetch = async (_url, options) => {
    signals.push(options.signal);
    if (++weightAttempts === 1) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return {};
  };
  const env = { fetch: originalFetch, backends: { onnx: { wasm: {} } } };
  const mod = await loadSource('src/offscreen/index.ts', 'downloadBrowserModel, cancelBrowserModelDownload', {
    '../shared/db/index': dbMock,
    '@huggingface/transformers': { env, AutoConfig: {},
      AutoTokenizer: { from_pretrained: async (_id, options) => {
        if (!tokenizerCached) { tokenizerDownloads++; tokenizerCached = true; options.progress_callback({ status: 'done', file: 'tokenizer.json' }); }
        return () => ({});
      } },
      AutoModel: { from_pretrained: async (_id, options) => {
        if (options.local_files_only && !weightsCached) throw Error('local_files_only=true: cached weights missing');
        if (!options.local_files_only) {
          options.progress_callback({ status: 'progress', file: 'onnx/model_quantized.onnx', loaded: 25, total: 100 });
          await env.fetch('https://huggingface.co/model.onnx');
          weightsCached = true;
        }
        const model = async () => ({ sentence_embedding: [[1, 2]] }); model.dispose = async () => {}; return model;
      } }
    }
  }, { chrome: { ...chromeFixture, runtime: { ...chromeFixture.runtime, sendMessage: message => { updates.push(plain(message.download)); } } } });
  const first = mod.downloadBrowserModel('first', MODEL, REV);
  await waitFor(() => signals.length === 1, 'model fetch');
  assert.equal(mod.cancelBrowserModelDownload('unrelated'), false);
  assert.equal(signals[0].aborted, false);
  assert.equal(mod.cancelBrowserModelDownload('first'), true);
  assert.deepEqual(plain(await first), { cancelled: true });
  assert.equal(signals[0].aborted, true);
  assert.equal(updates.at(-1).state, 'cancelled');
  assert.equal(env.fetch, originalFetch);
  assert.equal(tokenizerCached, true, 'completed files remain cached');
  await mod.downloadBrowserModel('retry', MODEL, REV);
  assert.equal(tokenizerDownloads, 1);
  assert.equal(weightAttempts, 2);
  assert.notEqual(signals[1], signals[0]);
  assert.equal(signals[1].aborted, false);
  assert.equal(env.fetch, originalFetch);
  assert.ok(updates.some(update => update.loadedBytes === 25 && update.totalBytes === 100));
  assert.ok(updates.some(update => update.requestId === 'retry' && update.state === 'preparing'));
  assert.equal(updates.at(-1).state, 'ready');
});

test('cancellation arriving before admission never fetches, and a queued job can be cancelled', async () => {
  let loads = 0;
  const inference = deferred();
  const mod = await loadSource('src/offscreen/index.ts', 'downloadBrowserModel, cancelBrowserModelDownload, computeBrowserEmbeddings', {
    '../shared/db/index': dbMock,
    '@huggingface/transformers': { env: { backends: { onnx: { wasm: {} } } }, AutoConfig: {},
      AutoTokenizer: { from_pretrained: async () => { loads++; return () => ({}); } },
      AutoModel: { from_pretrained: async () => { const model = async () => { await inference.promise; return { sentence_embedding: [[1]] }; }; model.dispose = async () => {}; return model; } }
    }
  }, { chrome: chromeFixture });
  mod.cancelBrowserModelDownload('early');
  assert.equal((await mod.downloadBrowserModel('early', MODEL, REV)).cancelled, true);
  assert.equal(loads, 0);
  const running = mod.computeBrowserEmbeddings(['text'], '', MODEL, REV);
  await waitFor(() => loads === 1, 'inference');
  const queued = mod.downloadBrowserModel('queued', 'another/model', 'pin');
  await assert.rejects(mod.downloadBrowserModel('duplicate', MODEL, REV), /Another browser model/);
  assert.equal(mod.cancelBrowserModelDownload('queued'), true);
  inference.resolve(); await running;
  assert.equal((await queued).cancelled, true);
  assert.equal(loads, 1);
});

test('cancel during model initialization waits for disposal and never reports ready', async () => {
  const init = deferred(), updates = []; let initializing = false, disposed = false;
  const mod = await loadSource('src/offscreen/index.ts', 'downloadBrowserModel, cancelBrowserModelDownload', {
    '../shared/db/index': dbMock,
    '@huggingface/transformers': { env: { backends: { onnx: { wasm: {} } } }, AutoConfig: {},
      AutoTokenizer: { from_pretrained: async () => () => ({}) },
      AutoModel: { from_pretrained: async () => { initializing = true; await init.promise; const model = async () => { throw Error('must not infer'); }; model.dispose = async () => { disposed = true; }; return model; } }
    }
  }, { chrome: { ...chromeFixture, runtime: { ...chromeFixture.runtime, sendMessage: message => { updates.push(message.download); } } } });
  const pending = mod.downloadBrowserModel('init', MODEL, REV);
  await waitFor(() => initializing, 'model initialization');
  mod.cancelBrowserModelDownload('init'); await tick();
  assert.equal(updates.at(-1).state, 'cancelling');
  init.resolve(); assert.equal((await pending).cancelled, true);
  assert.equal(disposed, true);
  assert.ok(!updates.some(update => update.state === 'ready'));
});

test('a failed download can retry and unknown file size stays indeterminate', async () => {
  const updates = []; let attempt = 0;
  const mod = await loadSource('src/offscreen/index.ts', 'downloadBrowserModel', {
    '../shared/db/index': dbMock,
    '@huggingface/transformers': { env: { backends: { onnx: { wasm: {} } } }, AutoConfig: {},
      AutoTokenizer: { from_pretrained: async (_model, options) => { options.progress_callback({ status: 'progress', file: 'tokenizer.json', loaded: 123 }); if (++attempt === 1) throw Error('connection lost'); return () => ({}); } },
      AutoModel: { from_pretrained: async () => { const model = async () => ({ sentence_embedding: [[1]] }); model.dispose = async () => {}; return model; } }
    }
  }, { chrome: { ...chromeFixture, runtime: { ...chromeFixture.runtime, sendMessage: message => { updates.push(message.download); } } } });
  await assert.rejects(mod.downloadBrowserModel('failed', MODEL, REV), /connection lost/);
  assert.equal(updates.at(-1).state, 'error');
  assert.equal(updates.find(update => update.file)?.totalBytes, undefined);
  await mod.downloadBrowserModel('retry', MODEL, REV);
  assert.equal(updates.at(-1).state, 'ready');
});

test('background cancellation while opening offscreen prevents a late start', async () => {
  const opening = deferred(), requests = [];
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: () => opening.promise, sendOffscreenMessage: async message => { requests.push(message); return {}; } }
  }, { chrome: chromeFixture });
  const pending = mod.prefetchBrowserEmbeddings({ requestId: 'early' });
  assert.equal((await mod.getBrowserModelDownload()).state, 'queued');
  await mod.cancelBrowserModelDownload('early');
  opening.resolve(); await assert.rejects(pending, /cancelled/);
  assert.equal((await mod.getBrowserModelDownload()).state, 'cancelled');
  assert.ok(!requests.some(message => message.type === 'OFFSCREEN_DOWNLOAD_BROWSER_MODEL'));
});

test('background targets the request, rejects concurrent downloads and trusts completion over a late cancel', async () => {
  const completion = deferred(), requests = [];
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => { requests.push(message); return message.type === 'OFFSCREEN_DOWNLOAD_BROWSER_MODEL' ? completion.promise : { cancelled: false }; } }
  }, { chrome: chromeFixture });
  const pending = mod.prefetchBrowserEmbeddings({ requestId: 'active' }); await tick();
  await assert.rejects(mod.prefetchBrowserEmbeddings({ requestId: 'second' }), /Another browser model/);
  await mod.cancelBrowserModelDownload('active');
  assert.equal(requests.at(-1).requestId, 'active');
  completion.resolve({}); await pending;
  assert.equal(mod.getBrowserEmbedStatus().ready, true);
});

test('retrying a previous model does not change selection or mark the new selection ready', async () => {
  const completion = deferred();
  const mod = await loadSource('src/background/embeddings/index.ts', '', {
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async message => message.type === 'OFFSCREEN_DOWNLOAD_BROWSER_MODEL' ? completion.promise : { runtimeAvailable: true } }
  }, { chrome: chromeFixture });
  const pending = mod.prefetchBrowserEmbeddings({ requestId: 'old', model: MODEL, revision: REV }); await tick();
  await mod.updateEmbeddingConfig({ browserModel: 'another/model', browserRevision: 'new-pin' });
  completion.resolve({}); await pending;
  assert.equal(mod.getBrowserEmbedStatus().ready, false);
  assert.equal(mod.getEmbeddingConfig().browserModel, 'another/model');
});
