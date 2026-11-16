import type { FetchMoreArgs, ToolHandlerResult, ToolsHandlerContext } from './types';

export async function runFetchMore(ctx: ToolsHandlerContext, rawArgs: unknown): Promise<ToolHandlerResult> {
  const args = rawArgs as FetchMoreArgs | undefined;
  const fail = (code: string, message: string): ToolHandlerResult => ({ ok: false, error: { code, message }, content: '' });
  if (!args || typeof args.url !== 'string' || !args.url.trim()) return fail('invalid_args', 'url (string) is required');
  for (const key of ['chunkIndex', 'aroundChunkIndex', 'radius', 'start', 'end', 'offset', 'limit'] as const) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key]! < 0)) return fail('invalid_args', `${key} must be a non-negative integer`);
  }
  const url = args.url.trim();
  if (!ctx.allowedUrls.has(url)) return fail('disallowed', 'Use a URL returned by scoped search_memory');
  const page = ctx.getPage(url);
  if (!page) return fail('not_found', 'This saved page is no longer available');
  const offset = args.offset ?? 0;
  const limit = Math.max(1, Math.min(args.limit ?? ctx.maxSlice, ctx.maxSlice));
  let text: string, nextArgs: FetchMoreArgs | null = null;
  const usedArgs: FetchMoreArgs = { ...args, url };
  if (args.chunkIndex !== undefined || args.aroundChunkIndex !== undefined) {
    const index = args.chunkIndex ?? args.aroundChunkIndex!;
    if (!page.chunks?.[index]) return fail('not_found', 'No such saved passage. Use get_page_chunks to find valid chunk indices.');
    const radius = args.chunkIndex !== undefined ? 0 : Math.min(3, args.radius ?? 1);
    const from = Math.max(0, index - radius), to = Math.min(page.chunks.length - 1, index + radius);
    const full = page.chunks.slice(from, to + 1).map(chunk => chunk.text || '').filter(Boolean).join('\n\n');
    if (offset >= full.length) return fail('not_found', 'No saved text at this offset');
    text = full.slice(offset, offset + limit);
    if (offset + text.length < full.length) nextArgs = { ...usedArgs, offset: offset + text.length, limit };
  } else {
    if (args.start === undefined && args.end === undefined) return fail('invalid_args', 'Provide chunkIndex, aroundChunkIndex, or start/end');
    const full = ctx.pageText.get(url) || page.text || '';
    const start = args.start ?? 0, requestedEnd = Math.min(args.end ?? full.length, full.length);
    if (requestedEnd <= start) return fail('invalid_args', 'end must be greater than start within the saved text');
    const end = Math.min(start + limit, requestedEnd);
    text = full.slice(start, end);
    usedArgs.start = start; usedArgs.end = end;
    if (end < requestedEnd) nextArgs = { url, start: end, end: requestedEnd, limit };
  }
  ctx.ensureUrlTracked(url);
  return { ok: true, content: JSON.stringify({ ok: true, nextArgs, truncated: nextArgs !== null, suggest: nextArgs ? 'Copy nextArgs exactly to continue; repeating this call reads the same characters again' : null, usedArgs, data: { url, text, chunkIndex: args.chunkIndex, offset, title: page.title || url, domain: ctx.extractDomain(url), timestamp: page.timestamp } }) };
}
