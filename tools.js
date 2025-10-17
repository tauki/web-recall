/**
 * Tool runtime for chat tool calls with schema validation, metrics, caching, and safety guardrails.
 */

export class ToolsRuntime {
  constructor(opts) {
    this.allowedUrls = opts.allowedUrls || new Set();
    this.pageText = opts.pageText || new Map();
    this.pages = opts.pages || [];
    this.maxSlice = typeof opts.maxSlice === 'number' ? opts.maxSlice : 1200;
    this.toolTimeoutMs = typeof opts.toolTimeoutMs === 'number' ? opts.toolTimeoutMs : 10000;
    this.searchMemory = opts.searchMemory; // async (query,k) => hits
    this.quickSearchMemory = opts.quickSearchMemory; // async (query,k) => hits
    this.metrics = [];
    // Track which URLs are actually used during tool invocations, preserving order
    this.usedUrls = new Set();
    this.usedUrlOrder = [];
    this.cache = {
      fetchMore: new Map(), // url -> [{s,e,text}]
      summary: new Map(), // url -> string
      search: new Map(), // key -> json string
    };
    this.calls = new Set();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------
  _sig(name, args) {
    try { return `${name}:${JSON.stringify(args)}`; } catch { return name; }
  }

  _withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }

  _maybeWithTimeout(p, ms) {
    if (!ms || ms <= 0) return p;
    return this._withTimeout(p, ms);
  }

  _validateFetchMore(args) {
    const errors = [];
    const out = {};
    if (!args || typeof args.url !== 'string' || args.url.length === 0) {
      errors.push('url (string) is required');
    } else {
      out.url = args.url;
    }
    const hasChunk = typeof args.chunkIndex === 'number';
    const hasRange = typeof args.start !== 'undefined' || typeof args.end !== 'undefined';
    // Require either chunkIndex or an explicit range; avoid defaulting to page start implicitly
    if (!hasChunk && !hasRange) {
      errors.push('provide chunkIndex or a small start/end range');
    }
    if (hasChunk) {
      out.chunkIndex = Math.max(0, args.chunkIndex|0);
    } else {
      let start = (args && typeof args.start === 'number') ? (args.start|0) : 0;
      let end = (args && typeof args.end === 'number') ? (args.end|0) : (start + this.maxSlice);
      if (start < 0) start = 0;
      if (end < start) end = start + this.maxSlice;
      out.start = start;
      out.end = end;
    }
    return { ok: errors.length === 0, value: out, errors };
  }

  _validateGetPageSummary(args) {
    const errors = [];
    const out = {};
    if (!args || typeof args.url !== 'string' || args.url.length === 0) {
      errors.push('url (string) is required');
    } else { out.url = args.url; }
    return { ok: errors.length === 0, value: out, errors };
  }

  _validateSearchMemory(args) {
    const errors = [];
    const out = {};
    if (!args || typeof args.query !== 'string' || args.query.length === 0) {
      errors.push('query (string) is required');
    } else { out.query = args.query; }
    let k = args && typeof args.k === 'number' ? (args.k|0) : 5;
    if (k < 1) k = 1; if (k > 10) k = 10;
    out.k = k;
    return { ok: errors.length === 0, value: out, errors };
  }

  _mergeRange(url, s, e, full) {
    if (!this.cache.fetchMore.has(url)) this.cache.fetchMore.set(url, []);
    const arr = this.cache.fetchMore.get(url);
    let ns = Math.max(0, s|0), ne = Math.max(ns, e|0);
    let merged = false;
    for (const r of arr) {
      if (!(ne < r.s - 50 || ns > r.e + 50)) {
        r.s = Math.min(r.s, ns); r.e = Math.max(r.e, ne); r.text = full.slice(r.s, r.e);
        merged = true; break;
      }
    }
    if (!merged) arr.push({ s: ns, e: ne, text: full.slice(ns, ne) });
    const seg = arr.find(r => ns >= r.s && ne <= r.e) || arr[arr.length - 1];
    return seg.text;
  }

