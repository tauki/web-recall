import type { PageRecord } from '../db/index';
import { runFetchMore } from './fetchMore';
import { runGetPageChunks } from './getPageChunks';
import { runGetPageSummary } from './getPageSummary';
import { runSearchMemory } from './searchMemory';
import { runSearchWithinPage } from './searchWithinPage';
import type {
  ToolMetric,
  ToolName,
  ToolRunResult,
  ToolsCache,
  ToolsHandlerContext,
  ToolsRuntimeOptions
} from './types';

const DEFAULT_MAX_SLICE = 1200;

export class ToolsRuntime implements ToolsHandlerContext {
  allowedUrls: Set<string>;
  pageText: Map<string, string>;
  pages: PageRecord[];
  maxSlice: number;
  searchMemory: (query: string, k: number) => Promise<Awaited<ReturnType<ToolsRuntimeOptions['searchMemory']>>>;
  cache: ToolsCache = {
    summary: new Map<string, string>(),
    search: new Map<string, string>(),
    searchResults: new Map()
  };
  private results = new Map<string, ToolRunResult>();
  private inFlight = new Map<string, Promise<ToolRunResult>>();
  private loading = new Map<string, Promise<void>>();
  private callCount = 0;
  private progress = 0;
  private previousOutputs = new Map<string, string>();
  private repeats = 0;
  private options: ToolsRuntimeOptions;
  metrics: ToolMetric[] = [];
  usedUrls = new Set<string>();
  usedUrlOrder: string[] = [];
  private recordEvidence?: ToolsRuntimeOptions['recordEvidence'];

  constructor(opts: ToolsRuntimeOptions) {
    this.options = opts;
    this.allowedUrls = opts.allowedUrls || new Set();
    this.pageText = opts.pageText || new Map();
    this.pages = opts.pages || [];
    this.recordEvidence = opts.recordEvidence;
    this.maxSlice = Number.isSafeInteger(opts.maxSlice) && opts.maxSlice! > 0 ? opts.maxSlice! : DEFAULT_MAX_SLICE;
    this.searchMemory = opts.searchMemory;
  }

