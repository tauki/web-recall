import type { PageRecord } from '../db/index';
import { runFetchMore } from './fetchMore';
import { runGetPageChunks } from './getPageChunks';
import { runGetPageSummary } from './getPageSummary';
import { runSearchMemory } from './searchMemory';
import { runSearchWithinPage } from './searchWithinPage';
import type {
  ToolHandlerError,
  ToolMetric,
  ToolName,
  ToolRunResult,
  ToolsCache,
  ToolsHandlerContext,
  ToolsRuntimeOptions
} from './types';

const DEFAULT_MAX_SLICE = 1200;
const DEFAULT_TOOL_TIMEOUT_MS = 10_000;

export class ToolsRuntime implements ToolsHandlerContext {
  allowedUrls: Set<string>;
  pageText: Map<string, string>;
  pages: PageRecord[];
  maxSlice: number;
  toolTimeoutMs: number;
  searchMemory: (query: string, k: number) => Promise<Awaited<ReturnType<ToolsRuntimeOptions['searchMemory']>>>;
  quickSearchMemory: (query: string, k: number) => Promise<Awaited<ReturnType<ToolsRuntimeOptions['quickSearchMemory']>>>;
  cache: ToolsCache = {
    fetchMore: new Map<string, Array<{ s: number; e: number; text: string }>>(),
    summary: new Map<string, string>(),
    search: new Map<string, string>()
  };
  calls = new Set<string>();
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

  maybeWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!ms || ms <= 0) return promise;
    return this.withTimeout(promise, ms);
  }

  extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  cleanPreview(text: string, limit = 220): string {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
  }

  getPage(url: string): PageRecord | undefined {
    return this.pages.find((page) => page.url === url);
  }

  buildChunkRows(url: string, limit = 8): Array<{ chunkIndex: number; preview: string; length: number }> {
    const page = this.getPage(url);
    const chunks = page?.chunks || [];
    return chunks
      .map((chunk, index) => ({
        chunkIndex: index,
        preview: this.cleanPreview(chunk.text, 180),
        length: (chunk.text || '').length
      }))
      .filter((chunk) => chunk.preview)
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }

  scoreChunkMatch(text: string, query: string): number {
    const haystack = text.toLowerCase();
    const normalizedQuery = query.trim().toLowerCase();
    if (!haystack || !normalizedQuery) return 0;
    const tokens = normalizedQuery.split(/[^a-z0-9]+/i).filter((token) => token.length >= 2);
    if (!tokens.length) return haystack.includes(normalizedQuery) ? 1 : 0;
    let hits = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) hits += 1;
    }
    const phraseBonus = haystack.includes(normalizedQuery) ? 1 : 0;
    return hits / tokens.length + phraseBonus;
  }

  mergeRange(url: string, start: number, end: number, content: string): string {
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

  ensureUrlTracked(url: string): void {
    if (!this.usedUrls.has(url)) {
      this.usedUrls.add(url);
      this.usedUrlOrder.push(url);
    }
  }

  async runToolCall(name: ToolName, rawArgs: unknown): Promise<ToolRunResult> {
    const started = performance.now();
    const signature = this.signature(name, rawArgs);
    if (this.calls.has(signature)) {
      this.metrics.push({ name, ms: 0, ok: true, deduped: true });
      return { content: JSON.stringify({ ok: true, data: { deduped: true }, suggest: null }) };
    }
    this.calls.add(signature);
    let ok = false;
    let content = '';
    let error: ToolHandlerError | null = null;

    try {
      const result =
        name === 'fetch_more'
          ? await runFetchMore(this, rawArgs)
          : name === 'get_page_summary'
            ? await runGetPageSummary(this, rawArgs)
            : name === 'search_memory'
              ? await runSearchMemory(this, rawArgs)
              : name === 'get_page_chunks'
                ? await runGetPageChunks(this, rawArgs)
                : name === 'search_within_page'
                  ? await runSearchWithinPage(this, rawArgs)
                  : {
                      ok: false,
                      error: {
                        code: 'unknown_tool',
                        message: 'unsupported tool',
                        suggest: 'Use search_memory, get_page_summary, get_page_chunks, search_within_page, or fetch_more'
                      },
                      content: ''
                    };

      ok = result.ok;
      error = result.error || null;
      content =
        result.content ||
        JSON.stringify({
          ok: result.ok,
          error: result.error || null,
          suggest: result.error?.suggest || null
        });
    } catch (err) {
      error = {
        code: 'tool_error',
        message: String((err as Error)?.message || err)
      };
      content = JSON.stringify({ ok: false, error, suggest: null });
    } finally {
      const elapsed = Math.round(performance.now() - started);
      this.metrics.push({ name, ms: elapsed, ok, error: error?.code });
    }

    return { content };
  }
}
