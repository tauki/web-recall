import { openDatabase, PAGES_STORE, type PageRecord } from '../shared/db/index';
import { computeCentroid, cosineSimilarity, recencyWeight } from '../shared/vectors';

type CentroidEntry = {
  url: string;
  centroid: number[];
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
const DEFAULT_WASM_DTYPE = 'q8';
let centroidIndex: CentroidEntry[] | null = null;

type BrowserEmbedder = {
  tokenizer: (inputs: string[], options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  model: (inputs: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

let embedderPromise: Promise<BrowserEmbedder> | null = null;
let embedderKey = '';

async function getEmbeddingCapabilities(): Promise<{ runtimeAvailable: boolean; backend: 'onnx-wasm'; dtype: string }> {
  const { env } = await import('@huggingface/transformers');
  const wasmBackend = env.backends?.onnx?.wasm;
  if (!wasmBackend) {
    throw new Error('ONNX WASM backend is unavailable');
  }
  return {
    runtimeAvailable: true,
    backend: 'onnx-wasm',
    dtype: DEFAULT_WASM_DTYPE
  };
}

async function getBrowserEmbedder(model: string, revision: string): Promise<BrowserEmbedder> {
  const key = `${model}@${revision}`;
  if (embedderPromise && embedderKey === key) return embedderPromise;
  embedderKey = key;
  embedderPromise = (async () => {
    const { AutoTokenizer, AutoModel, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = true;
    env.remoteHost = 'https://huggingface.co';
    const wasmBackend = env.backends?.onnx?.wasm;
    if (!wasmBackend) {
      throw new Error('ONNX WASM backend is unavailable');
    }
    wasmBackend.wasmPaths = chrome.runtime.getURL('dist/beta/transformers/');
    wasmBackend.numThreads = 1;
    wasmBackend.simd = true;
    wasmBackend.proxy = false;
    const tokenizer = await AutoTokenizer.from_pretrained(model, { revision });
    const embedder = await AutoModel.from_pretrained(model, {
      revision,
      dtype: DEFAULT_WASM_DTYPE
    });
    return {
      tokenizer: (inputs, options) => tokenizer(inputs, options),
      model: (inputs) => embedder(inputs)
    };
  })();
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

async function computeBrowserEmbeddings(inputs: string[], prefix: string, model: string, revision: string): Promise<number[][]> {
  if (!inputs.length) return [];
  const { tokenizer, model: embedder } = await getBrowserEmbedder(model, revision);
  const tagged = inputs.map((text) => `${prefix}${text || ''}`);
  const encoded = await tokenizer(tagged, { padding: true, truncation: true });
  const output = await embedder(encoded);
  const sentenceEmbedding = (output as { sentence_embedding?: unknown }).sentence_embedding;
  if (!sentenceEmbedding) return [];
  return toList(sentenceEmbedding);
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
    const centroid = computeCentroid(page.chunks);
    if (!centroid) continue;
    index.push({
      url: page.url,
      centroid,
      timestamp: page.timestamp
    });
  }
  centroidIndex = index;
  return centroidIndex;
}

async function topPagesByCentroid(variationEmbeddings: number[][], topN: number): Promise<Array<{ url: string }>> {
  if (!Array.isArray(variationEmbeddings) || !variationEmbeddings.length) return [];
  const idx = await ensureCentroidIndex();
  const scored = idx.map((entry) => {
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

async function scoreChunksInPages(pageUrls: string[], variationEmbeddings: number[][], originalQuery: string): Promise<ScoreCandidate[]> {
  if (!variationEmbeddings.length) return [];
  const pages = await readAllPages();
  const urlSet = new Set(pageUrls);
  const candidates: ScoreCandidate[] = [];
  const normalizedQuery = (originalQuery || '').toLowerCase().trim();
  const tokens = normalizedQuery.split(/\W+/).filter((t) => t.length >= 3);

  for (const page of pages) {
    if (!urlSet.has(page.url)) continue;
    const titleLower = (page.title || '').toLowerCase();
    page.chunks.forEach((chunk, idx) => {
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
    topPagesByCentroid(variationEmbeddings, topN)
      .then((pages) => sendResponse({ pages }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_SCORE_CHUNKS') {
    const pageUrls = Array.isArray(message.pageUrls) ? (message.pageUrls as string[]) : [];
    const variationEmbeddings = Array.isArray(message.variationEmbeddings) ? (message.variationEmbeddings as number[][]) : [];
    const originalQuery = typeof message.originalQuery === 'string' ? message.originalQuery : '';
    scoreChunksInPages(pageUrls, variationEmbeddings, originalQuery)
      .then((candidates) => sendResponse({ candidates }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_EMBED') {
    const inputs = Array.isArray(message.inputs) ? (message.inputs as string[]) : [];
    const prefix = typeof message.prefix === 'string' ? message.prefix : '';
    const model = typeof message.model === 'string' ? message.model : 'onnx-community/embeddinggemma-300m-ONNX';
    const revision = typeof message.revision === 'string' ? message.revision : '75a84c732f1884df76bec365346230e32f582c82';
    computeBrowserEmbeddings(inputs, prefix, model, revision)
      .then((embeddings) => sendResponse({ embeddings }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_EMBED_CAPABILITIES') {
    getEmbeddingCapabilities()
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
