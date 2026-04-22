import type { CapturePayload } from '../capture/types';
import { ensureOffscreenDocument, sendOffscreenMessage } from '../offscreen/index';
import {
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig
} from '../../shared/config/index';

const DEFAULT_BASE_URL = DEFAULT_EMBEDDING_CONFIG.baseUrl;
const DEFAULT_MODEL = DEFAULT_EMBEDDING_CONFIG.model;
const DEFAULT_BROWSER_MODEL = DEFAULT_EMBEDDING_CONFIG.browserModel!;
const DEFAULT_BROWSER_REVISION = DEFAULT_EMBEDDING_CONFIG.browserRevision!;
const QUERY_PREFIX = 'task: search result | query: ';
const DOC_PREFIX = 'title: none | text: ';
const CONFIG_STORAGE_KEY = 'embeddingConfig';
const BROWSER_READY_KEY = 'browserEmbedReady';
const MAX_EMBED_RETRIES = 3;
const EMBED_TIMEOUT_MS = 10_000;

export type BrowserEmbedStatus = {
  ready: boolean;
  runtimeAvailable: boolean;
  model: string;
  revision: string;
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  code?: 'runtime_unavailable' | 'offscreen_unavailable' | 'download_failed' | 'resource_exhausted' | 'embed_failed' | 'unknown';
  lastError?: string;
  checkedAt?: string;
};

