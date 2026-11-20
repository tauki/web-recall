import { browserEmbeddingRuntime, DEFAULT_EMBEDDING_CONFIG } from '../shared/config/index';
import { BROWSER_MODEL_CACHE, type BrowserModelTransfer } from '../shared/browserModels';
import { listBrowserModelDownloads, removeBrowserModelFiles } from './modelCache';
import { bindSavedLibraryTransfer, forwardSavedLibraryRequest, type SavedLibrarySender } from './libraryHost';

type BrowserEmbedder = {
  tokenizer: (inputs: string[], options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  model: (inputs: Record<string, unknown>) => Promise<Record<string, unknown>>;
  dispose: () => Promise<void>;
};

let embedderPromise: Promise<BrowserEmbedder> | null = null;
let embedderKey = '';
let embeddingQueue: Promise<unknown> = Promise.resolve();
type DownloadContext = { signal: AbortSignal; progress: (info: { status: string; file?: string; loaded?: number; total?: number }) => void };
type DownloadJob = { controller: AbortController; status: BrowserModelTransfer; lastBroadcast: number };
let downloadJob: DownloadJob | null = null;
let lastDownload: BrowserModelTransfer | null = null;
const cancelledDownloads = new Set<string>();

function reportDownload(job: DownloadJob, update: Partial<BrowserModelTransfer>, force = false): void {
  const previous = job.status;
  job.status = { ...previous, ...update }; lastDownload = job.status;
  if (!force && previous.state === job.status.state && previous.file === job.status.file && Date.now() - job.lastBroadcast < 100) return;
  job.lastBroadcast = Date.now();
  void Promise.resolve(chrome.runtime.sendMessage({ type: 'BROWSER_MODEL_DOWNLOAD_UPDATE', download: job.status })).catch(() => {});
}

function cancelBrowserModelDownload(requestId: string): boolean {
  if (!requestId) return false;
  // Cancellation can arrive before the queued start message. Retain a small admission fence.
  cancelledDownloads.add(requestId);
  if (cancelledDownloads.size > 128) cancelledDownloads.delete(cancelledDownloads.values().next().value!);
  if (!downloadJob || downloadJob.status.requestId !== requestId) return false;
  if (['ready', 'error', 'cancelled'].includes(downloadJob.status.state)) return false;
  reportDownload(downloadJob, { state: 'cancelling' }, true);
  downloadJob.controller.abort(new Error('Download cancelled'));
  return true;
}

async function downloadBrowserModel(requestId: string, model: string, revision: string): Promise<{ cancelled?: boolean }> {
  if (!requestId || !model || !revision) throw new Error('A download request, model and revision are required.');
  if (downloadJob) throw new Error('Another browser model download is running. Cancel it before starting another.');
  const job: DownloadJob = { controller: new AbortController(), status: { requestId, model, revision, startedAt: Date.now(), state: 'queued', loadedBytes: 0 }, lastBroadcast: 0 };
  downloadJob = job;
  if (cancelledDownloads.delete(requestId)) job.controller.abort(new Error('Download cancelled'));
  reportDownload(job, {}, true);
  const signal = job.controller.signal;
  const pending = embeddingQueue.then(async () => {
    signal.throwIfAborted();
    await getEmbeddingCapabilities(model);
    signal.throwIfAborted(); reportDownload(job, { state: 'downloading' }, true);
    const context: DownloadContext = { signal, progress(info) {
      signal.throwIfAborted();
      if (info.status === 'progress' && info.file) {
        reportDownload(job, { state: 'downloading', file: info.file, loadedBytes: Number.isFinite(info.loaded) ? Math.max(0, info.loaded!) : 0, totalBytes: Number.isFinite(info.total) && info.total! > 0 ? info.total : undefined });
      } else if (info.status === 'download' && info.file && info.file !== job.status.file) {
        reportDownload(job, { state: 'downloading', file: info.file, loadedBytes: 0, totalBytes: undefined });
      } else if (info.status === 'preparing' || (info.status === 'done' && info.file && /\.onnx(?:$|_data)/.test(info.file))) reportDownload(job, { state: 'preparing' }, true);
    } };
    for (const allowDownload of [true, false]) {
      await releaseBrowserEmbedder();
      signal.throwIfAborted();
      const vectors = await computeBrowserEmbeddingsNow(['prefetch'], 'title: none | text: ', model, revision, allowDownload, context);
      signal.throwIfAborted();
      if (vectors.length !== 1 || !vectors[0]?.length || !vectors[0].every(Number.isFinite)) throw new Error('Browser model returned incomplete embeddings');
    }
    reportDownload(job, { state: 'ready' }, true);
  });
  embeddingQueue = pending.catch(() => {});
  try { await pending; return {}; }
  catch (error) {
    if (signal.aborted) { reportDownload(job, { state: 'cancelled', error: undefined }, true); return { cancelled: true }; }
    reportDownload(job, { state: 'error', error: error instanceof Error ? error.message : String(error) }, true);
    throw error;
  } finally { if (downloadJob === job) downloadJob = null; }
}

async function getEmbeddingCapabilities(model?: string, revision?: string): Promise<{ runtimeAvailable: boolean; backend: 'onnx-wasm' | 'onnx-webgpu'; dtype: string; cachedFiles: boolean }> {
  const runtime = browserEmbeddingRuntime(model);
  if (runtime.device === 'webgpu') {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu || !await gpu.requestAdapter()) {
      throw new Error('EmbeddingGemma 2 requires WebGPU. Choose EmbeddingGemma 300M to use browser embeddings on this device.');
    }
  }
  const { env } = await import('@huggingface/transformers');
  const wasmBackend = env.backends?.onnx?.wasm;
  if (!wasmBackend) {
    throw new Error('ONNX WASM backend is unavailable');
  }
  return {
    runtimeAvailable: true,
    backend: runtime.device === 'webgpu' ? 'onnx-webgpu' : 'onnx-wasm',
    dtype: runtime.dtype,
    cachedFiles: Boolean(revision && (await listBrowserModelDownloads()).some(download => download.model === model && download.revision === revision && download.fileCount > 0))
  };
}

