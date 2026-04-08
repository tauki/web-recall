import type { CapturePayload } from './types';
import { embedPayloadChunks } from '../embeddings/index';
import { whenStorageReady } from '../storage/index';
import { storageManager, type PageChunkRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';

function normalizeChunk(text: string | undefined): string {
  if (typeof text === 'string') return text;
  return '';
}

export async function processCapturePayload(payload: CapturePayload): Promise<void> {
  if (!payload.url) return;
  await whenStorageReady();
  let embeddings: number[][] = [];
  try {
    embeddings = await embedPayloadChunks(payload);
  } catch (err) {
    console.warn('[beta-background:capture] embedding request failed, storing without vectors', err);
    embeddings = [];
  }
  const items: PageChunkRecord[] = (payload.chunks || []).map((text, idx) => ({
    text: normalizeChunk(text),
    embedding: embeddings[idx] || []
  }));
  await storageManager.savePageRecord({
    url: payload.url,
    title: payload.title || payload.url,
    timestamp: payload.timestamp,
    text: payload.text || '',
    manual: Boolean(payload.manual),
    chunks: items,
    lastEmbeddedAt: Date.now()
  });
  console.info('[beta-background:capture] stored page snapshot', {
    url: payload.url,
    chunkCount: items.length
  });
  invalidateOffscreenIndex().catch((err) => console.warn('[beta-background:capture] offscreen invalidate failed', err));
}
