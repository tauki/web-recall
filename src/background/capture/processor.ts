import { embeddingSpaceKey } from '../../shared/config/index';
import type { CapturePayload } from './types';
import { embedPayloadChunks, getEmbeddingConfig } from '../embeddings/index';
import { whenStorageReady } from '../storage/index';
import { storageManager, type PageChunkRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';
import { queuePageSummary } from '../summaries/index';
import { log } from '../../shared/logger/index';
import { runAutomaticAi } from '../processing/automaticAi';

function normalizeChunk(text: string | undefined): string {
  if (typeof text === 'string') return text;
  return '';
}

export async function processCapturePayload(payload: CapturePayload, shouldContinue = () => true, signal?: AbortSignal): Promise<{ embeddingError?: string } | void> {
  if (!payload.url) return;
  await whenStorageReady();
  return runAutomaticAi(activeSignal => enrichCapturePayload(payload, shouldContinue, activeSignal), signal);
}

async function enrichCapturePayload(payload: CapturePayload, shouldContinue: () => boolean, signal: AbortSignal): Promise<{ embeddingError?: string } | void> {
  const key = embeddingSpaceKey(getEmbeddingConfig());
  let embeddings: number[][] = [];
  let embeddingError: string | undefined;
  try {
    embeddings = await embedPayloadChunks(payload, signal);
    if (key !== embeddingSpaceKey(getEmbeddingConfig())) throw new Error('Embedding settings changed during capture');
  } catch (err) {
    signal?.throwIfAborted();
    console.warn('[beta-background:capture] embedding request failed; retaining matching saved vectors', err);
    embeddingError = err instanceof Error ? err.message : String(err);
    embeddings = [];
  }
  if (!shouldContinue() || signal?.aborted) return;
  const items: PageChunkRecord[] = (payload.chunks || []).map((text, idx) => ({
    text: normalizeChunk(text),
    embedding: embeddings[idx] || [],
    embeddingKey: embeddings[idx]?.length ? key : undefined
  }));
  const hasEmbeddings = items.some((item) => Array.isArray(item.embedding) && item.embedding.length > 0);
  await storageManager.savePageRecord({
    url: payload.url,
    title: payload.title || payload.url,
    timestamp: payload.timestamp,
    text: payload.text || '',
    manual: Boolean(payload.manual),
    captureInfo: payload.captureInfo,
    chunks: items,
    lastEmbeddedAt: hasEmbeddings ? Date.now() : undefined
  }, { requireProcessing: true, expectedCaptureId: payload.captureId ?? null, preserveMissingEmbeddings: true, signal });
  signal.throwIfAborted();
  if (!shouldContinue()) return;
  console.info('[beta-background:capture] stored page snapshot', {
    url: payload.url,
    chunkCount: items.length
  });
  invalidateOffscreenIndex().catch((err) => console.warn('[beta-background:capture] offscreen invalidate failed', err));
  if (embeddingError) void log('warn', 'capture embeddings unavailable', { url: payload.url, phase: 'embeddings', error: embeddingError }).catch(() => {});
  void log('info', 'capture summary queued', { url: payload.url, phase: 'summary' }).catch(() => {});
  void queuePageSummary(payload.url).then(
    updated => { void log('info', 'capture summary finished', { url: payload.url, phase: 'summary', updated }).catch(() => {}); },
    error => {
      console.warn('[beta-background:capture] summary unavailable; saved text and vectors are retained', error);
      void log('warn', 'capture summary failed', { url: payload.url, phase: 'summary', error: error instanceof Error ? error.message : String(error) }).catch(() => {});
    }
  );
  return { embeddingError };
}