let currentConfig: EmbeddingConfig = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  provider: 'ollama',
  browserModel: DEFAULT_BROWSER_MODEL,
  browserRevision: DEFAULT_BROWSER_REVISION
};
let browserEmbedReady = false;
let browserEmbedStatus: BrowserEmbedStatus = {
  ready: false,
  runtimeAvailable: false,
  model: DEFAULT_BROWSER_MODEL,
  revision: DEFAULT_BROWSER_REVISION,
  state: 'idle'
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeBaseUrl(url: string | undefined): string {
  if (!url) return DEFAULT_BASE_URL;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function broadcastBrowserEmbedStatus(): void {
  try {
    chrome.runtime.sendMessage({ type: 'BROWSER_EMBED_STATUS', status: browserEmbedStatus });
  } catch {
    // best effort
  }
}

function setBrowserEmbedReady(value: boolean): void {
  browserEmbedReady = value;
  chrome.storage.local.set({ [BROWSER_READY_KEY]: value }).catch(() => {});
  browserEmbedStatus = {
    ...browserEmbedStatus,
    ready: value,
    state: value ? 'ready' : browserEmbedStatus.state === 'ready' ? 'idle' : browserEmbedStatus.state
  };
}

function updateBrowserEmbedStatus(
  partial: Partial<BrowserEmbedStatus>,
  options?: { broadcast?: boolean; model?: string; revision?: string }
): BrowserEmbedStatus {
  browserEmbedStatus = {
    ...browserEmbedStatus,
    model: options?.model || currentConfig.browserModel || DEFAULT_BROWSER_MODEL,
    revision: options?.revision || currentConfig.browserRevision || DEFAULT_BROWSER_REVISION,
    ...partial
  };
  if (options?.broadcast !== false) {
    broadcastBrowserEmbedStatus();
  }
  return browserEmbedStatus;
}

function classifyBrowserEmbedFailure(err: unknown): { code: NonNullable<BrowserEmbedStatus['code']>; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  if (normalized.includes('onnx wasm backend')) {
    return {
      code: 'runtime_unavailable',
      message: 'Browser embedding runtime is unavailable in this browser environment.'
    };
  }
  if (normalized.includes('offscreen')) {
    return {
      code: 'offscreen_unavailable',
      message: 'Browser embeddings require the offscreen document, but it could not be created.'
    };
  }
  if (
    normalized.includes('out of memory') ||
    normalized.includes('wasm memory') ||
    normalized.includes('memory access out of bounds')
  ) {
    return {
      code: 'resource_exhausted',
      message: 'Browser embeddings ran out of available memory or compute resources.'
    };
  }
  if (
    normalized.includes('huggingface') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('load failed')
  ) {
    return {
      code: 'download_failed',
      message: 'Browser embedding model download failed. Check connectivity and try downloading the model again.'
    };
  }
  return {
    code: 'embed_failed',
    message: message || 'Browser embedding failed.'
  };
}

export function getBrowserEmbedStatus(): BrowserEmbedStatus {
  return {
    ...browserEmbedStatus,
    ready: browserEmbedReady,
    model: currentConfig.browserModel || DEFAULT_BROWSER_MODEL,
    revision: currentConfig.browserRevision || DEFAULT_BROWSER_REVISION
  };
}

export async function probeBrowserEmbeddingRuntime(options?: { model?: string; revision?: string }): Promise<BrowserEmbedStatus> {
  const model = options?.model || currentConfig.browserModel || DEFAULT_BROWSER_MODEL;
  const revision = options?.revision || currentConfig.browserRevision || DEFAULT_BROWSER_REVISION;
  updateBrowserEmbedStatus(
    {
      state: 'checking',
      lastError: undefined,
      code: undefined
    },
    { model, revision }
  );
  try {
    await ensureOffscreenDocument();
    await sendOffscreenMessage<{ runtimeAvailable: boolean }>({ type: 'OFFSCREEN_EMBED_CAPABILITIES' });
    return updateBrowserEmbedStatus(
      {
        runtimeAvailable: true,
        checkedAt: new Date().toISOString(),
        state: browserEmbedReady ? 'ready' : 'idle',
        lastError: undefined,
        code: undefined
      },
      { model, revision }
    );
  } catch (err) {
    const failure = classifyBrowserEmbedFailure(err);
    return updateBrowserEmbedStatus(
      {
        runtimeAvailable: false,
        checkedAt: new Date().toISOString(),
        state: 'error',
        code: failure.code,
        lastError: failure.message,
        ready: false
      },
      { model, revision }
    );
  }
}

export async function prefetchBrowserEmbeddings(): Promise<void> {
  const status = await probeBrowserEmbeddingRuntime();
  if (!status.runtimeAvailable) {
    throw new Error(status.lastError || 'Browser embedding runtime is unavailable.');
  }
  if (browserEmbedReady) return;
  await computeBrowserEmbeddings(['prefetch'], DOC_PREFIX);
}

export function configureEmbeddings(): void {
  chrome.storage.local.get([CONFIG_STORAGE_KEY, BROWSER_READY_KEY], (result: Record<string, unknown>) => {
    const stored = result?.[CONFIG_STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      currentConfig = {
        baseUrl: sanitizeBaseUrl((stored as Partial<EmbeddingConfig>).baseUrl) || DEFAULT_BASE_URL,
        model: (stored as Partial<EmbeddingConfig>).model || DEFAULT_MODEL,
        provider: (stored as Partial<EmbeddingConfig>).provider === 'browser' ? 'browser' : 'ollama',
        browserModel: (stored as Partial<EmbeddingConfig>).browserModel || DEFAULT_BROWSER_MODEL,
        browserRevision: (stored as Partial<EmbeddingConfig>).browserRevision || DEFAULT_BROWSER_REVISION,
        updatedAt: (stored as Partial<EmbeddingConfig>).updatedAt
      };
    }
    browserEmbedReady = Boolean(result?.[BROWSER_READY_KEY]);
    browserEmbedStatus = {
      ...browserEmbedStatus,
      ready: browserEmbedReady,
      model: currentConfig.browserModel || DEFAULT_BROWSER_MODEL,
      revision: currentConfig.browserRevision || DEFAULT_BROWSER_REVISION,
      state: browserEmbedReady ? 'ready' : 'idle'
    };
  });
  try {
    chrome.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      const entry = changes[CONFIG_STORAGE_KEY];
      if (!entry || typeof entry.newValue !== 'object') return;
      const payload = entry.newValue as Partial<EmbeddingConfig>;
      currentConfig = {
        baseUrl: sanitizeBaseUrl(payload.baseUrl) || currentConfig.baseUrl,
        model: payload.model || currentConfig.model,
        provider: payload.provider === 'browser' ? 'browser' : 'ollama',
        browserModel: payload.browserModel || currentConfig.browserModel,
        browserRevision: payload.browserRevision || currentConfig.browserRevision,
        updatedAt: payload.updatedAt || new Date().toISOString()
      };
    });
  } catch (err) {
    console.warn('[beta-background:embeddings] unable to bind storage listener', err);
  }
}

export function getEmbeddingConfig(): EmbeddingConfig {
  return currentConfig;
}

