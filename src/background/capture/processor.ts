import { embeddingSpaceKey } from '../../shared/config/index';
import type { CapturePayload } from './types';
import { embedPayloadChunks, getEmbeddingConfig } from '../embeddings/index';
import { whenStorageReady } from '../storage/index';
import { storageManager, type PageChunkRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';

function normalizeChunk(text: string | undefined): string {
  if (typeof text === 'string') return text;
  return '';
}

export async function processCapturePayload(payload: CapturePayload, shouldContinue = () => true): Promise<void> {
  if (!payload.url) return;
  await whenStorageReady();
  const key = embeddingSpaceKey(getEmbeddingConfig());
  let embeddings: number[][] = [];
  try {
    embeddings = await embedPayloadChunks(payload);
    if (key !== embeddingSpaceKey(getEmbeddingConfig())) throw new Error('Embedding settings changed during capture');
  } catch (err) {
    console.warn('[beta-background:capture] embedding request failed, storing without vectors', err);
    embeddings = [];
  }
  if (!shouldContinue()) return;
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
    chunks: items,
    lastEmbeddedAt: hasEmbeddings ? Date.now() : undefined
  }, { requireProcessing: true });
  console.info('[beta-background:capture] stored page snapshot', {
    url: payload.url,
    chunkCount: items.length
  });
  invalidateOffscreenIndex().catch((err) => console.warn('[beta-background:capture] offscreen invalidate failed', err));
}
