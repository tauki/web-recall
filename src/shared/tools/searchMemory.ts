import type { SearchMemoryArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validateSearchMemory(args: SearchMemoryArgs | undefined): { ok: boolean; value?: { query: string; k: number }; errors?: string[] } {
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { ok: false, errors: ['query (string) is required'] };
  }
  let k = typeof args?.k === 'number' ? Math.trunc(args.k) : 5;
  if (k < 1) k = 1;
  if (k > 10) k = 10;
  return { ok: true, value: { query, k } };
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
    partial: partial || hit.partial
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

  const { query, k } = validation.value;
  const cacheKey = `${query}::${k}`;
  if (ctx.cache.search.has(cacheKey)) {
    return { ok: true, content: ctx.cache.search.get(cacheKey)! };
  }

  try {
    const hits = await ctx.maybeWithTimeout(ctx.searchMemory(query, k), ctx.toolTimeoutMs);
    const content = JSON.stringify({
      ok: true,
      data: normalizeHits(ctx, hits),
      usedArgs: { query, k },
      suggest: 'Use get_page_summary or get_page_chunks on the best URL before fetching more text'
    });
    hits.forEach((hit) => hit?.url && ctx.ensureUrlTracked(hit.url));
    ctx.cache.search.set(cacheKey, content);
    return { ok: true, content };
  } catch {
    const partial = await ctx.quickSearchMemory(query, k);
    const content = JSON.stringify({
      ok: true,
      data: normalizeHits(ctx, partial, true),
      usedArgs: { query, k },
      suggest: 'Partial search results; consider smaller k'
    });
    partial.forEach((hit) => hit?.url && ctx.ensureUrlTracked(hit.url));
    ctx.cache.search.set(cacheKey, content);
    return { ok: true, content };
  }
}
