import { storageManager, type PageRecord } from '../storage/manager';
import { getCalibrationSnapshot } from '../calibration/index';
import { computeEmbeddingsForQueries } from '../embeddings/index';
import { ensureOffscreenDocument, sendOffscreenMessage } from '../offscreen/index';
import { callChat, callChatJson, getChatConfig } from '../providers/chat';
import { getSettings } from '../settings/index';

export type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  timestamp: number;
  score: number;
  weightedScore?: number;
  recencyWeight?: number;
  containsExact?: boolean;
  chunkIndex?: number;
  crossScore?: number;
  hitsFromPage?: number;
};

export type SearchOptions = {
  rewrite?: boolean;
  rerank?: boolean;
};

type OffscreenTopPageResponse = { pages?: Array<{ url: string }> };
type OffscreenScoreResponse = {
  candidates?: Array<
    Pick<SearchResult, 'url' | 'title' | 'snippet' | 'chunkIndex' | 'score' | 'weightedScore' | 'recencyWeight' | 'containsExact' | 'hitsFromPage'> & {
      timestamp?: number;
      crossScore?: number;
    }
  >;
};

const MIN_LLM_KEEP_SCORE = 2;

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function textFallbackScore(page: PageRecord, tokens: string[]): { score: number; snippet: string } {
  if (!tokens.length) {
    return { score: 0, snippet: '' };
  }
  const lowerTitle = (page.title || page.url).toLowerCase();
  const lowerText = (page.text || '').toLowerCase();
  let score = 0;
  let snippet = '';

  for (const token of tokens) {
    if (lowerTitle.includes(token)) {
      score += 4;
    }
    if (lowerText.includes(token) && page.text) {
      score += 2;
      const idx = lowerText.indexOf(token);
      if (idx >= 0 && !snippet) {
        snippet = page.text.slice(Math.max(0, idx - 80), idx + 120);
      }
    }
    if (!snippet && page.chunks) {
      for (const chunk of page.chunks) {
        const text = chunk.text || '';
        const lowerChunk = text.toLowerCase();
        if (lowerChunk.includes(token)) {
          score += 1;
          snippet = text;
          break;
        }
      }
    }
  }

  const recencyBoost = 1 + Math.max(0, Date.now() - page.timestamp) / (1000 * 60 * 60 * 24 * 30);
  score = score / recencyBoost;

  if (!snippet && page.chunks?.length) {
    snippet = page.chunks[0]?.text || '';
  }
  if (!snippet) {
    snippet = page.text?.slice(0, 200) || '';
  }

  const calibration = getCalibrationSnapshot();
  const simWeight = 0.5 + calibration.wSim;
  return { score: score * simWeight, snippet };
}

async function fallbackSearch(query: string, limit: number): Promise<SearchResult[]> {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const pages = await storageManager.listRecentPages(200);
  const scored: SearchResult[] = pages
    .map((page) => {
      const { score, snippet } = textFallbackScore(page, tokens);
      return {
        url: page.url,
        title: page.title || page.url,
        snippet,
        timestamp: page.timestamp,
        score
      };
    })
    .filter((entry) => entry.score > 0.1);
  scored.sort((a, b) => b.score - a.score);
  const calibration = getCalibrationSnapshot();
  const dynamicLimit = Math.max(1, Math.min(50, Math.round(limit * (1 + calibration.wLLM))));
  return scored.slice(0, dynamicLimit);
}

function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function chooseBetter(a: SearchResult, b: SearchResult): SearchResult {
  const scoreA = typeof a.crossScore === 'number' ? a.crossScore : a.weightedScore ?? a.score;
  const scoreB = typeof b.crossScore === 'number' ? b.crossScore : b.weightedScore ?? b.score;
  return scoreB > scoreA ? b : a;
}

function toSearchResult(res: Partial<SearchResult> & { url: string }): SearchResult {
  return {
    url: res.url,
    title: res.title || res.url,
    snippet: res.snippet || '',
    timestamp: typeof res.timestamp === 'number' ? res.timestamp : Date.now(),
    score: res.score ?? 0,
    weightedScore: res.weightedScore,
    recencyWeight: res.recencyWeight,
    containsExact: res.containsExact,
    chunkIndex: res.chunkIndex,
    crossScore: res.crossScore,
    hitsFromPage: res.hitsFromPage
  };
}

