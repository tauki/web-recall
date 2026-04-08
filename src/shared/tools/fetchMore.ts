import type { FetchMoreArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

function validateFetchMore(args: FetchMoreArgs | undefined): { ok: boolean; value?: FetchMoreArgs; errors?: string[] } {
  const errors: string[] = [];
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) {
    errors.push('url (string) is required');
  }
  const chunkValue = typeof args?.chunkIndex === 'number' ? args.chunkIndex : undefined;
  const aroundValue = typeof args?.aroundChunkIndex === 'number' ? args.aroundChunkIndex : undefined;
  const radiusValue = typeof args?.radius === 'number' ? args.radius : undefined;
  const startValue = typeof args?.start === 'number' ? args.start : undefined;
  const endValue = typeof args?.end === 'number' ? args.end : undefined;
  const hasChunk = typeof chunkValue === 'number';
  const hasAround = typeof aroundValue === 'number';
  const hasRange = typeof startValue === 'number' || typeof endValue === 'number';
  if (!hasChunk && !hasAround && !hasRange) {
    errors.push('provide chunkIndex, aroundChunkIndex, or start/end');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const value: FetchMoreArgs = { url };
  if (hasChunk) {
    value.chunkIndex = Math.max(0, Math.trunc(chunkValue ?? 0));
  } else if (hasAround) {
    value.aroundChunkIndex = Math.max(0, Math.trunc(aroundValue ?? 0));
    value.radius = Math.max(0, Math.min(3, Math.trunc(radiusValue ?? 1)));
  } else {
    let start = typeof startValue === 'number' ? startValue : 0;
    let end = typeof endValue === 'number' ? endValue : start + 1200;
    if (start < 0) start = 0;
    if (end < start) end = start + 1200;
    value.start = start;
    value.end = end;
  }
  return { ok: true, value };
}

export async function runFetchMore(ctx: ToolsHandlerContext, rawArgs: unknown): Promise<ToolHandlerResult> {
  const validation = validateFetchMore(rawArgs as FetchMoreArgs | undefined);
  if (!validation.ok || !validation.value) {
    return {
      ok: false,
      error: {
        code: 'invalid_args',
        message: (validation.errors || []).join('; '),
        suggest: 'Provide { url, chunkIndex }, { url, aroundChunkIndex, radius }, or { url, start, end }'
      },
      content: ''
    };
  }

  const { url, chunkIndex, aroundChunkIndex, start, end } = validation.value;
  if (!ctx.allowedUrls.has(url)) {
    return {
      ok: false,
      error: { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' },
      content: ''
    };
  }

  const page = ctx.getPage(url);
  const fullText = ctx.pageText.get(url) || page?.text || '';
  const response: Record<string, unknown> = { url };

  if (typeof chunkIndex === 'number') {
    const chunkText = page?.chunks?.[chunkIndex]?.text ?? '';
    response.chunkIndex = chunkIndex;
    ctx.ensureUrlTracked(url);
    return {
      ok: true,
      content: JSON.stringify({
        ok: true,
        data: { text: chunkText, chunkIndex, title: page?.title || url, domain: ctx.extractDomain(url) },
        usedArgs: response,
        suggest: 'Use aroundChunkIndex to expand neighboring chunks when you need more context'
      })
    };
  }

  if (typeof aroundChunkIndex === 'number') {
    const radius = validation.value.radius ?? 1;
    const chunks = page?.chunks || [];
    const from = Math.max(0, aroundChunkIndex - radius);
    const to = Math.min(chunks.length - 1, aroundChunkIndex + radius);
    const selected = chunks.slice(from, to + 1).map((chunk) => chunk.text || '').filter(Boolean);
    response.aroundChunkIndex = aroundChunkIndex;
    response.radius = radius;
    ctx.ensureUrlTracked(url);
    return {
      ok: true,
      content: JSON.stringify({
        ok: true,
        data: {
          text: selected.join('\n\n'),
          fromChunkIndex: from,
          toChunkIndex: to,
          title: page?.title || url,
          domain: ctx.extractDomain(url)
        },
        usedArgs: response,
        suggest: 'Use get_page_chunks({ url }) first when you need to pick the best chunk neighborhood'
      })
    };
  }

  const safeStart = Math.max(0, (start ?? 0) | 0);
  let safeEnd = Math.max(safeStart, (end ?? safeStart + ctx.maxSlice) | 0);
  safeEnd = Math.min(fullText.length, safeEnd);
  if (safeEnd - safeStart > ctx.maxSlice) safeEnd = safeStart + ctx.maxSlice;
  const slice = ctx.mergeRange(url, safeStart, safeEnd, fullText);
  response.start = safeStart;
  response.end = safeEnd;
  ctx.ensureUrlTracked(url);
  return {
    ok: true,
    content: JSON.stringify({
      ok: true,
      data: { text: slice, title: page?.title || url, domain: ctx.extractDomain(url) },
      usedArgs: response,
      suggest: 'Prefer chunkIndex or aroundChunkIndex over raw start/end slices'
    })
  };
}