  private signature(name: string, args: unknown): string {
    try {
      return `${name}:${JSON.stringify(args, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)}`;
    } catch {
      return name;
    }
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

  get remainingCalls(): number { return Math.max(0, (this.options.maxCalls ?? 100) - this.callCount); }
  get progressCount(): number { return this.progress; }

  private reportProgress(signature: string, output: ToolRunResult, cached: boolean): ToolRunResult {
    const payload = JSON.parse(output.content);
    const fresh = this.previousOutputs.get(signature) !== output.content;
    this.previousOutputs.set(signature, output.content);
    if (fresh) this.progress++;
    this.repeats = fresh ? 0 : this.repeats + 1;
    payload.newInformation = fresh;
    if (cached) payload.cached = true;
    if (!fresh) payload.notice = payload.nextArgs ? 'This evidence was already returned. Copy nextArgs exactly to read a different part; identical arguments do not advance.' : 'This result was already returned. Use a different query or search_within_page for the missing fact.';
    if (!fresh && this.repeats >= 3) payload.control = { noProgress: true };
    return { content: JSON.stringify(payload) };
  }

  buildChunkRows(url: string, limit = 8, offset = 0): Array<{ chunkIndex: number; preview: string; length: number }> {
    const page = this.getPage(url);
    const chunks = page?.chunks || [];
    return chunks
      .map((chunk, index) => ({
        chunkIndex: index,
        preview: this.cleanPreview(chunk.text, 180),
        length: (chunk.text || '').length
      }))
      .slice(offset, offset + Math.max(1, Math.min(limit, 20)));
  }

  scoreChunkMatch(text: string, query: string): number {
    const haystack = text.toLowerCase();
    const normalizedQuery = query.trim().toLowerCase();
    if (!haystack || !normalizedQuery) return 0;
    const tokens = normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 2);
    if (!tokens.length) return haystack.includes(normalizedQuery) ? 1 : 0;
    let hits = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) hits += 1;
    }
    const phraseBonus = haystack.includes(normalizedQuery) ? 1 : 0;
    return hits / tokens.length + phraseBonus;
  }

  ensureUrlTracked(url: string): void {
    if (!this.usedUrls.has(url)) {
      this.usedUrls.add(url);
      this.usedUrlOrder.push(url);
    }
  }

  async runToolCall(name: ToolName, rawArgs: unknown, callId: string = crypto.randomUUID()): Promise<ToolRunResult> {
    this.options.signal?.throwIfAborted();
    const started = performance.now();
    this.options.onActivity?.({ callId, tool: name, status: 'started' });
    const maxCalls = this.options.maxCalls ?? 100;
    if (this.callCount >= maxCalls) {
      this.options.onActivity?.({ callId, tool: name, status: 'failed', error: 'tool_budget_exhausted', ms: 0 });
      return { content: JSON.stringify({ ok: false, error: { code: 'tool_budget_exhausted', message: 'The tool-call allowance is exhausted. Finish from the evidence already read or explain what is missing.' } }) };
    }
    this.callCount++;
    const signature = this.signature(name, rawArgs);
    const cached = this.results.get(signature);
    if (cached) {
      this.metrics.push({ name, ms: 0, ok: true, deduped: true });
      this.options.onActivity?.({ callId, tool: name, status: 'cached', ms: 0 });
      return this.reportProgress(signature, cached, true);
    }
    const result = this.inFlight.get(signature) ?? this.execute(name, rawArgs);
    this.inFlight.set(signature, result);
    try {
      const output = await result;
      this.options.signal?.throwIfAborted();
      const payload = JSON.parse(output.content);
      if (payload.ok) this.results.set(signature, output);
      this.options.onActivity?.({ callId, tool: name, status: payload.ok ? 'completed' : 'failed', ms: Math.round(performance.now() - started), error: payload.error?.code });
      return this.reportProgress(signature, output, false);
    } catch (error) {
      this.options.onActivity?.({ callId, tool: name, status: this.options.signal?.aborted ? 'cancelled' : 'failed', ms: Math.round(performance.now() - started) });
      throw error;
    } finally {
      if (this.inFlight.get(signature) === result) this.inFlight.delete(signature);
    }
  }

  private async execute(name: ToolName, rawArgs: unknown): Promise<ToolRunResult> {
    const started = performance.now();
    let ok = false;
    let content = '';
    let error: { code: string; message: string; suggest?: string } | null = null;

    try {
      const url = rawArgs && typeof rawArgs === 'object' && 'url' in rawArgs && typeof rawArgs.url === 'string' ? rawArgs.url.trim() : undefined;
      if (url && this.allowedUrls.has(url) && !this.getPage(url) && this.options.loadPage) {
        const load = this.loading.get(url) ?? this.options.loadPage(url).then(page => {
          this.options.signal?.throwIfAborted();
          if (page && !this.getPage(url)) { this.pages.push(page); this.pageText.set(url, page.text || page.chunks?.map(chunk => chunk.text || '').join('\n') || ''); }
        });
        this.loading.set(url, load);
        try { await load; } finally { if (this.loading.get(url) === load) this.loading.delete(url); }
      }
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
      this.options.signal?.throwIfAborted();
      error = {
        code: 'tool_error',
        message: String((err as Error)?.message || err)
      };
      content = JSON.stringify({ ok: false, error, suggest: null });
    } finally {
      const elapsed = Math.round(performance.now() - started);
      this.metrics.push({ name, ms: elapsed, ok, error: error?.code });
    }

    if (ok) {
      const payload = JSON.parse(content);
      if (name === 'search_memory' && Array.isArray(payload.data)) {
        payload.data = payload.data.filter((row: { url?: string }) => {
          if (typeof row?.url !== 'string' || !/^https?:\/\//i.test(row.url)) return false;
          if (this.options.allowSearchDiscovery) this.allowedUrls.add(row.url);
          return this.allowedUrls.has(row.url);
        });
      }
      const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const url = row.url || payload.usedArgs?.url;
        if (typeof url !== 'string' || !this.allowedUrls.has(url)) continue;
        const text = row.text || row.summary || row.snippet ||
          (row.matches || row.chunks || []).map((item: { snippet?: string; preview?: string }) => item.snippet || item.preview || '').join('\n');
        const page = name === 'search_memory' ? undefined : this.getPage(url);
        row.versionId = row.versionId ?? page?.versionId;
        row.timestamp = row.timestamp ?? page?.timestamp;
        if (this.recordEvidence) row.sourceIndex = this.recordEvidence(url, String(text || ''), { timestamp: row.timestamp, title: row.title || page?.title, versionId: row.versionId });
      }
      content = JSON.stringify(payload);
    }
    return { content };
  }
}