function dedupeByUrl(results: Array<Partial<SearchResult> & { url: string }>): SearchResult[] {
  const grouped = new Map<string, SearchResult>();
  for (const res of results) {
    const normalized = toSearchResult(res);
    const key = canonicalizeUrl(normalized.url);
    if (!grouped.has(key)) {
      grouped.set(key, { ...normalized, hitsFromPage: 1, url: key });
      continue;
    }
    const existing = grouped.get(key)!;
    const better = chooseBetter(existing, normalized);
    const count = (existing.hitsFromPage || 1) + 1;
    grouped.set(key, { ...better, hitsFromPage: count });
  }
  return Array.from(grouped.values());
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function enrichRerankCandidates(
  candidates: NonNullable<OffscreenScoreResponse['candidates']>
): Promise<NonNullable<OffscreenScoreResponse['candidates']>> {
  const enriched = await Promise.all(
    candidates.map(async (candidate) => {
      const record = await storageManager.getPageRecord(candidate.url);
      const richerExcerpt = (
        record?.chunks?.find((chunk) => (chunk.text || '').trim())?.text ||
        record?.text ||
        candidate.snippet ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      return {
        ...candidate,
        snippet: richerExcerpt || candidate.snippet || '',
        title: record?.title || candidate.title || candidate.url,
        hitsFromPage: candidate.hitsFromPage,
        containsExact: candidate.containsExact,
        recencyWeight: candidate.recencyWeight
      };
    })
  );
  return enriched;
}

async function generateQueryVariations(query: string, n = 3, options: SearchOptions = {}): Promise<string[]> {
  const variations = [query];
  const settings = await getSettings();
  const rewriteEnabled = typeof options.rewrite === 'boolean' ? options.rewrite : settings.queryRewrite !== false;
  if (!rewriteEnabled) return variations;
  try {
    const config = await getChatConfig();
    const body = {
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'Rewrite the search query into distinct semantic variations. Return each variation on a separate line without numbering.'
        },
        {
          role: 'user',
          content: `Query: ${query}\nCount: ${n}\nVariations:`
        }
      ],
      stream: false
    };
    const response = await callChat(config, body);
    const content = response.message?.content?.trim();
    if (!content) return variations;
    content
      .split('\n')
      .map((line: string) => line.replace(/^\d+[.)-]\s*/, '').trim())
      .filter(Boolean)
      .forEach((line: string) => {
        if (!variations.includes(line)) variations.push(line);
      });
  } catch {
    // fallback to original
  }
  return variations.slice(0, Math.max(1, n + 1));
}

function parseSingleRerankScore(content: string): number | null {
  if (!content) return null;
  const normalized = content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const direct = Number.parseFloat(normalized);
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.min(10, direct));
  }
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[0]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(10, parsed));
}

function parseBatchRerankScores(content: string, candidateIds: number[]): Map<number, number> {
  const scores = new Map<number, number>();
  if (!content) return scores;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      parsed.forEach((entry, index) => {
        if (entry && typeof entry === 'object') {
          const obj = entry as { id?: unknown; score?: unknown };
          const id = typeof obj.id === 'number' ? obj.id : candidateIds[index];
          const score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
          if (typeof id === 'number' && candidateIds.includes(id) && Number.isFinite(score)) {
            scores.set(id, Math.max(0, Math.min(10, score)));
          }
        }
      });
      return scores;
    }
    if (parsed && typeof parsed === 'object') {
      for (const [rawId, rawScore] of Object.entries(parsed as Record<string, unknown>)) {
        const id = Number(rawId);
        const score = typeof rawScore === 'number' ? rawScore : Number(rawScore);
        if (candidateIds.includes(id) && Number.isFinite(score)) {
          scores.set(id, Math.max(0, Math.min(10, score)));
        }
      }
    }
  } catch {
    return scores;
  }
  return scores;
}

async function scoreCandidateWithLLM(
  query: string,
  title: string,
  snippet: string,
  config: Awaited<ReturnType<typeof getChatConfig>>
): Promise<number | null> {
  const body = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: 'Score how relevant the passage is to the query from 0 to 10. Respond with only a single number.'
      },
      {
        role: 'user',
        content: `Query: ${query}\nTitle: ${title || '(untitled)'}\nPassage: ${snippet || '(empty)'}\n\nScore:`
      }
    ],
    stream: false,
    options: { temperature: 0 }
  };
  const response = await callChat(config, body);
  return parseSingleRerankScore(response.message?.content || '');
}

async function batchScoreCandidatesWithLLM(
  query: string,
  candidates: NonNullable<OffscreenScoreResponse['candidates']>,
  config: Awaited<ReturnType<typeof getChatConfig>>
): Promise<Map<number, number>> {
  const body = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          'Score each candidate for relevance to the query from 0 to 10. Return JSON only. The JSON must be an object whose keys are candidate ids and whose values are numeric scores. Example: {"1": 8.5, "2": 3.0}'
      },
      {
        role: 'user',
        content: `Query: ${query}\n\nCandidates:\n${candidates
          .map(
            (candidate, index) =>
              `${index + 1}. Title: ${candidate.title || '(untitled)'}\nDomain: ${extractDomain(candidate.url)}\nPassage: ${candidate.snippet || '(empty)'}\nSignals: containsExact=${candidate.containsExact ? 'yes' : 'no'}, hitsFromPage=${candidate.hitsFromPage || 1}, recencyWeight=${typeof candidate.recencyWeight === 'number' ? candidate.recencyWeight.toFixed(3) : 'n/a'}`
          )
          .join('\n\n')}\n\nReturn JSON only.\nSchema: {"1": 0-10, "2": 0-10}\nExample: {"1": 8.5, "2": 3.0}`
      }
    ],
    stream: false,
    options: { temperature: 0 }
  };
  const parsed = await callChatJson<unknown>(config, body);
  return parseBatchRerankScores(
    parsed ? JSON.stringify(parsed) : '',
    candidates.map((_, index) => index + 1)
  );
}