async function releaseBrowserEmbedder(): Promise<void> {
  const previous = embedderPromise;
  embedderPromise = null;
  embedderKey = '';
  const loaded = await previous?.catch(() => null);
  if (loaded) await loaded.dispose();
}

async function getBrowserEmbedder(model: string, revision: string, allowDownload = false, download?: DownloadContext): Promise<BrowserEmbedder> {
  const key = `${model}@${revision}`;
  if (embedderPromise && embedderKey === key) return embedderPromise;
  const previous = embedderPromise;
  embedderKey = key;
  embedderPromise = (async (): Promise<BrowserEmbedder> => {
    const old = await previous?.catch(() => null);
    if (old) await old.dispose();
    const { AutoConfig, AutoTokenizer, AutoModel, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = true;
    // Transformers requires this flag for local_files_only, even on cache hits.
    env.allowLocalModels = !allowDownload;
    env.remoteHost = 'https://huggingface.co';
    env.cacheKey = BROWSER_MODEL_CACHE;
    // Inference uses downloaded files only. Network downloads require Settings' action.
    const options = { revision, local_files_only: !allowDownload, progress_callback: download?.progress };
    const wasmBackend = env.backends?.onnx?.wasm;
    if (!wasmBackend) {
      throw new Error('ONNX WASM backend is unavailable');
    }
    wasmBackend.wasmPaths = chrome.runtime.getURL('dist/beta/transformers/');
    wasmBackend.numThreads = 1;
    wasmBackend.simd = true;
    wasmBackend.proxy = false;
    // EmbeddingGemma 2 otherwise downloads vision and audio encoders as well.
    // Keep the config and every model asset on the same pinned revision.
    const previousFetch = env.fetch;
    if (download) env.fetch = (input, init) => { download.signal.throwIfAborted(); return previousFetch(input, { ...init, signal: download.signal }); };
    try {
      download?.signal.throwIfAborted();
      const config = model === 'onnx-community/embeddinggemma-2-ONNX'
        ? await AutoConfig.from_pretrained(model, options)
        : undefined;
      if (config) Object.assign(config, { vision_config: null, audio_config: null });
      download?.signal.throwIfAborted();
      const tokenizer = await AutoTokenizer.from_pretrained(model, options);
      download?.signal.throwIfAborted();
      const embedder = await AutoModel.from_pretrained(model, { ...options, config, ...browserEmbeddingRuntime(model) });
      if (download?.signal.aborted) { await embedder.dispose(); download.signal.throwIfAborted(); }
      return { tokenizer: async (inputs, options) => tokenizer(inputs, options), model: inputs => embedder(inputs), dispose: async () => { await embedder.dispose(); } };
    } finally { if (download) env.fetch = previousFetch; }
  })().catch((error) => {
    if (embedderKey === key) embedderPromise = null;
    if (!allowDownload && String(error?.message || error).includes('local_files_only')) {
      throw new Error('This browser model is not downloaded. Open Settings → Models → Embedding provider and choose Save & download model.');
    }
    throw error;
  });
  return embedderPromise;
}

async function toList(output: unknown): Promise<number[][]> {
  if (output && typeof output === 'object' && 'tolist' in (output as Record<string, unknown>)) {
    const list = await (output as { tolist: () => Promise<number[][]> }).tolist();
    return list;
  }
  if (Array.isArray(output)) {
    if (Array.isArray(output[0])) return output as number[][];
    return [output as number[]];
  }
  return [];
}

function computeBrowserEmbeddings(inputs: string[], prefix: string, model: string, revision: string, allowDownload = false): Promise<number[][]> {
  // One inference at a time keeps model replacement from disposing an active session.
  const pending = embeddingQueue.then(() => computeBrowserEmbeddingsNow(inputs, prefix, model, revision, allowDownload));
  embeddingQueue = pending.catch(() => {});
  return pending;
}

async function computeBrowserEmbeddingsNow(inputs: string[], prefix: string, model: string, revision: string, allowDownload: boolean, download?: DownloadContext): Promise<number[][]> {
  if (!inputs.length) return [];
  const loaded = await getBrowserEmbedder(model, revision, allowDownload, download);
  const { tokenizer, model: embedder } = loaded;
  try {
    download?.signal.throwIfAborted();
    download?.progress({ status: 'preparing' });
    const tagged = inputs.map((text) => `${prefix}${text || ''}`);
    const encoded = await tokenizer(tagged, { padding: true, truncation: true });
    download?.signal.throwIfAborted();
    const output = await embedder(encoded);
    download?.signal.throwIfAborted();
    const sentenceEmbedding = (output as { sentence_embedding?: unknown }).sentence_embedding;
    return sentenceEmbedding ? toList(sentenceEmbedding) : [];
  } finally {
    if (download?.signal.aborted) { await loaded.dispose(); embedderPromise = null; embedderKey = ''; }
  }
}

function removeBrowserModel(model: string, revision: string): Promise<number> {
  if (downloadJob?.status.model === model && downloadJob.status.revision === revision) cancelBrowserModelDownload(downloadJob.status.requestId);
  // Wait for model loading/inference to finish before disposal or cache deletion.
  const pending = embeddingQueue.then(async () => {
    if (embedderKey === `${model}@${revision}`) {
      await releaseBrowserEmbedder();
    }
    return removeBrowserModelFiles(model, revision);
  });
  embeddingQueue = pending.catch(() => {});
  return pending;
}

bindSavedLibraryTransfer();

chrome.runtime.onMessage.addListener(
  (message: { type?: string; [key: string]: unknown }, sender: SavedLibrarySender, sendResponse: (response?: unknown) => void) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === 'OFFSCREEN_SAVED_LIBRARY') return forwardSavedLibraryRequest(message.request, sender, sendResponse);
  if (message.type === 'OFFSCREEN_TOP_PAGES' || message.type === 'OFFSCREEN_SCORE_CHUNKS' || message.type === 'OFFSCREEN_INVALIDATE_INDEX') {
    const action = message.type === 'OFFSCREEN_TOP_PAGES' ? {
      op: 'semanticTop', queries: message.variationEmbeddings, key: message.embeddingKey, limit: message.topN
    } : message.type === 'OFFSCREEN_SCORE_CHUNKS' ? {
      op: 'semanticChunks', queries: message.variationEmbeddings, key: message.embeddingKey, question: message.originalQuery, urls: message.pageUrls
    } : { op: 'invalidateSemantic' };
    return forwardSavedLibraryRequest({ kind: 'operate', id: message.libraryId, replacement: message.libraryReplacement, action }, sender, response => {
      const envelope = response as { value?: unknown; error?: string };
      sendResponse(envelope?.error ? envelope : envelope?.value);
    });
  }
  if (message.type === 'OFFSCREEN_EMBED') {
    const inputs = Array.isArray(message.inputs) ? (message.inputs as string[]) : [];
    const prefix = typeof message.prefix === 'string' ? message.prefix : '';
    const model = typeof message.model === 'string' ? message.model : DEFAULT_EMBEDDING_CONFIG.browserModel!;
    const revision = typeof message.revision === 'string' ? message.revision : DEFAULT_EMBEDDING_CONFIG.browserRevision!;
    computeBrowserEmbeddings(inputs, prefix, model, revision, message.allowDownload === true)
      .then((embeddings) => sendResponse({ embeddings }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_LIST_BROWSER_MODELS') {
    listBrowserModelDownloads().then(models => sendResponse({ models })).catch(err => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_DOWNLOAD_BROWSER_MODEL') {
    downloadBrowserModel(String(message.requestId || ''), String(message.model || ''), String(message.revision || ''))
      .then(result => sendResponse(result)).catch(err => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_CANCEL_BROWSER_MODEL_DOWNLOAD') { sendResponse({ cancelled: cancelBrowserModelDownload(String(message.requestId || '')) }); return true; }
  if (message.type === 'OFFSCREEN_GET_BROWSER_MODEL_DOWNLOAD') { sendResponse({ download: lastDownload }); return true; }
  if (message.type === 'OFFSCREEN_REMOVE_BROWSER_MODEL') {
    removeBrowserModel(String(message.model || ''), String(message.revision || ''))
      .then(deletedFiles => sendResponse({ deletedFiles }))
      .catch(err => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_EMBED_CAPABILITIES') {
    getEmbeddingCapabilities(typeof message.model === 'string' ? message.model : undefined, typeof message.revision === 'string' ? message.revision : undefined)
      .then((capabilities) => sendResponse(capabilities))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  return false;
});
