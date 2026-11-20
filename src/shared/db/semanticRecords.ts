import type { PageRecord } from './index';
import { computeCentroid, cosineSimilarity, recencyWeight } from '../vectors';

type Centroid = { url: string; centroid: number[]; timestamp: number };
type ChunkScore = { url: string; title: string; snippet: string; chunkIndex: number; score: number; weightedScore: number;
  recencyWeight: number; containsExact: boolean; timestamp: number; versionId?: string };

function snippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 200) return trimmed;
  const cut = trimmed.slice(0, 200), boundary = cut.lastIndexOf(' ');
  return `${(boundary > 120 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:!-]+$/u, '')}…`;
}

function similarity(vector: number[], queries: number[][]): number {
  let best = -Infinity;
  for (const query of queries) best = Math.max(best, cosineSimilarity(query, vector));
  return best;
}

export class SemanticRecords {
  private cached?: { key: string; revision: number; centroids: Centroid[] };

  invalidate(): void { this.cached = undefined; }

  top(pages: () => Iterable<PageRecord>, revision: number, queries: number[][], limit: number, key: string) {
    if (!key || !queries.length) return [];
    if (this.cached?.key !== key || this.cached?.revision !== revision) {
      const centroids: Centroid[] = [];
      for (const page of pages()) {
        const centroid = computeCentroid(page.chunks.filter(chunk => chunk.embeddingKey === key));
        if (centroid) centroids.push({ url: page.url, timestamp: page.timestamp, centroid });
      }
      this.cached = { key, revision, centroids };
    }
    return this.cached.centroids.map(({ url, centroid, timestamp }) => ({ url, score: similarity(centroid, queries) * recencyWeight(timestamp) }))
      .sort((left, right) => right.score - left.score).slice(0, limit).map(({ url }) => ({ url }));
  }

  chunks(pages: Iterable<PageRecord | undefined>, queries: number[][], question: string, key: string) {
    if (!key || !queries.length) return [];
    const query = question.trim().toLowerCase(), tokens = query.split(/\W+/u).filter(word => word.length >= 3);
    const results: Array<ChunkScore & { hitsFromPage: number }> = [];
    for (const page of pages) {
      if (!page) continue;
      const title = page.title || page.url, titleLower = title.toLowerCase(), recency = recencyWeight(page.timestamp);
      let best: ChunkScore | undefined;
      let hitsFromPage = 0;
      for (const [chunkIndex, chunk] of page.chunks.entries()) {
        if (chunk.embeddingKey !== key || !Array.isArray(chunk.embedding) || !chunk.embedding.length) continue;
        hitsFromPage++;
        const text = (chunk.text || '').toLowerCase();
        const score = similarity(chunk.embedding, queries), exact = query.length >= 3 && text.includes(query);
        const token = !exact && tokens.some(word => text.includes(word) || titleLower.includes(word));
        const weightedScore = score * 0.75 + (exact ? 0.12 : 0) + (token ? 0.05 : 0) + recency * 0.05;
        if (!best || weightedScore > best.weightedScore) best = { url: page.url, title, snippet: snippet(chunk.text || ''), chunkIndex, score,
          weightedScore, recencyWeight: recency, containsExact: exact, timestamp: page.timestamp, versionId: page.versionId };
      }
      if (best) results.push({ ...best, hitsFromPage });
    }
    return results;
  }
}
