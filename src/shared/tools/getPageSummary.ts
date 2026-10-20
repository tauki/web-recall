import type { SummaryArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validateSummary(args: SummaryArgs | undefined): { ok: boolean; value?: SummaryArgs; errors?: string[] } {
  if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, errors: ['url (string) is required'] };
  }
  return { ok: true, value: { url: args.url.trim() } };
}

export async function runGetPageSummary(ctx: ToolsHandlerContext, rawArgs: unknown): Promise<ToolHandlerResult> {
  const validation = validateSummary(rawArgs as SummaryArgs | undefined);
  if (!validation.ok || !validation.value) {
    return {
      ok: false,
      error: { code: 'invalid_args', message: (validation.errors || []).join('; '), suggest: 'Call get_page_summary({ url })' },
      content: ''
    };
  }

  const { url } = validation.value;
  if (!ctx.allowedUrls.has(url)) {
    return {
      ok: false,
      error: { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' },
      content: ''
    };
  }

  if (!ctx.cache.summary.has(url)) {
    const record = ctx.getPage(url);
    ctx.cache.summary.set(url, record?.summary || '');
  }
  const summary = ctx.cache.summary.get(url) || '';
  const record = ctx.getPage(url);
  ctx.ensureUrlTracked(url);
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      data: {
        title: record?.title || url,
        url,
        domain: ctx.extractDomain(url),
        summary,
        chunkCount: record?.chunks?.length || 0,
        snippet: ctx.cleanPreview(record?.text || '')
      },
      usedArgs: { url },
      suggest: record?.chunks?.length ? 'Use get_page_chunks({ url }) if you need to inspect specific sections' : null
    })
  };
}