export async function updateEmbeddingConfig(partial: Partial<EmbeddingConfig>): Promise<void> {
  const nextConfig: EmbeddingConfig = {
    baseUrl: sanitizeBaseUrl(partial.baseUrl) || currentConfig.baseUrl,
    model: partial.model || currentConfig.model,
    provider: partial.provider === 'browser' ? 'browser' : currentConfig.provider || 'ollama',
    browserModel: partial.browserModel || currentConfig.browserModel,
    browserRevision: partial.browserRevision || currentConfig.browserRevision,
    updatedAt: new Date().toISOString()
  };
  const browserModelChanged =
    nextConfig.browserModel !== currentConfig.browserModel ||
    nextConfig.browserRevision !== currentConfig.browserRevision;
  if (browserModelChanged) {
    setBrowserEmbedReady(false);
    updateBrowserEmbedStatus(
      {
        ready: false,
        state: 'idle',
        lastError: undefined,
        code: undefined
      },
      {
        model: nextConfig.browserModel || DEFAULT_BROWSER_MODEL,
        revision: nextConfig.browserRevision || DEFAULT_BROWSER_REVISION
      }
    );
  }
  if (nextConfig.provider === 'browser') {
    const status = await probeBrowserEmbeddingRuntime({
      model: nextConfig.browserModel || DEFAULT_BROWSER_MODEL,
      revision: nextConfig.browserRevision || DEFAULT_BROWSER_REVISION
    });
    if (!status.runtimeAvailable) {
      throw new Error(status.lastError || 'Browser embedding runtime is unavailable.');
    }
  }
  currentConfig = nextConfig;
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: currentConfig }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

async function callOllamaEmbed(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const endpoint = `${currentConfig.baseUrl}/api/embed`;
  for (let attempt = 1; attempt <= MAX_EMBED_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: currentConfig.model, input: inputs }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        throw new Error(`Embedding request failed: ${resp.status}`);
      }
      const data = await resp.json();
      if (Array.isArray(data.embeddings)) {
        return data.embeddings as number[][];
      }
      if (Array.isArray(data.embedding)) {
        return [data.embedding as number[]];
      }
      console.warn('[beta-background:embeddings] unexpected embed response shape', data);
      return [];
    } catch (err) {
      const delayMs = Math.min(2000 * attempt, 5000);
      console.warn('[beta-background:embeddings] embed attempt failed', { attempt, err });
      if (attempt === MAX_EMBED_RETRIES) {
        throw err;
      }
      await delay(delayMs);
    }
  }
  return [];
}

async function computeBrowserEmbeddings(chunks: string[], prefix = ''): Promise<number[][]> {
  const runtimeStatus = await probeBrowserEmbeddingRuntime();
  if (!runtimeStatus.runtimeAvailable) {
    throw new Error(runtimeStatus.lastError || 'Browser embedding runtime is unavailable.');
  }
  if (!browserEmbedReady) {
    updateBrowserEmbedStatus({ state: 'downloading' });
  }
  try {
    const response = await sendOffscreenMessage<{ embeddings?: number[][] }>({
      type: 'OFFSCREEN_EMBED',
      inputs: chunks,
      prefix,
      model: currentConfig.browserModel || DEFAULT_BROWSER_MODEL,
      revision: currentConfig.browserRevision || DEFAULT_BROWSER_REVISION
    });
    if (!browserEmbedReady) {
      setBrowserEmbedReady(true);
      updateBrowserEmbedStatus({
        runtimeAvailable: true,
        checkedAt: new Date().toISOString(),
        state: 'ready',
        lastError: undefined,
        code: undefined
      });
    }
    return Array.isArray(response.embeddings) ? response.embeddings : [];
  } catch (err) {
    const failure = classifyBrowserEmbedFailure(err);
    updateBrowserEmbedStatus({
      ready: false,
      runtimeAvailable: failure.code !== 'runtime_unavailable' && failure.code !== 'offscreen_unavailable',
      checkedAt: new Date().toISOString(),
      state: 'error',
      code: failure.code,
      lastError: failure.message
    });
    throw new Error(failure.message);
  }
}

export async function computeEmbeddingsForChunks(chunks: string[]): Promise<number[][]> {
  if (chunks.length === 0) return [];
  const sanitized = chunks.map((text) => text || '');
  if (currentConfig.provider === 'browser') {
    return computeBrowserEmbeddings(sanitized, DOC_PREFIX);
  }
  try {
    const batch = await callOllamaEmbed(sanitized);
    if (batch.length === sanitized.length) {
      return batch;
    }
  } catch (err) {
    console.warn('[beta-background:embeddings] batch call failed', err);
  }
  const results: number[][] = [];
  for (const text of sanitized) {
    if (!text) {
      results.push([]);
      continue;
    }
    try {
      const single = await callOllamaEmbed([text]);
      results.push(single[0] || []);
    } catch (err) {
      console.warn('[beta-background:embeddings] per-item call failed', err);
      results.push([]);
    }
  }
  return results;
}

export async function computeEmbeddingsForQueries(queries: string[]): Promise<number[][]> {
  if (currentConfig.provider === 'browser') {
    return computeBrowserEmbeddings(queries, QUERY_PREFIX);
  }
  return computeEmbeddingsForChunks(queries);
}

export async function embedPayloadChunks(payload: CapturePayload): Promise<number[][]> {
  return computeEmbeddingsForChunks(payload.chunks || []);
}
