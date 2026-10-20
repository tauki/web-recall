import type { SearchWithinPageArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validateWithinPage(args: SearchWithinPageArgs | undefined): { ok: boolean; value?: { url: string; query: string; k: number }; errors?: string[] } {
  if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, errors: ['url (string) is required'] };
  }
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    return { ok: false, errors: ['query (string) is required'] };
  }
  let k = typeof args.k === 'number' ? Math.trunc(args.k) : 5;
  if (k < 1) k = 1;
  if (k > 10) k = 10;
  return { ok: true, value: { url: args.url.trim(), query: args.query.trim(), k } };
}

export async function runSearchWithinPage(ctx: ToolsHandlerContext, rawArgs: unknown): Promise<ToolHandlerResult> {
  const validation = validateWithinPage(rawArgs as SearchWithinPageArgs | undefined);
  if (!validation.ok || !validation.value) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: (validation.errors || []).join('; '), suggest: 'Call search_within_page({ url, query, k? })' },
      content: ''
    };
  }

  const { url, query, k } = validation.value;
  if (!ctx.allowedUrls.has(url)) {
    return {
      ok: false,
      error: { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' },
      content: ''
    };
  }

  const record = ctx.getPage(url);
  const chunks = record?.chunks || [];
  const matches = chunks
    .map((chunk, index) => ({
      chunkIndex: index,
      score: ctx.scoreChunkMatch(chunk.text || '', query),
      snippet: ctx.cleanPreview(chunk.text || '')
    }))
    .filter((chunk) => chunk.score > 0 && chunk.snippet)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  ctx.ensureUrlTracked(url);
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      data: {
        title: record?.title || url,
        url,
        domain: ctx.extractDomain(url),
        matches
      },
      usedArgs: { url, query, k },
      suggest: matches.length ? 'Use fetch_more with a returned chunkIndex to inspect surrounding context' : 'Try get_page_chunks({ url }) to inspect the page structure'
    })
  };
}
