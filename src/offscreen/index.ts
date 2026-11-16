import { openDatabase, PAGES_STORE, type PageRecord } from '../shared/db/index';
import { computeCentroid, cosineSimilarity, recencyWeight } from '../shared/vectors';
import { browserEmbeddingRuntime, DEFAULT_EMBEDDING_CONFIG } from '../shared/config/index';
import { BROWSER_MODEL_CACHE, type BrowserModelTransfer } from '../shared/browserModels';
import { listBrowserModelDownloads, removeBrowserModelFiles } from './modelCache';

type CentroidEntry = {
  url: string;
  centroid: number[];
  embeddingKey: string;
  timestamp: number;
};

type ScoreCandidate = {
  url: string;
  title: string;
  snippet: string;
  chunkIndex?: number;
  score: number;
  weightedScore: number;
  recencyWeight: number;
  containsExact: boolean;
  timestamp: number;
};

const DISPLAY_SNIPPET_MAX = 200;
let centroidIndex: CentroidEntry[] | null = null;

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
    const vectors = await computeBrowserEmbeddingsNow(['prefetch'], 'title: none | text: ', model, revision, true, context);
    signal.throwIfAborted();
    if (vectors.length !== 1 || !vectors[0]?.length || !vectors[0].every(Number.isFinite)) throw new Error('Browser model returned incomplete embeddings');
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

async function getEmbeddingCapabilities(model?: string): Promise<{ runtimeAvailable: boolean; backend: 'onnx-wasm' | 'onnx-webgpu'; dtype: string }> {
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
    dtype: runtime.dtype
  };
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
      const loaded = await embedderPromise?.catch(() => null);
      if (loaded) await loaded.dispose();
      embedderPromise = null; embedderKey = '';
    }
    return removeBrowserModelFiles(model, revision);
  });
  embeddingQueue = pending.catch(() => {});
  return pending;
}

async function readAllPages(): Promise<PageRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PAGES_STORE, 'readonly');
    const req = tx.objectStore(PAGES_STORE).getAll();
    req.onsuccess = () => resolve((req.result as PageRecord[]) || []);
    req.onerror = () => reject(req.error);
  });
}

function buildSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DISPLAY_SNIPPET_MAX) return trimmed;
  const cut = trimmed.slice(0, DISPLAY_SNIPPET_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  const safe = lastSpace > 120 ? cut.slice(0, lastSpace) : cut;
  return `${safe.replace(/[\s.,;:!-]+$/, '')}…`;
}

async function ensureCentroidIndex(): Promise<CentroidEntry[]> {
  if (centroidIndex) return centroidIndex;
  const pages = await readAllPages();
  const index: CentroidEntry[] = [];
  for (const page of pages) {
    const keys = new Set(page.chunks.map((chunk) => chunk.embeddingKey).filter((key): key is string => Boolean(key)));
    for (const embeddingKey of keys) {
      const centroid = computeCentroid(page.chunks.filter((chunk) => chunk.embeddingKey === embeddingKey));
      if (centroid) index.push({ url: page.url, centroid, embeddingKey, timestamp: page.timestamp });
    }
  }
  centroidIndex = index;
  return centroidIndex;
}

async function topPagesByCentroid(variationEmbeddings: number[][], topN: number, embeddingKey: string): Promise<Array<{ url: string }>> {
  if (!Array.isArray(variationEmbeddings) || !variationEmbeddings.length) return [];
  const idx = await ensureCentroidIndex();
  const scored = idx.filter((entry) => entry.embeddingKey === embeddingKey).map((entry) => {
    let maxSim = -Infinity;
    for (const ve of variationEmbeddings) {
      const sim = cosineSimilarity(ve, entry.centroid);
      if (sim > maxSim) maxSim = sim;
    }
    const weightedScore = maxSim * recencyWeight(entry.timestamp);
    return { url: entry.url, score: maxSim, weightedScore, timestamp: entry.timestamp };
  });
  scored.sort((a, b) => b.weightedScore - a.weightedScore);
  return scored.slice(0, Math.min(topN, scored.length));
}

async function scoreChunksInPages(pageUrls: string[], variationEmbeddings: number[][], originalQuery: string, embeddingKey: string): Promise<ScoreCandidate[]> {
  if (!variationEmbeddings.length) return [];
  const db = await openDatabase();
  const pages = await Promise.all([...new Set(pageUrls)].map(url => new Promise<PageRecord | undefined>((resolve, reject) => {
    const request = db.transaction(PAGES_STORE, 'readonly').objectStore(PAGES_STORE).get(url);
    request.onsuccess = () => resolve(request.result as PageRecord | undefined);
    request.onerror = () => reject(request.error);
  })));
  const candidates: ScoreCandidate[] = [];
  const normalizedQuery = (originalQuery || '').toLowerCase().trim();
  const tokens = normalizedQuery.split(/\W+/).filter((t) => t.length >= 3);

  for (const page of pages) {
    if (!page) continue;
    const titleLower = (page.title || '').toLowerCase();
    page.chunks.forEach((chunk, idx) => {
      if (chunk.embeddingKey !== embeddingKey) return;
      const emb = chunk.embedding;
      if (!Array.isArray(emb) || emb.length === 0) return;
      let maxSim = -Infinity;
      for (const ve of variationEmbeddings) {
        const sim = cosineSimilarity(ve, emb);
        if (sim > maxSim) maxSim = sim;
      }
      const rec = recencyWeight(page.timestamp);
      const snippetLower = (chunk.text || '').toLowerCase();
      const hasExact = normalizedQuery.length >= 3 && snippetLower.includes(normalizedQuery);
      let hasToken = false;
      if (!hasExact && tokens.length) {
        hasToken = tokens.some((tok) => snippetLower.includes(tok));
      }
      if (!hasToken && tokens.length) {
        hasToken = tokens.some((tok) => titleLower.includes(tok));
      }
      const weightedScore = maxSim * 0.75 + (hasExact ? 0.12 : 0) + (hasToken ? 0.05 : 0) + rec * 0.05;
      candidates.push({
        url: page.url,
        title: page.title || page.url,
        snippet: buildSnippet(chunk.text || ''),
        chunkIndex: idx,
        score: maxSim,
        weightedScore,
        recencyWeight: rec,
        containsExact: hasExact,
        timestamp: page.timestamp
      });
    });
  }
  return candidates;
}

chrome.runtime.onMessage.addListener(
  (message: { type?: string; [key: string]: unknown }, _sender: unknown, sendResponse: (response?: unknown) => void) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === 'OFFSCREEN_TOP_PAGES') {
    const variationEmbeddings = Array.isArray(message.variationEmbeddings) ? (message.variationEmbeddings as number[][]) : [];
    const topN = typeof message.topN === 'number' ? message.topN : 20;
    topPagesByCentroid(variationEmbeddings, topN, String(message.embeddingKey || ''))
      .then((pages) => sendResponse({ pages }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_SCORE_CHUNKS') {
    const pageUrls = Array.isArray(message.pageUrls) ? (message.pageUrls as string[]) : [];
    const variationEmbeddings = Array.isArray(message.variationEmbeddings) ? (message.variationEmbeddings as number[][]) : [];
    const originalQuery = typeof message.originalQuery === 'string' ? message.originalQuery : '';
    scoreChunksInPages(pageUrls, variationEmbeddings, originalQuery, String(message.embeddingKey || ''))
      .then((candidates) => sendResponse({ candidates }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
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
    getEmbeddingCapabilities(typeof message.model === 'string' ? message.model : undefined)
      .then((capabilities) => sendResponse(capabilities))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_INVALIDATE_INDEX') {
    centroidIndex = null;
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
