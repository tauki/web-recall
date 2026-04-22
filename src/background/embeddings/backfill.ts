import { computeEmbeddingsForChunks } from './index';
import { storageManager, type PageChunkRecord, type PageRecord } from '../storage/manager';
import { log } from '../../shared/logger/index';

function needsEmbedding(page: PageRecord): boolean {
  return !Array.isArray(page.chunks) || page.chunks.some((chunk) => !Array.isArray(chunk.embedding) || chunk.embedding.length === 0);
}

export async function backfillMissingEmbeddings(
  limit = 50,
  force = false,
  urls?: string[]
): Promise<{ processed: number; updated: number; updatedUrls: string[] }> {
  const pages = await storageManager.listAllPages();
  const urlList = Array.isArray(urls) ? urls.filter((url) => typeof url === 'string' && url.length > 0) : [];
  const urlSet = urlList.length ? new Set(urlList) : null;
  const filtered = urlSet ? pages.filter((page) => urlSet.has(page.url)) : pages;
  const ordered = urlList.length
    ? urlList.map((url) => filtered.find((page) => page.url === url)).filter((page): page is PageRecord => Boolean(page))
    : filtered;
  const targets = ordered.filter((page) => (force ? true : needsEmbedding(page))).slice(0, limit);
  let updated = 0;
  const updatedUrls: string[] = [];
  for (const page of targets) {
    const texts = (page.chunks || []).map((chunk) => chunk.text || '');
    if (!texts.length) continue;
    try {
      const embeddings = await computeEmbeddingsForChunks(texts);
      const chunks: PageChunkRecord[] = texts.map((text, idx) => ({
        text,
        embedding: embeddings[idx] || []
      }));
      await storageManager.savePageRecord({
        ...page,
        chunks,
        lastEmbeddedAt: Date.now()
      });
      updated += 1;
      updatedUrls.push(page.url);
      await log('info', 'backfill embeddings updated page', { url: page.url, chunkCount: chunks.length });
    } catch (err) {
      await log('warn', 'backfill embeddings failed', { url: page.url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { processed: targets.length, updated, updatedUrls };
}