  async runToolCall(name, rawArgs) {
    const started = performance.now();
    const signature = this._sig(name, rawArgs);
    if (this.calls.has(signature)) {
      this.metrics.push({ name, ms: 0, ok: true, deduped: true });
      return { content: JSON.stringify({ ok: true, data: { deduped: true }, usedArgs: rawArgs || {}, suggest: null }) };
    }
    this.calls.add(signature);
    let ok = false; let content = '';
    let error = null;
    try {
      if (name === 'fetch_more') {
        const v = this._validateFetchMore(rawArgs);
        if (!v.ok) throw { code: 'invalid_args', message: v.errors.join('; '), suggest: 'Provide { url, chunkIndex } or small { url, start, end } (<= maxSlice)' };
        const { url } = v.value;
        if (!this.allowedUrls.has(url)) throw { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory or from provided sources' };
        const full = this.pageText.get(url) || '';
        let usedArgs = { url };
        if (typeof v.value.chunkIndex === 'number') {
          const page = this.pages.find(p => p.url === url);
          const idx = v.value.chunkIndex;
          const txt = String(page?.items?.[idx]?.text || '');
          usedArgs.chunkIndex = idx;
          content = JSON.stringify({ ok: true, data: { text: txt }, usedArgs, suggest: 'Prefer { url, chunkIndex } for precise expansion' }); ok = true;
          if (!this.usedUrls.has(url)) { this.usedUrls.add(url); this.usedUrlOrder.push(url); }
        } else {
          let start = v.value.start|0; let end = v.value.end|0;
          if (start < 0) start = 0;
          if (end < start) end = start + this.maxSlice;
          end = Math.min(full.length, end);
          if (end - start > this.maxSlice) end = start + this.maxSlice;
          const txt = this._mergeRange(url, start, end, full);
          usedArgs.start = start; usedArgs.end = end;
          const note = (rawArgs && (rawArgs.start !== start || rawArgs.end !== end)) ? `range adjusted to [${start}, ${end}]` : undefined;
          content = JSON.stringify({ ok: true, data: { text: txt }, usedArgs, suggest: note ? `${note}; prefer { url, chunkIndex } when available` : 'Use small ranges (<= maxSlice) or prefer chunkIndex' }); ok = true;
          if (!this.usedUrls.has(url)) { this.usedUrls.add(url); this.usedUrlOrder.push(url); }
        }
      } else if (name === 'get_page_summary') {
        const v = this._validateGetPageSummary(rawArgs);
        if (!v.ok) throw { code: 'invalid_args', message: v.errors.join('; '), suggest: 'Call get_page_summary({ url })' };
        const { url } = v.value;
        if (!this.allowedUrls.has(url)) throw { code: 'disallowed', message: 'url not in memory', suggest: 'Use a URL returned by search_memory or from provided sources' };
        if (this.cache.summary.has(url)) content = JSON.stringify({ ok: true, data: { summary: this.cache.summary.get(url) }, usedArgs: { url }, suggest: null });
        else {
          const page = this.pages.find(p => p.url === url);
          const summary = (page && page.summary) ? page.summary : '';
          this.cache.summary.set(url, summary);
          content = JSON.stringify({ ok: true, data: { summary }, usedArgs: { url }, suggest: null });
        }
        ok = true;
        if (!this.usedUrls.has(url)) { this.usedUrls.add(url); this.usedUrlOrder.push(url); }
      } else if (name === 'search_memory') {
        const v = this._validateSearchMemory(rawArgs);
        if (!v.ok) throw { code: 'invalid_args', message: v.errors.join('; '), suggest: 'Call search_memory({ query, k? (1..10) })' };
        const key = `${v.value.query}::${v.value.k}`;
        if (this.cache.search.has(key)) { content = this.cache.search.get(key); ok = true; }
        else {
          try {
            const hits = await this._maybeWithTimeout(this.searchMemory(v.value.query, v.value.k), this.toolTimeoutMs);
            content = JSON.stringify({ ok: true, data: hits.map(h => ({ title: h.title, url: h.url, snippet: h.snippet, chunkIndex: h.chunkIndex, partial: false })), usedArgs: { query: v.value.query, k: v.value.k }, suggest: 'Use fetch_more({ url, chunkIndex }) to expand a specific hit' });
            // Track used URLs for sources ordering
            for (const h of hits) { if (!this.usedUrls.has(h.url)) { this.usedUrls.add(h.url); this.usedUrlOrder.push(h.url); } }
          } catch (e) {
            // timeout or error → quick partial
            try {
              const quick = await this.quickSearchMemory(v.value.query, v.value.k);
              content = JSON.stringify({ ok: true, data: quick.map(h => ({ ...h, partial: true })), usedArgs: { query: v.value.query, k: v.value.k }, suggest: 'Partial results; try fetch_more({ url, chunkIndex }) on a hit' });
              for (const h of quick) { if (h?.url && !this.usedUrls.has(h.url)) { this.usedUrls.add(h.url); this.usedUrlOrder.push(h.url); } }
            } catch (_) {
              content = JSON.stringify({ ok: false, error: { code: 'search_failed', message: 'search failed' }, suggest: 'Try a simpler query or smaller k (1..10)' });
            }
          }
          this.cache.search.set(key, content); ok = true;
        }
      } else {
        throw { code: 'unknown_tool', message: 'unsupported tool', suggest: 'Use one of: search_memory, fetch_more, get_page_summary' };
      }
    } catch (e) {
      const errObj = e && e.code ? e : { code: 'tool_error', message: String(e && e.message || e) };
      error = errObj;
      content = JSON.stringify({ ok: false, error: errObj, suggest: errObj.suggest || null }); ok = false;
    } finally {
      const ms = Math.round(performance.now() - started);
      this.metrics.push({ name, ms, ok, error: error?.code || null, signature });
    }
    return { content };
  }
}