async function rerankWithCrossEncoder(
  query: string,
  candidates: OffscreenScoreResponse['candidates'],
  options: SearchOptions = {}
): Promise<NonNullable<OffscreenScoreResponse['candidates']>> {
  const pool = candidates ? candidates.slice() : [];
  if (!pool.length) return [];
  const settings = await getSettings();
  const rerankEnabled = typeof options.rerank === 'boolean' ? options.rerank : settings.searchRerank !== false;
  if (!rerankEnabled) return pool;
  const limited = pool.slice(0, Math.min(12, pool.length));
  try {
    const config = await getChatConfig();
    const enriched = await enrichRerankCandidates(limited);
    const batchScores = await batchScoreCandidatesWithLLM(query, enriched, config);
    if (batchScores.size) {
      limited.forEach((candidate, index) => {
        const score = batchScores.get(index + 1);
        if (typeof score === 'number') {
          candidate.crossScore = score;
        }
      });
    } else {
      for (const candidate of limited.slice(0, 4)) {
        const score = await scoreCandidateWithLLM(query, candidate.title || '', candidate.snippet || '', config);
        if (score !== null) {
          candidate.crossScore = score;
        }
      }
    }
  } catch (err) {
    console.warn('[beta-background:search] cross-encoder rerank failed', err);
  }
  const merged = [...limited, ...pool.slice(limited.length)];
  const filtered = merged.filter((candidate) => typeof candidate.crossScore !== 'number' || candidate.crossScore >= MIN_LLM_KEEP_SCORE);
  filtered.sort((a, b) => {
    const ca = typeof a.crossScore === 'number' ? 100 + a.crossScore : a.weightedScore ?? a.score ?? 0;
    const cb = typeof b.crossScore === 'number' ? 100 + b.crossScore : b.weightedScore ?? b.score ?? 0;
    return cb - ca;
  });
  return filtered;
}

async function semanticSearchInternal(query: string, limit: number, options: SearchOptions = {}): Promise<SearchResult[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const variations = await generateQueryVariations(normalized, 3, options);
  const embeddings = await computeEmbeddingsForQueries(variations).catch(() => []);
  const validEmbeddings = embeddings.filter((emb) => Array.isArray(emb) && emb.length);
  if (!validEmbeddings.length) {
    return fallbackSearch(normalized, limit);
  }

  try {
    await ensureOffscreenDocument();
    const topResp = await sendOffscreenMessage<OffscreenTopPageResponse>({
      type: 'OFFSCREEN_TOP_PAGES',
      variationEmbeddings: validEmbeddings,
      topN: Math.max(limit * 3, 30)
    });
    const pageUrls = (topResp.pages || []).map((p) => p.url);
    if (!pageUrls.length) return fallbackSearch(normalized, limit);
    const chunkResp = await sendOffscreenMessage<OffscreenScoreResponse>({
      type: 'OFFSCREEN_SCORE_CHUNKS',
      pageUrls,
      variationEmbeddings: validEmbeddings,
      originalQuery: normalized
    });
    const candidates = chunkResp.candidates || [];
    candidates.sort((a, b) => {
      const aw = a.weightedScore ?? a.score ?? 0;
      const bw = b.weightedScore ?? b.score ?? 0;
      return bw - aw;
    });
    const dedupedCandidates = dedupeByUrl(candidates);
    const reranked = await rerankWithCrossEncoder(normalized, dedupedCandidates, options);
    const calibration = getCalibrationSnapshot();
    const dynamicLimit = Math.max(1, Math.min(50, Math.round(limit * (1 + calibration.wLLM))));
    return reranked.slice(0, dynamicLimit).map((cand) => ({
      url: cand.url,
      title: cand.title || cand.url,
      snippet: cand.snippet || '',
      timestamp: cand.timestamp || Date.now(),
      score: cand.score ?? 0,
      weightedScore: cand.weightedScore,
      recencyWeight: cand.recencyWeight,
      containsExact: cand.containsExact,
      chunkIndex: cand.chunkIndex,
      crossScore: cand.crossScore,
      hitsFromPage: cand.hitsFromPage
    }));
  } catch (err) {
    console.warn('[beta-background:search] offscreen search failed, falling back', err);
    const fallback = await fallbackSearch(normalized, limit);
    return dedupeByUrl(fallback).slice(0, limit);
  }
}

export async function searchStoredPages(query: string, limit = 10, options: SearchOptions = {}): Promise<SearchResult[]> {
  return semanticSearchInternal(query, limit, options);
}
