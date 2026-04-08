import type { PageRecord } from '../db/index';

export type ToolSearchHit = {
  title: string;
  url: string;
  snippet: string;
  chunkIndex?: number;
  partial?: boolean;
};

export type ToolsRuntimeOptions = {
  allowedUrls: Set<string>;
  pageText: Map<string, string>;
  pages: PageRecord[];
  maxSlice?: number;
  toolTimeoutMs?: number;
  searchMemory: (query: string, k: number) => Promise<ToolSearchHit[]>;
  quickSearchMemory: (query: string, k: number) => Promise<ToolSearchHit[]>;
};

export type ToolRunResult = {
  content: string;
};

export type ToolMetric = {
  name: string;
  ms: number;
  ok: boolean;
  error?: string | null;
  deduped?: boolean;
};

type FetchMoreArgs = { url: string; chunkIndex?: number; start?: number; end?: number };
type SearchMemoryArgs = { query: string; k?: number };
type SummaryArgs = { url: string };

const DEFAULT_MAX_SLICE = 1200;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export class ToolsRuntime {
  private allowedUrls: Set<string>;
  private pageText: Map<string, string>;
  private pages: PageRecord[];
  private maxSlice: number;
  private toolTimeoutMs: number;
  private searchMemory: (query: string, k: number) => Promise<ToolSearchHit[]>;
  private quickSearchMemory: (query: string, k: number) => Promise<ToolSearchHit[]>;
  private cache = {
    fetchMore: new Map<string, Array<{ s: number; e: number; text: string }>>(),
    summary: new Map<string, string>(),
    search: new Map<string, string>()
  };
  private calls = new Set<string>();
  metrics: ToolMetric[] = [];
  usedUrls = new Set<string>();
  usedUrlOrder: string[] = [];

  constructor(opts: ToolsRuntimeOptions) {
    this.allowedUrls = opts.allowedUrls || new Set();
    this.pageText = opts.pageText || new Map();
    this.pages = opts.pages || [];
    this.maxSlice = typeof opts.maxSlice === 'number' ? opts.maxSlice : DEFAULT_MAX_SLICE;
    this.toolTimeoutMs = typeof opts.toolTimeoutMs === 'number' ? opts.toolTimeoutMs : DEFAULT_TOOL_TIMEOUT_MS;
    this.searchMemory = opts.searchMemory;
    this.quickSearchMemory = opts.quickSearchMemory;
  }

  private signature(name: string, args: unknown): string {
    try {
      return `${name}:${JSON.stringify(args)}`;
    } catch {
      return name;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);
  }

  private maybeWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!ms || ms <= 0) return promise;
    return this.withTimeout(promise, ms);
  }

  private validateFetchMore(args: FetchMoreArgs | undefined): { ok: boolean; value?: FetchMoreArgs; errors?: string[] } {
  const errors: string[] = [];
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) {
    errors.push('url (string) is required');
  }
  const chunkValue = typeof args?.chunkIndex === 'number' ? args.chunkIndex : undefined;
  const startValue = typeof args?.start === 'number' ? args.start : undefined;
  const endValue = typeof args?.end === 'number' ? args.end : undefined;
  const hasChunk = typeof chunkValue === 'number';
  const hasRange = typeof startValue === 'number' || typeof endValue === 'number';
  if (!hasChunk && !hasRange) {
    errors.push('provide chunkIndex or start/end');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const value: FetchMoreArgs = { url };
  if (hasChunk) {
    value.chunkIndex = Math.max(0, Math.trunc(chunkValue ?? 0));
  } else {
    let start = typeof startValue === 'number' ? startValue : 0;
    let end = typeof endValue === 'number' ? endValue : start + this.maxSlice;
    if (start < 0) start = 0;
    if (end < start) end = start + this.maxSlice;
    value.start = start;
    value.end = end;
  }
  return { ok: true, value };
}

  private validateSearchMemory(args: SearchMemoryArgs | undefined): { ok: boolean; value?: { query: string; k: number }; errors?: string[] } {
    if (!args || typeof args.query !== 'string' || args.query.trim().length === 0) {
      return { ok: false, errors: ['query (string) is required'] };
    }
    let k = typeof args.k === 'number' ? args.k : 5;
    if (k < 1) k = 1;
    if (k > 10) k = 10;
    return { ok: true, value: { query: args.query, k } };
  }

  private validateSummary(args: SummaryArgs | undefined): { ok: boolean; value?: SummaryArgs; errors?: string[] } {
    if (!args || typeof args.url !== 'string' || args.url.trim().length === 0) {
      return { ok: false, errors: ['url (string) is required'] };
    }
    return { ok: true, value: { url: args.url } };
  }

  private mergeRange(url: string, start: number, end: number, content: string): string {
    if (!this.cache.fetchMore.has(url)) {
      this.cache.fetchMore.set(url, []);
    }
    const arr = this.cache.fetchMore.get(url)!;
    const ns = Math.max(0, start | 0);
    const ne = Math.max(ns, end | 0);
    let merged = false;
    for (const segment of arr) {
      if (!(ne < segment.s - 50 || ns > segment.e + 50)) {
        segment.s = Math.min(segment.s, ns);
        segment.e = Math.max(segment.e, ne);
        segment.text = content.slice(segment.s, segment.e);
        merged = true;
        break;
      }
    }
    if (!merged) {
      arr.push({ s: ns, e: ne, text: content.slice(ns, ne) });
    }
    const target = arr.find((seg) => ns >= seg.s && ne <= seg.e) ?? arr[arr.length - 1]!;
    return target.text;
  }

  private ensureUrlTracked(url: string): void {
    if (!this.usedUrls.has(url)) {
      this.usedUrls.add(url);
      this.usedUrlOrder.push(url);
    }
  }

  async runToolCall(name: 'fetch_more' | 'get_page_summary' | 'search_memory', rawArgs: unknown): Promise<ToolRunResult> {
    const started = performance.now();
    const signature = this.signature(name, rawArgs);
    if (this.calls.has(signature)) {
      this.metrics.push({ name, ms: 0, ok: true, deduped: true });
      return { content: JSON.stringify({ ok: true, data: { deduped: true }, suggest: null }) };
    }
    this.calls.add(signature);
    let ok = false;
    let content = '';
    let error: { code: string; message: string; suggest?: string } | null = null;

    try {
      if (name === 'fetch_more') {
        const validation = this.validateFetchMore(rawArgs as FetchMoreArgs | undefined);
        if (!validation.ok || !validation.value) {
          throw { code: 'invalid_args', message: (validation.errors || []).join('; '), suggest: 'Provide { url, chunkIndex } or { url, start, end }' };
        }
        const { url, chunkIndex, start, end } = validation.value;
        if (!this.allowedUrls.has(url)) {
          throw { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' };
        }
        const page = this.pages.find((p) => p.url === url);
        const fullText = this.pageText.get(url) || page?.text || '';
        const response: Record<string, unknown> = { url };
        if (typeof chunkIndex === 'number') {
          const chunkText = page?.chunks?.[chunkIndex]?.text ?? '';
          response.chunkIndex = chunkIndex;
          content = JSON.stringify({ ok: true, data: { text: chunkText }, usedArgs: response, suggest: 'Prefer chunkIndex for precise snippets' });
        } else {
          const safeStart = Math.max(0, (start ?? 0) | 0);
          let safeEnd = Math.max(safeStart, (end ?? safeStart + this.maxSlice) | 0);
          safeEnd = Math.min(fullText.length, safeEnd);
          if (safeEnd - safeStart > this.maxSlice) safeEnd = safeStart + this.maxSlice;
          const slice = this.mergeRange(url, safeStart, safeEnd, fullText);
          response.start = safeStart;
          response.end = safeEnd;
          content = JSON.stringify({
            ok: true,
            data: { text: slice },
            usedArgs: response,
            suggest: 'Use smaller ranges (<= maxSlice) or prefer chunkIndex'
          });
        }
        ok = true;
        this.ensureUrlTracked(url);
      } else if (name === 'get_page_summary') {
        const validation = this.validateSummary(rawArgs as SummaryArgs | undefined);
        if (!validation.ok || !validation.value) {
          throw { code: 'invalid_args', message: (validation.errors || []).join('; '), suggest: 'Call get_page_summary({ url })' };
        }
        const { url } = validation.value;
        if (!this.allowedUrls.has(url)) {
          throw { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory' };
        }
        if (!this.cache.summary.has(url)) {
          const record = this.pages.find((p) => p.url === url);
          this.cache.summary.set(url, record?.summary || '');
        }
        const summary = this.cache.summary.get(url) || '';
        content = JSON.stringify({ ok: true, data: { summary }, usedArgs: { url }, suggest: null });
        ok = true;
        this.ensureUrlTracked(url);
      } else if (name === 'search_memory') {
        const validation = this.validateSearchMemory(rawArgs as SearchMemoryArgs | undefined);
        if (!validation.ok || !validation.value) {
          throw { code: 'invalid_args', message: (validation.errors || []).join('; '), suggest: 'Call search_memory({ query, k? (1..10) })' };
        }
        const { query, k } = validation.value;
        const cacheKey = `${query}::${k}`;
        if (this.cache.search.has(cacheKey)) {
          content = this.cache.search.get(cacheKey)!;
          ok = true;
        } else {
          try {
            const hits = await this.maybeWithTimeout(this.searchMemory(query, k), this.toolTimeoutMs);
            content = JSON.stringify({
              ok: true,
              data: hits,
              usedArgs: { query, k },
              suggest: 'Use fetch_more({ url, chunkIndex }) to expand a hit'
            });
            hits.forEach((hit) => hit?.url && this.ensureUrlTracked(hit.url));
          } catch {
            const partial = await this.quickSearchMemory(query, k);
            content = JSON.stringify({
              ok: true,
              data: partial.map((hit) => ({ ...hit, partial: true })),
              usedArgs: { query, k },
              suggest: 'Partial search results; consider smaller k'
            });
            partial.forEach((hit) => hit?.url && this.ensureUrlTracked(hit.url));
          }
          this.cache.search.set(cacheKey, content);
          ok = true;
        }
      } else {
        throw { code: 'unknown_tool', message: 'unsupported tool', suggest: 'Use search_memory, fetch_more, or get_page_summary' };
      }
    } catch (err) {
      const payload = err && typeof err === 'object' && 'code' in (err as Record<string, unknown>) ? (err as { code: string; message: string; suggest?: string }) : { code: 'tool_error', message: String((err as Error)?.message || err) };
      error = payload;
      content = JSON.stringify({ ok: false, error: payload, suggest: payload.suggest || null });
    } finally {
      const elapsed = Math.round(performance.now() - started);
      this.metrics.push({ name, ms: elapsed, ok, error: error?.code });
    }
    return { content };
  }
}
