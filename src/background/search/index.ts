import { abortable } from '../../shared/abort';
import { CHAT_PROVIDER_DISABLED, embeddingSpaceKey } from '../../shared/config/index';
import { storageManager, type PageRecord } from '../storage/manager';
import { computeEmbeddingsForQueries, getEmbeddingConfig } from '../embeddings/index';
import { ensureOffscreenDocument, sendOffscreenMessage } from '../offscreen/index';
import { callChat, callChatJson, getChatConfig } from '../providers/chat';
import { getSettings } from '../settings/index';
import type { TextMatch } from '../../shared/textSearch';
import { matchesSearchFilters, readSearchFilters, type SearchFilters } from '../../shared/searchFilters';
import { pageContent } from '../../shared/pageContent';
import { runAutomaticAi } from '../processing/automaticAi';

export type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  timestamp: number;
  versionId?: string;
  score: number;
  weightedScore?: number;
  recencyWeight?: number;
  containsExact?: boolean;
  chunkIndex?: number;
  crossScore?: number;
  hitsFromPage?: number;
  textMatch?: boolean;
  match?: TextMatch;
};

export type SearchOptions = {
  explicitModelUse?: boolean;
  scopeUrls?: string[];
  signal?: AbortSignal;
  rewrite?: boolean;
  rerank?: boolean;
  onTextResults?: (results: SearchResult[]) => void;
  filters?: SearchFilters;
};

type OffscreenTopPageResponse = { pages?: Array<{ url: string }> };
type OffscreenScoreResponse = {
  candidates?: Array<
    Pick<SearchResult, 'url' | 'title' | 'snippet' | 'chunkIndex' | 'score' | 'weightedScore' | 'recencyWeight' | 'containsExact' | 'hitsFromPage' | 'textMatch' | 'match' | 'versionId'> & {
      timestamp?: number;
      crossScore?: number;
    }
  >;
};

const MIN_LLM_KEEP_SCORE = 2;

function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
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
    versionId: res.versionId,
    score: res.score ?? 0,
    weightedScore: res.weightedScore,
    recencyWeight: res.recencyWeight,
    containsExact: res.containsExact,
    chunkIndex: res.chunkIndex,
    crossScore: res.crossScore,
    hitsFromPage: res.hitsFromPage,
    textMatch: res.textMatch,
    match: res.match
  };
}

function dedupeByUrl(results: Array<Partial<SearchResult> & { url: string }>): SearchResult[] {
  const grouped = new Map<string, SearchResult>();
  for (const res of results) {
    const normalized = toSearchResult(res);
    const key = canonicalizeUrl(normalized.url);
    const matches = normalized.hitsFromPage || 1;
    if (!grouped.has(key)) {
      grouped.set(key, { ...normalized, hitsFromPage: matches });
      continue;
    }
    const existing = grouped.get(key)!;
    const better = chooseBetter(existing, normalized);
    const count = (existing.hitsFromPage || 1) + matches;
    grouped.set(key, { ...better, hitsFromPage: count });
  }
  return Array.from(grouped.values());
}

