import { computeEmbeddingsForChunks, getEmbeddingConfig } from './index';
import { embeddingSpaceKey } from '../../shared/config/index';
import { storageManager, type PageRecord } from '../storage/manager';
import { invalidateOffscreenIndex } from '../offscreen/index';
import { log } from '../../shared/logger/index';
import { queuePageSummary } from '../summaries/index';

export type BackfillProgress = { url: string; status: 'running' | 'complete' | 'error'; completed: number; total: number; error?: string; phase?: 'summaries' };
export type BackfillFailure = { url: string; phase: 'embeddings' | 'summaries'; error: string };
export type BackfillResult = { processed: number; updated: number; failed: number; updatedUrls: string[]; summariesUpdated: number; summariesFailed: number; failures: BackfillFailure[] };

export async function backfillMissingEmbeddings(
  limit = 50,
  force = false,
  urls?: string[],
  onProgress?: (progress: BackfillProgress) => void,
  signal?: AbortSignal,
  createSummaries = false,
  regenerateSummaries = false
): Promise<BackfillResult> {
  signal?.throwIfAborted();
  createSummaries = createSummaries || regenerateSummaries;
  const ordered = urls === undefined ? await storageManager.listAllPages() : (await Promise.all([...new Set(urls)].map(url => storageManager.getPageRecord(url))))
    .filter((page): page is PageRecord => Boolean(page));
  const eligible = ordered.filter(page => page.chunks?.some(chunk => force || !chunk.embedding?.length) || (createSummaries && (regenerateSummaries || !page.summary?.trim())))
    .slice(0, Math.max(0, Math.floor(limit)));
  const targets = eligible.filter(page => page.chunks?.some(chunk => force || !chunk.embedding?.length));
  const updatedUrls: string[] = [];
  const failures: BackfillFailure[] = [];
  let failed = 0;
  let completed = 0;
  const report = (progress: BackfillProgress): void => { try { onProgress?.(progress); } catch { /* UI progress must not fail persistence. */ } };
  for (const page of targets) {
    signal?.throwIfAborted();
    report({ url: page.url, status: 'running', completed, total: targets.length });
    const indices = page.chunks.map((_, index) => index).filter((index) => force || !page.chunks[index]!.embedding?.length);
    const key = embeddingSpaceKey(getEmbeddingConfig());
    try {
      const embeddings = await computeEmbeddingsForChunks(indices.map((index) => page.chunks[index]!.text), signal);
      signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      await storageManager.savePageRecord({ ...page, chunks, lastEmbeddedAt: Date.now() }, { expectedUpdatedAt: page.updatedAt });
      await invalidateOffscreenIndex();
      updatedUrls.push(page.url);
      report({ url: page.url, status: 'complete', completed: ++completed, total: targets.length });
      await log('info', 'backfill embeddings updated page', { url: page.url, chunkCount: indices.length }).catch(() => {});
    } catch (err) {
      signal?.throwIfAborted();
      failed += 1;
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ url: page.url, phase: 'embeddings', error });
      report({ url: page.url, status: 'error', completed: ++completed, total: targets.length, error });
      await log('warn', 'backfill embeddings failed', { url: page.url, error }).catch(() => {});
    }
  }
  let summariesUpdated = 0, summariesFailed = 0;
  if (createSummaries) {
    const missing = eligible.filter(page => regenerateSummaries || !page.summary?.trim());
    let summarized = 0;
    for (const page of missing) {
      signal?.throwIfAborted();
      report({ url: page.url, status: 'running', completed: summarized, total: missing.length, phase: 'summaries' });
      try {
        if (await queuePageSummary(page.url, signal, regenerateSummaries)) summariesUpdated++;
        report({ url: page.url, status: 'complete', completed: ++summarized, total: missing.length, phase: 'summaries' });
      }
      catch (error) {
        signal?.throwIfAborted(); summariesFailed++;
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ url: page.url, phase: 'summaries', error: reason });
        report({ url: page.url, status: 'error', completed: ++summarized, total: missing.length, phase: 'summaries', error: reason });
        await log('warn', 'backfill summary unavailable', { url: page.url, error: reason }).catch(() => {});
      }
    }
  }
  return { processed: targets.length, updated: updatedUrls.length, failed, updatedUrls, summariesUpdated, summariesFailed, failures };
}
