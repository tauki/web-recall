import type { SearchMemoryArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validateSearchMemory(args: SearchMemoryArgs | undefined): { ok: boolean; value?: { query: string; k: number; offset: number }; errors?: string[] } {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { ok: false, errors: ['query (string) is required'] };
  }
  if ([args?.k, args?.offset].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return { ok: false, errors: ['k and offset must be non-negative integers'] };
  let k = typeof args?.k === 'number' ? Math.trunc(args.k) : 5;
  if (k < 1) k = 1;
  if (k > 10) k = 10;
  return { ok: true, value: { query, k, offset: args?.offset ?? 0 } };
}

function normalizeHits(ctx: ToolsHandlerContext, hits: Awaited<ReturnType<ToolsHandlerContext['searchMemory']>>, partial = false) {
  return hits.map((hit) => ({
    title: hit.title,
    url: hit.url,
    domain: hit.domain || ctx.extractDomain(hit.url),
    snippet: ctx.cleanPreview(hit.snippet, 220),
    chunkIndex: hit.chunkIndex,
    score: hit.score,
    hitsFromPage: hit.hitsFromPage,
    partial: partial || hit.partial,
    timestamp: hit.timestamp,
    versionId: hit.versionId
  }));
}

export async function runSearchMemory(ctx: ToolsHandlerContext, rawArgs: unknown): Promise<ToolHandlerResult> {
  const validation = validateSearchMemory(rawArgs as SearchMemoryArgs | undefined);
  if (!validation.ok || !validation.value) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: (validation.errors || []).join('; '), suggest: 'Call search_memory({ query, k? (1..10) })' },
      content: ''
    };
  }

  const { query, k, offset } = validation.value;
  const cacheKey = `${query}::${k}::${offset}`;
  if (ctx.cache.search.has(cacheKey)) {
    return { ok: true, content: ctx.cache.search.get(cacheKey)! };
  }

  const previous = ctx.cache.searchResults.get(query) || [];
  const fresh = previous.length >= offset + k + 1 ? [] : await ctx.searchMemory(query, offset + k + 1);
  const key = (hit: typeof previous[number]) => JSON.stringify([hit.url, hit.versionId ?? hit.timestamp]);
  const seen = new Set(previous.map(key));
  const hits = [...previous];
  for (const hit of fresh) if (!seen.has(key(hit))) { seen.add(key(hit)); hits.push(hit); }
  ctx.cache.searchResults.set(query, hits);
  const content = JSON.stringify({
    ok: true,
    data: normalizeHits(ctx, hits.slice(offset, offset + k)),
    usedArgs: { query, k, offset },
    nextArgs: offset + k < hits.length ? { query, k, offset: offset + k } : null,
    suggest: 'Use search_within_page to locate a precise detail, or summary/chunk listings for a broad overview'
  });
  hits.forEach((hit) => hit?.url && ctx.ensureUrlTracked(hit.url));
  ctx.cache.search.set(cacheKey, content);
  return { ok: true, content };
}
