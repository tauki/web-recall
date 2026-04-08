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

let currentConfig: EmbeddingConfig = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  provider: 'ollama',
  browserModel: DEFAULT_BROWSER_MODEL,
  browserRevision: DEFAULT_BROWSER_REVISION
};
let browserEmbedReady = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeBaseUrl(url: string | undefined): string {
  if (!url) return DEFAULT_BASE_URL;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function broadcastBrowserEmbedStatus(payload: { status: 'downloading' | 'ready' | 'error'; error?: string }): void {
  try {
    chrome.runtime.sendMessage({ type: 'BROWSER_EMBED_STATUS', ...payload });
  } catch {
    // best effort
  }
}

function setBrowserEmbedReady(value: boolean): void {
  browserEmbedReady = value;
  chrome.storage.local.set({ [BROWSER_READY_KEY]: value }).catch(() => {});
}

export function getBrowserEmbedStatus(): { ready: boolean; model: string; revision: string } {
  return {
    ready: browserEmbedReady,
    model: currentConfig.browserModel || DEFAULT_BROWSER_MODEL,
    revision: currentConfig.browserRevision || DEFAULT_BROWSER_REVISION
  };
}

export async function prefetchBrowserEmbeddings(): Promise<void> {
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
  currentConfig = {
    baseUrl: sanitizeBaseUrl(partial.baseUrl) || currentConfig.baseUrl,
    model: partial.model || currentConfig.model,
    provider: partial.provider === 'browser' ? 'browser' : currentConfig.provider || 'ollama',
    browserModel: partial.browserModel || currentConfig.browserModel,
    browserRevision: partial.browserRevision || currentConfig.browserRevision,
    updatedAt: new Date().toISOString()
  };
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
  if (!browserEmbedReady) {
    broadcastBrowserEmbedStatus({ status: 'downloading' });
  }
  await ensureOffscreenDocument();
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
      broadcastBrowserEmbedStatus({ status: 'ready' });
    }
    return Array.isArray(response.embeddings) ? response.embeddings : [];
  } catch (err) {
    if (!browserEmbedReady) {
      broadcastBrowserEmbedStatus({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

export async function computeEmbeddingsForChunks(chunks: string[]): Promise<number[][]> {
  if (chunks.length === 0) return [];
  const sanitized = chunks.map((text) => text || '');
  if (currentConfig.provider === 'browser') {
    try {
      return await computeBrowserEmbeddings(sanitized, DOC_PREFIX);
    } catch (err) {
      console.warn('[beta-background:embeddings] browser embed failed, falling back', err);
    }
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
    try {
      return await computeBrowserEmbeddings(queries, QUERY_PREFIX);
    } catch (err) {
      console.warn('[beta-background:embeddings] browser query embed failed, falling back', err);
    }
  }
  return computeEmbeddingsForChunks(queries);
}

export async function embedPayloadChunks(payload: CapturePayload): Promise<number[][]> {
  return computeEmbeddingsForChunks(payload.chunks || []);
}
