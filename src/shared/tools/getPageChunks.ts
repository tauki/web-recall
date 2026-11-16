import type { GetPageChunksArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validatePageChunks(args: GetPageChunksArgs | undefined): { ok: boolean; value?: { url: string; limit: number; offset: number }; errors?: string[] } {
  if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, errors: ['url (string) is required'] };
  }
  if ([args.limit, args.offset].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return { ok: false, errors: ['limit and offset must be non-negative integers'] };
  let limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 8;
  if (limit < 1) limit = 1;
  if (limit > 20) limit = 20;
  return { ok: true, value: { url: args.url.trim(), limit, offset: args.offset ?? 0 } };
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

  const { url, limit, offset } = validation.value;
  if (!ctx.allowedUrls.has(url)) {
    return {
      ok: false,
      error: { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' },
      content: ''
    };
  }

  const record = ctx.getPage(url);
  if (!record) return { ok: false, error: { code: 'not_found', message: 'This saved page is no longer available' }, content: '' };
  const chunks = ctx.buildChunkRows(url, limit, offset);
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
      usedArgs: { url, limit, offset },
      nextArgs: offset + limit < (record.chunks?.length || 0) ? { url, limit, offset: offset + limit } : null,
      suggest: 'For a precise missing fact, use search_within_page({ url, query }) and read at its returned chunkIndex and character offset. To read from a listed chunk’s start, use fetch_more({ url, chunkIndex, offset: 0 }).'
    })
  };
}