function mergeRetrievalResults(semantic: SearchResult[], text: SearchResult[]): SearchResult[] {
  // Reciprocal rank fusion combines rankings without treating term counts as cosine scores.
  // Text wins ties so an exact text hit stays visible during partial re-embedding.
  const results = new Map<string, { result: SearchResult; rank: number }>();
  for (const list of [dedupeByUrl(text), semantic]) {
    list.forEach((result, index) => {
      const key = canonicalizeUrl(result.url);
      const existing = results.get(key);
      const rank = 1 / (60 + index + 1);
      if (existing) {
        const sameVersion = existing.result.versionId || result.versionId ? existing.result.versionId === result.versionId : existing.result.timestamp === result.timestamp;
        if (!sameVersion) return;
        existing.rank += rank;
        if (existing.result.url === result.url) {
          existing.result = { ...existing.result, score: result.score, weightedScore: result.weightedScore, recencyWeight: result.recencyWeight, crossScore: result.crossScore, hitsFromPage: result.hitsFromPage || existing.result.hitsFromPage };
        }
      } else results.set(key, { result, rank });
    });
  }
  return [...results.values()].sort((a, b) => b.rank - a.rank).map(entry => entry.result);
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function resolveSavedVersion(record: PageRecord | undefined, candidate: { versionId?: string; timestamp?: number }) {
  if (!record || !candidate.versionId && candidate.timestamp !== undefined && !Number.isFinite(candidate.timestamp)) return undefined;
  const matches = [record, ...(record.versions || [])].filter(version => candidate.versionId ? version.versionId === candidate.versionId : candidate.timestamp === undefined ? version === record : version.timestamp === candidate.timestamp || version.firstCapturedAt === candidate.timestamp);
  if (matches.length > 1 && matches.some(version => pageContent(version) !== pageContent(matches[0]!) || version.title !== matches[0]!.title)) return undefined;
  return matches[0];
}

async function enrichRerankCandidates(
  candidates: NonNullable<OffscreenScoreResponse['candidates']>,
  filters?: SearchFilters
): Promise<NonNullable<OffscreenScoreResponse['candidates']>> {
  const enriched = await Promise.all(
    candidates.map(async (candidate) => {
      const record = await storageManager.getPageRecord(candidate.url);
      const version = resolveSavedVersion(record, candidate);
      if (!version || filters && Object.keys(filters).length && !matchesSearchFilters({ url: candidate.url, timestamp: version.timestamp }, filters)) return null;
      const richerExcerpt = (
        (typeof candidate.chunkIndex === 'number' ? version.chunks?.[candidate.chunkIndex]?.text : '') ||
        candidate.snippet ||
        version.text ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      return {
        ...candidate,
        snippet: richerExcerpt || candidate.snippet || '',
        title: version.title || candidate.url,
        timestamp: version.timestamp,
        versionId: version.versionId,
        hitsFromPage: candidate.hitsFromPage,
        containsExact: candidate.containsExact,
        recencyWeight: candidate.recencyWeight
      };
    })
  );
  return enriched.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
}

async function retainFilteredResults(results: Array<Partial<SearchResult> & { url: string }>, filters: SearchFilters, signal?: AbortSignal): Promise<SearchResult[]> {
  const byUrl = new Map<string, Array<{ hit: typeof results[number]; index: number }>>();
  results.forEach((hit, index) => { const entries = byUrl.get(hit.url) || []; entries.push({ hit, index }); byUrl.set(hit.url, entries); });
  const checked: Array<SearchResult | null> = Array(results.length).fill(null);
  await storageManager.scanSearchPages(record => {
    for (const { hit, index } of byUrl.get(record.url) || []) {
      const version = resolveSavedVersion(record, hit);
      if (version && matchesSearchFilters({ url: hit.url, timestamp: version.timestamp }, filters)) checked[index] = { ...toSearchResult(hit), title: version.title || hit.url, timestamp: version.timestamp, versionId: version.versionId };
    }
  }, { scopeUrls: [...byUrl.keys()], signal });
  return checked.filter((hit): hit is NonNullable<typeof hit> => hit !== null);
}

async function generateQueryVariations(query: string, n = 3, options: SearchOptions = {}): Promise<string[]> {
  const variations = [query];
  const settings = await getSettings();
  const rewriteEnabled = typeof options.rewrite === 'boolean' ? options.rewrite : settings.queryRewrite !== false;
  if (!rewriteEnabled || settings.activeProviderId === CHAT_PROVIDER_DISABLED) return variations;
  try {
    const config = await getChatConfig(options.signal);
    options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
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
  if (!rerankEnabled || settings.activeProviderId === CHAT_PROVIDER_DISABLED) return pool;
  const headCount = Math.min(12, pool.length);
  let limited = pool.slice(0, headCount);
  try {
    const config = await getChatConfig(options.signal);
    options.signal?.throwIfAborted();
    limited = await enrichRerankCandidates(limited, options.filters);
    if (!limited.length) return pool.slice(headCount);
    const batchScores = await batchScoreCandidatesWithLLM(query, limited, config);
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
    options.signal?.throwIfAborted();
    console.warn('[beta-background:search] cross-encoder rerank failed', err);
  }
  const merged = [...limited, ...pool.slice(headCount)];
  const filtered = merged.filter((candidate) => typeof candidate.crossScore !== 'number' || candidate.crossScore >= MIN_LLM_KEEP_SCORE);
  filtered.sort((a, b) => {
    const ca = typeof a.crossScore === 'number' ? 100 + a.crossScore : a.weightedScore ?? a.score ?? 0;
    const cb = typeof b.crossScore === 'number' ? 100 + b.crossScore : b.weightedScore ?? b.score ?? 0;
    return cb - ca;
  });
  return filtered;
}

async function semanticSearchInternal(query: string, limit: number, options: SearchOptions, textResults: SearchResult[]): Promise<SearchResult[]> {
  options.signal?.throwIfAborted();
  const normalized = query.trim();
  if (!normalized) return [];
  const variations = await generateQueryVariations(normalized, 3, options);
  options.signal?.throwIfAborted();
  const embeddingKey = embeddingSpaceKey(getEmbeddingConfig());
  const embeddings = await computeEmbeddingsForQueries(variations, options.signal).catch((err) => { options.signal?.throwIfAborted(); console.warn(err); return []; });
  if (embeddingKey !== embeddingSpaceKey(getEmbeddingConfig())) return textResults;
  options.signal?.throwIfAborted();
  const validEmbeddings = embeddings.filter((emb) => Array.isArray(emb) && emb.length);
  if (!validEmbeddings.length) {
    return textResults;
  }

  try {
    await ensureOffscreenDocument();
    const topResp = options.scopeUrls ? { pages: options.scopeUrls.map(url => ({ url })) } : await sendOffscreenMessage<OffscreenTopPageResponse>({
      type: 'OFFSCREEN_TOP_PAGES',
      variationEmbeddings: validEmbeddings,
      embeddingKey,
      topN: Math.max(limit * 3, 30)
    });
    const pageUrls = (topResp.pages || []).map((p) => p.url);
    if (!pageUrls.length) return textResults;
    const candidates: NonNullable<OffscreenScoreResponse['candidates']> = [];
    const scope = options.scopeUrls ? new Set(options.scopeUrls) : undefined;
    const batchSize = 64;
    for (let offset = 0; offset < pageUrls.length; offset += batchSize) {
      options.signal?.throwIfAborted();
      const chunkResp = await sendOffscreenMessage<OffscreenScoreResponse>({
        type: 'OFFSCREEN_SCORE_CHUNKS', pageUrls: pageUrls.slice(offset, offset + batchSize),
        variationEmbeddings: validEmbeddings, embeddingKey, originalQuery: normalized
      });
      candidates.push(...(chunkResp.candidates || []).filter(hit => !scope || scope.has(hit.url)));
    }
    candidates.sort((a, b) => {
      const aw = a.weightedScore ?? a.score ?? 0;
      const bw = b.weightedScore ?? b.score ?? 0;
      return bw - aw;
    });
    const eligible = dedupeByUrl(await retainFilteredResults(candidates, options.filters || {}, options.signal));
    const dedupedCandidates = mergeRetrievalResults(eligible, textResults);
    const reranked = await rerankWithCrossEncoder(normalized, dedupedCandidates, options);
    return reranked.slice(0, limit).map(toSearchResult);
  } catch (err) {
    options.signal?.throwIfAborted();
    console.warn('[beta-background:search] offscreen search failed, falling back', err);
    return textResults;
  }
}

export async function searchStoredPages(query: string, limit = 10, options: SearchOptions = {}): Promise<SearchResult[]> {
  options.signal?.throwIfAborted();
  const filters = readSearchFilters(options.filters);
  const filtered = Object.keys(filters).length > 0;
  if ((!query.trim() && !filtered) || limit <= 0) return [];
  const { results: textResults, scopeUrls, hasPages } = await storageManager.searchTextPages(query, limit, filters, { signal: options.signal, scopeUrls: options.scopeUrls });
  options.signal?.throwIfAborted();
  options.onTextResults?.(textResults);
  if (!query.trim() || !hasPages || /["“][^"”]+["”]/u.test(query)) return abortable(retainFilteredResults(textResults, filters, options.signal), options.signal);
  const refine = (signal?: AbortSignal): Promise<SearchResult[]> => semanticSearchInternal(query, limit, { ...options, signal, scopeUrls, filters }, textResults);
  const results = (options.explicitModelUse ? await abortable(refine(options.signal), options.signal) : await runAutomaticAi(refine, options.signal)) ?? textResults;
  const enhanced = new Map<string, SearchResult>(results.map(hit => [hit.url, hit]));
  const exact = textResults.filter(hit => hit.containsExact).map(hit => ({ ...enhanced.get(hit.url), ...hit, crossScore: enhanced.get(hit.url)?.crossScore, weightedScore: enhanced.get(hit.url)?.weightedScore }));
  const exactUrls = new Set(exact.map(hit => canonicalizeUrl(hit.url)));
  const ordered = [...exact, ...results.filter(hit => !exactUrls.has(canonicalizeUrl(hit.url)))].slice(0, limit);
  return abortable(retainFilteredResults(scopeUrls ? ordered.filter(hit => scopeUrls.includes(hit.url)) : ordered, filters, options.signal), options.signal);
}
