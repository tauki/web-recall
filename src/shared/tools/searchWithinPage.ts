import type { SearchWithinPageArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validateWithinPage(args: SearchWithinPageArgs | undefined): { ok: boolean; value?: { url: string; query: string; k: number; offset: number }; errors?: string[] } {
  if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, errors: ['url (string) is required'] };
  }
  if ([args.k, args.offset].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return { ok: false, errors: ['k and offset must be non-negative integers'] };
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    return { ok: false, errors: ['query (string) is required'] };
  }
  let k = typeof args.k === 'number' ? Math.trunc(args.k) : 5;
  if (k < 1) k = 1;
  if (k > 10) k = 10;
  return { ok: true, value: { url: args.url.trim(), query: args.query.trim(), k, offset: args.offset ?? 0 } };
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

  const { url, query, k, offset } = validation.value;
  if (!ctx.allowedUrls.has(url)) {
    return {
      ok: false,
      error: { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' },
      content: ''
    };
  }

  const record = ctx.getPage(url);
  if (!record) return { ok: false, error: { code: 'not_found', message: 'This saved page is no longer available' }, content: '' };
  const chunks = record?.chunks || [];
  const matches = chunks
    .map((chunk, index) => {
      const text = chunk.text || '', lower = text.toLowerCase(), words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];
      const exact = lower.indexOf(query.toLowerCase());
      const first = exact >= 0 ? exact : words.map(word => lower.indexOf(word)).filter(position => position >= 0).sort((left, right) => left - right)[0] ?? 0;
      const offset = Math.max(0, first - 80);
      return { chunkIndex: index, offset, score: ctx.scoreChunkMatch(text, query), snippet: ctx.cleanPreview(text.slice(offset, offset + 220)) };
    })
    .filter((chunk) => chunk.score > 0 && chunk.snippet)
    .sort((a, b) => b.score - a.score);

  ctx.ensureUrlTracked(url);
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      data: {
        title: record?.title || url,
        url,
        domain: ctx.extractDomain(url),
        matches: matches.slice(offset, offset + k)
      },
      usedArgs: { url, query, k, offset },
      nextArgs: offset + k < matches.length ? { url, query, k, offset: offset + k } : null,
      suggest: matches.length ? 'Use fetch_more with the returned chunkIndex and offset to read the matching passage' : 'Try get_page_chunks({ url }) to inspect the page structure'
    })
  };
}
