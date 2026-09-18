import { computeEmbeddingsForChunks, getEmbeddingConfig } from './index';
import { embeddingSpaceKey } from '../../shared/config/index';
import { storageManager, type PageRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';
import { log } from '../../shared/logger/index';

export type BackfillProgress = { url: string; status: 'running' | 'complete' | 'error'; completed: number; total: number; error?: string };

export async function backfillMissingEmbeddings(
  limit = 50,
  force = false,
  urls?: string[],
  onProgress?: (progress: BackfillProgress) => void
): Promise<{ processed: number; updated: number; failed: number; updatedUrls: string[] }> {
  const pages = await storageManager.listAllPages();
  const ordered = urls === undefined ? pages : [...new Set(urls)].map((url) => pages.find((page) => page.url === url))
    .filter((page): page is PageRecord => Boolean(page));
  const targets = ordered.filter((page) => page.chunks?.some((chunk) => force || !chunk.embedding?.length))
    .slice(0, Math.max(0, Math.floor(limit)));
  const updatedUrls: string[] = [];
  let failed = 0;
  let completed = 0;
  const report = (progress: BackfillProgress): void => { try { onProgress?.(progress); } catch { /* UI progress must not fail persistence. */ } };
  for (const page of targets) {
    report({ url: page.url, status: 'running', completed, total: targets.length });
    const indices = page.chunks.map((_, index) => index).filter((index) => force || !page.chunks[index]!.embedding?.length);
    const key = embeddingSpaceKey(getEmbeddingConfig());
    try {
      const embeddings = await computeEmbeddingsForChunks(indices.map((index) => page.chunks[index]!.text));
      if (key !== embeddingSpaceKey(getEmbeddingConfig())) throw new Error('Embedding settings changed; retry this page.');
      if (embeddings.length !== indices.length || embeddings.some((vector) => !vector.length || !vector.every(Number.isFinite)) ||
          embeddings.some((vector) => vector.length !== embeddings[0]!.length)) {
        throw new Error('Incomplete embedding response; existing vectors were preserved.');
      }
      // Do not resurrect a deleted page or overwrite a capture completed during inference.
      const latest = await storageManager.getPageRecord(page.url);
      if (!latest || latest.updatedAt !== page.updatedAt) throw new Error('Page changed during backfill; retry with the latest capture.');
      const chunks = page.chunks.map((chunk) => ({ ...chunk }));
      indices.forEach((index, offset) => { chunks[index] = { ...chunks[index]!, embedding: embeddings[offset]!, embeddingKey: key }; });
      await storageManager.savePageRecord({ ...page, chunks, lastEmbeddedAt: Date.now() }, { expectedUpdatedAt: page.updatedAt });
      await invalidateOffscreenIndex();
      updatedUrls.push(page.url);
      report({ url: page.url, status: 'complete', completed: ++completed, total: targets.length });
      await log('info', 'backfill embeddings updated page', { url: page.url, chunkCount: indices.length }).catch(() => {});
    } catch (err) {
      failed += 1;
      report({ url: page.url, status: 'error', completed: ++completed, total: targets.length, error: err instanceof Error ? err.message : String(err) });
      await log('warn', 'backfill embeddings failed', { url: page.url, error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    }
  }
  return { processed: targets.length, updated: updatedUrls.length, failed, updatedUrls };
}
