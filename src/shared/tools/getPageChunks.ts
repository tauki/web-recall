import type { GetPageChunksArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validatePageChunks(args: GetPageChunksArgs | undefined): { ok: boolean; value?: { url: string; limit: number }; errors?: string[] } {
  if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, errors: ['url (string) is required'] };
  }
  let limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 8;
  if (limit < 1) limit = 1;
  if (limit > 20) limit = 20;
  return { ok: true, value: { url: args.url.trim(), limit } };
}

export async function runGetPageChunks(ctx: ToolsHandlerContext, rawArgs: unknown): Promise<ToolHandlerResult> {
  const validation = validatePageChunks(rawArgs as GetPageChunksArgs | undefined);
  if (!validation.ok || !validation.value) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: (validation.errors || []).join('; '), suggest: 'Call get_page_chunks({ url, limit? })' },
      content: ''
    };
  }

  const { url, limit } = validation.value;
  if (!ctx.allowedUrls.has(url)) {
    return {
      ok: false,
      error: { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' },
      content: ''
    };
  }

  const record = ctx.getPage(url);
  const chunks = ctx.buildChunkRows(url, limit);
  ctx.ensureUrlTracked(url);
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      data: {
        title: record?.title || url,
        url,
        domain: ctx.extractDomain(url),
        chunkCount: record?.chunks?.length || 0,
        chunks
      },
      usedArgs: { url, limit },
      suggest: 'Use fetch_more({ url, aroundChunkIndex, radius }) or fetch_more({ url, chunkIndex }) to inspect a promising chunk'
    })
  };
}
