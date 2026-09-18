import { abortable } from '../../shared/abort';
import { storageManager } from '../storage/manager';
import { searchStoredPages } from '../search/index';
import { ToolsRuntime, type ToolMetric } from '../../shared/tools/index';
import { callChat, callChatJson, getChatConfig, normalizeToolArguments, streamChat, type ChatConfig } from '../providers/chat';
import { getSettings } from '../settings/index';
import { getCalibrationSnapshot } from '../calibration/index';

export type AskSource = {
  index: number;
  title: string;
  url: string;
  snippet: string;
  domain: string;
  evidence?: string;
  excerpts?: string[];
};

export type AskResponse = {
  answer: string;
  sources: AskSource[];
};

export type AskOptions = {
  useSearch?: boolean;
  maxResults?: number;
  requestId?: string;
  signal?: AbortSignal;
};

type SearchHit = Awaited<ReturnType<typeof searchStoredPages>>[number];

type ToolCall = {
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
};

type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
};

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
  tool_calls?: ToolCall[];
};

const DEFAULT_SNIPPET_CHARS = 400;
const MAX_INTERNAL_TOOL_STEPS = 100;

function sendProgress(message: string, requestId?: string): void {
  try {
    chrome.runtime.sendMessage({ type: 'ASK_PROGRESS', message, requestId });
  } catch (err) {
    console.warn('[beta-background:ask] unable to send progress event', err);
  }
}

function sendAnswerUpdate(text: string, requestId?: string): void {
  try {
    chrome.runtime.sendMessage({ type: 'ASK_ANSWER_UPDATE', chunk: text, requestId });
  } catch (err) {
    console.warn('[beta-background:ask] unable to send answer update', err);
  }
}

function summarizeSnippet(text: string, limit = DEFAULT_SNIPPET_CHARS): string {
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function selectContextExcerpt(
  record: Awaited<ReturnType<typeof storageManager.getPageRecord>>,
  hit: SearchHit,
  contextLimit: number
): string {
  const directChunkText = typeof hit.chunkIndex === 'number' ? record?.chunks?.[hit.chunkIndex]?.text || '' : '';
  const fallbackChunkText = record?.chunks?.find((chunk) => (chunk.text || '').trim())?.text || '';
  const chunkText = directChunkText || fallbackChunkText;
  const preferred = chunkText || hit.snippet || record?.text || record?.summary || '';
  const normalized = preferred.replace(/\s+/g, ' ').trim();
  return normalized.slice(0, contextLimit);
}

function heuristicDecompose(question: string): string[] {
  const trimmed = question.trim();
  if (!trimmed) return [];
  const subs = new Set<string>([trimmed]);
  const split = trimmed.split(/[.?!]/).map((chunk) => chunk.trim()).filter(Boolean);
  split.forEach((chunk) => subs.add(chunk));
  return Array.from(subs);
}

async function decomposeQuestion(question: string, config: ChatConfig): Promise<string[]> {
  config.signal?.throwIfAborted();
  const fallback = heuristicDecompose(question);
  try {
    const body = {
      model: config.model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You break complex user questions into multiple search queries. Return each query on its own line without numbering.'
        },
        { role: 'user', content: `Question:\n${question}\n\nQueries:` }
      ]
    };
    const resp = await callChat(config, body);
    const content = resp.message?.content?.trim();
    if (!content) return fallback;
    const set = new Set<string>(fallback);
    content
      .split('\n')
      .map((line) => line.replace(/^\d+[.)-]\s*/, '').trim())
      .filter(Boolean)
      .forEach((entry) => set.add(entry));
    return Array.from(set);
  } catch (err) {
    config.signal?.throwIfAborted();
    console.warn('[beta-background:ask] question decomposition failed', err);
    return fallback;
  }
}

async function gatherSearchHits(
  subQueries: string[],
  normalized: string,
  maxResults: number,
  useSearch: boolean,
  requestId?: string,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  if (!useSearch) {
    const recents = await storageManager.listRecentPages(maxResults);
    return recents.map((page) => ({
      url: page.url,
      title: page.title || page.url,
      snippet: page.chunks?.[0]?.text || page.text?.slice(0, 200) || '',
      timestamp: page.timestamp,
      score: 1
    }));
  }
  const aggregated = new Map<string, SearchHit>();
  for (const sub of subQueries) {
    signal?.throwIfAborted();
    if (!sub) continue;
    sendProgress(`Searching memory: ${sub}`, requestId);
    try {
      const hits = await searchStoredPages(sub, Math.max(maxResults * 2, 5), {
        rewrite: false,
        rerank: false, signal
      });
      hits.forEach((hit) => {
        const key = `${hit.url}::${hit.snippet}`;
        const existing = aggregated.get(key);
        if (!existing || existing.score < hit.score) {
          aggregated.set(key, hit);
        }
      });
    } catch (err) {
      signal?.throwIfAborted();
      console.warn('[beta-background:ask] search failed', err);
    }
  }
  if (!aggregated.size) {
    const fallback = await searchStoredPages(normalized, Math.max(5, maxResults), {
      rewrite: false,
      rerank: false, signal
    });
    fallback.forEach((hit) => aggregated.set(`${hit.url}::${hit.snippet}`, hit));
  }
  return Array.from(aggregated.values()).sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function dedupeAskHitsByUrl(hits: SearchHit[]): SearchHit[] {
  const merged = new Map<string, SearchHit & { _snippets?: string[] }>();
  for (const hit of hits) {
    const existing = merged.get(hit.url);
    const snippet = (hit.snippet || '').trim();
    if (!existing) {
      merged.set(hit.url, {
        ...hit,
        _snippets: snippet ? [snippet] : []
      });
      continue;
    }
    if ((hit.score || 0) > (existing.score || 0)) {
      existing.score = hit.score;
      existing.chunkIndex = hit.chunkIndex;
      existing.timestamp = hit.timestamp;
      existing.title = hit.title;
    }
    if (typeof hit.crossScore === 'number' && (typeof existing.crossScore !== 'number' || hit.crossScore > existing.crossScore)) {
      existing.crossScore = hit.crossScore;
    }
    if (snippet && !existing._snippets?.includes(snippet)) {
      existing._snippets = [...(existing._snippets || []), snippet].slice(0, 3);
    }
  }
  return Array.from(merged.values()).map((hit) => ({
    ...hit,
    snippet: (hit._snippets || []).join('\n\n')
  }));
}

async function fetchPageContext(
  hit: SearchHit,
  index: number,
  contextLimit: number
): Promise<{ block: string; source: AskSource }> {
  const record = await storageManager.getPageRecord(hit.url);
  const contextText = selectContextExcerpt(record, hit, contextLimit);
  const snippet = summarizeSnippet(hit.snippet || contextText, Math.min(DEFAULT_SNIPPET_CHARS, contextLimit));
  const domain = (() => {
    try {
      return new URL(hit.url).hostname;
    } catch {
      return hit.url;
    }
  })();
  const block = `[${index}] Title: ${record?.title || hit.title || hit.url}\n${contextText.slice(0, contextLimit)}`;
  return {
    block,
    source: {
      index,
      title: record?.title || hit.title || hit.url,
      url: hit.url,
      snippet,
      evidence: contextText,
      domain
    }
  };
}

async function buildContextBlocks(hits: SearchHit[], contextLimit: number): Promise<{ blocks: string; sources: AskSource[] }> {
  const entries = await Promise.all(hits.map((hit, idx) => fetchPageContext(hit, idx + 1, contextLimit)));
  return {
    blocks: entries.map((entry) => entry.block).join('\n\n'),
    sources: entries.map((entry) => entry.source)
  };
}

async function buildContextFromSources(sources: AskSource[], contextLimit: number): Promise<string> {
  const blocks = await Promise.all(
    sources.map(async (source) => {
      const record = await storageManager.getPageRecord(source.url);
      const excerpts = source.excerpts || [source.evidence || source.snippet || record?.text || record?.summary || ''];
      const text = excerpts.map((excerpt) => excerpt.slice(0, Math.floor(contextLimit / excerpts.length))).join('\n')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, contextLimit);
      return `[${source.index}] Title: ${record?.title || source.title}\n${text.slice(0, contextLimit)}`;
    })
  );
  return blocks.join('\n\n');
}

function buildToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'fetch_more',
        description: 'Fetch more text from a stored page. Prefer chunkIndex for one chunk or aroundChunkIndex plus radius for neighboring chunks.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            chunkIndex: { type: 'integer' },
            aroundChunkIndex: { type: 'integer' },
            radius: { type: 'integer' },
            start: { type: 'integer' },
            end: { type: 'integer' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_page_summary',
        description: 'Retrieve structured summary metadata for a captured page before deciding whether to inspect chunks',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_page_chunks',
        description: 'List chunk previews for a captured page so you can choose the most relevant section',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            limit: { type: 'integer' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_memory',
        description: 'Search captured memory with a semantic query and return page-level candidates with chunk hints',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, k: { type: 'integer' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_within_page',
        description: 'Search within one captured page to find the best matching chunks before fetching more text',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            query: { type: 'string' },
            k: { type: 'integer' }
          },
          required: ['url', 'query']
        }
      }
    }
  ];
}

function resolveToolStepBudget(maxToolSteps: number): number {
  if (!Number.isFinite(maxToolSteps) || maxToolSteps <= 0) {
    return MAX_INTERNAL_TOOL_STEPS;
  }
  return Math.max(1, Math.min(Math.round(maxToolSteps), MAX_INTERNAL_TOOL_STEPS));
}

async function createToolsRuntime(toolTimeoutMs: number, sources: AskSource[], contextLimit: number, signal?: AbortSignal): Promise<ToolsRuntime | null> {
  try {
    const pages = await storageManager.listAllPages();
    const pageText = new Map<string, string>();
    for (const page of pages) {
      if (page.text) {
        pageText.set(page.url, page.text);
      } else if (page.chunks?.length) {
        pageText.set(page.url, page.chunks.map((chunk) => chunk.text || '').join('\n'));
      } else {
        pageText.set(page.url, '');
      }
    }
    return new ToolsRuntime({
      allowedUrls: new Set(pages.map((page) => page.url)),
      pageText,
      pages,
      searchMemory: (query, k) => searchStoredPages(query, k, { rewrite: false, rerank: false, signal }),
      quickSearchMemory: (query, k) => searchStoredPages(query, k, { rewrite: false, rerank: false, signal }),
      toolTimeoutMs,
      recordEvidence: (url, text) => {
        let source = sources.find((entry) => entry.url === url);
        if (!source) {
          const page = pages.find((entry) => entry.url === url);
          source = { index: sources.length + 1, url, title: page?.title || url, domain: new URL(url).hostname, snippet: summarizeSnippet(text), evidence: text.slice(0, contextLimit) };
          sources.push(source);
        } else if (text && !(source.evidence || '').includes(text)) {
          source.excerpts = [...new Set([...(source.excerpts || [source.evidence || source.snippet]), text])];
        }
        return source.index;
      }
    });
  } catch (err) {
    console.warn('[beta-background:ask] tools runtime unavailable', err);
    return null;
  }
}

function fallbackBulletsFromSources(sources: AskSource[]): string {
  if (!sources.length) return 'No indexed context available.';
  return sources
    .map((source) => `- ${source.snippet || source.title} [${source.index}]`)
    .join('\n');
}

function stripCoverageLine(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^coverage:\s*(low|medium|high)\s*$/i.test(line.trim()))
    .join('\n')
    .trim();
}

async function rerankAskHits(question: string, hits: SearchHit[], enabled: boolean, config: ChatConfig): Promise<SearchHit[]> {
  if (!enabled || hits.length <= 1) return hits;
  const ranked = hits.slice();
  const pool = ranked.slice(0, Math.min(10, ranked.length));
  try {
    const parsed = await callChatJson<Record<string, unknown>>(config, {
      model: config.model,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'Score each candidate for usefulness in answering the question from 0 to 10. Return JSON only. The JSON must be an object whose keys are candidate ids and whose values are numeric scores. Example: {"1": 9.0, "2": 4.5}'
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nCandidates:\n${pool
            .map(
              (hit, index) =>
                `${index + 1}. Title: ${hit.title}\nSnippet: ${hit.snippet || '(empty)'}`
            )
            .join('\n\n')}\n\nReturn JSON only.\nSchema: {"1": 0-10, "2": 0-10}\nExample: {"1": 9.0, "2": 4.5}`
        }
      ],
      options: { temperature: 0 }
    });
    if (parsed) {
      pool.forEach((hit, index) => {
        const raw = parsed[String(index + 1)];
        const score = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isFinite(score)) {
          hit.score = Math.max(0, Math.min(10, score)) / 10;
        }
      });
    }
  } catch (err) {
    config.signal?.throwIfAborted();
    console.warn('[beta-background:ask] ask rerank failed', err);
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

async function composeAnswerFromContext(params: {
  config: ChatConfig;
  question: string;
  contextBlocks: string;
  notes?: string;
  answerStyle: 'concise' | 'detailed';
  retryStrict?: boolean;
  requestId?: string;
}): Promise<string> {
  const { config, question, contextBlocks, notes, answerStyle, retryStrict } = params;
  const systemPrompt =
    `You answer questions using only the provided numbered sources. Synthesize in plain language instead of copying raw source phrases. Cite factual claims with [n]. If the sources are incomplete, say so explicitly. ${
      retryStrict ? 'Every sentence with a factual claim must include at least one valid citation.' : ''
    } Provide a ${
      answerStyle === 'detailed' ? 'detailed' : 'concise'
    } response while remaining faithful to the sources.`;
  const userPrompt = `Question: ${question}\n\nSources:\n${contextBlocks}${notes ? `\n\nAnalyst notes:\n${notes}` : ''}\n\nWrite the final answer with [n] citations.`;
  return streamChat(config, {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    options: { temperature: 0.2 }
  }, (text) => sendAnswerUpdate(text, params.requestId));
}

async function synthesizeGroundedAnswer(params: {
  config: ChatConfig;
  question: string;
  contextBlocks: string;
  notes?: string;
  answerStyle: 'concise' | 'detailed';
  sources: AskSource[];
  requestId?: string;
}): Promise<string> {
  const firstPass = await composeAnswerFromContext({
    config: params.config,
    question: params.question,
    contextBlocks: params.contextBlocks,
    notes: params.notes,
    answerStyle: params.answerStyle,
    requestId: params.requestId
  });
  if (firstPass.trim() && hasValidCitations(firstPass, params.sources)) {
    return firstPass;
  }
  sendAnswerUpdate('', params.requestId);
  const retry = await composeAnswerFromContext({
    config: params.config,
    question: params.question,
    contextBlocks: params.contextBlocks,
    notes: params.notes,
    answerStyle: params.answerStyle,
    requestId: params.requestId,
    retryStrict: true
  });
  return hasValidCitations(retry, params.sources) ? retry.trim() : 'I could not verify the references for this answer. Please try again.';
}

function buildFallbackAnswer(sources: AskSource[]): string {
  if (!sources.length) {
    return 'I could not find enough captured context to answer that yet.';
  }
  return 'I found relevant captured pages, but the chat model returned an empty answer. Check the selected chat model or open Logs for the raw failure details.';
}

async function runExtractionWithTools(params: {
  config: ChatConfig;
  question: string;
  contextBlocks: string;
  runtime: ToolsRuntime | null;
  sources: AskSource[];
  enableTools: boolean;
  maxToolSteps: number;
  requestId?: string;
}): Promise<{ notes: string; metrics: ToolMetric[]; usedUrls: string[] }> {
  const { config, question, contextBlocks, runtime, sources, enableTools, maxToolSteps, requestId } = params;
  const systemPrompt =
    'You are preparing research notes for a final grounded answer. Review the numbered sources, use tools when needed to inspect details or gather missing context, and then write concise analyst notes with [n] citations. Prefer this sequence: search_memory -> get_page_summary or get_page_chunks -> search_within_page or fetch_more only when needed. Avoid redundant tool calls. Do not write the final user-facing answer. End with a line "Coverage: low|medium|high".';
  const userPrompt =
    `Question: ${question}\n\nContext:\n${contextBlocks}\n\nUse tools only if they materially improve the answer. Then produce:\n` +
    `- Key facts with [n] citations\n- Any uncertainty or gaps\n- Coverage line`;
  if (!runtime || !enableTools) {
    return {
      notes: fallbackBulletsFromSources(sources),
      metrics: [],
      usedUrls: sources.map((source) => source.url)
    };
  }
  let messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  let content = '';
  const tools = buildToolDefinitions();
  const steps = resolveToolStepBudget(maxToolSteps);
  for (let step = 0; step < steps; step += 1) {
    config.signal?.throwIfAborted();
    const resp = await callChat(config, {
      model: config.model,
      stream: false,
      messages,
      tools,
      tool_choice: 'auto',
      options: { temperature: 0.2 }
    });
    const toolCalls = resp.message?.tool_calls || [];
    content = resp.message?.content || content;
    if (!toolCalls.length) {
      return { notes: content || fallbackBulletsFromSources(sources), metrics: runtime.metrics, usedUrls: Array.from(runtime.usedUrlOrder) };
    }
    messages = [...messages, { role: 'assistant', content: resp.message?.content || '', tool_calls: toolCalls }];
    for (const call of toolCalls) {
      config.signal?.throwIfAborted();
      const name = call.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = normalizeToolArguments(call.function?.arguments);
      } catch (err) {
        config.signal?.throwIfAborted();
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify({ ok: false, error: String(err) }) });
        continue;
      }
      sendProgress(`Tool: ${name}`, requestId);
      try {
        const result = await abortable(runtime.runToolCall(
          name as 'fetch_more' | 'get_page_summary' | 'search_memory' | 'get_page_chunks' | 'search_within_page',
          args
        ), config.signal);
        messages.push({ role: 'tool', tool_name: name, content: String(result.content || '') });
      } catch (err) {
        config.signal?.throwIfAborted();
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) });
      }
    }
    messages.push({ role: 'user', content: 'Update the analyst notes based on tool results. Use the sourceIndex returned by tools for [n] citations and keep the coverage line.' });
  }
  return { notes: content || fallbackBulletsFromSources(sources), metrics: runtime.metrics, usedUrls: Array.from(runtime.usedUrlOrder) };
}

function filterSourcesByCitations(sources: AskSource[], answerText: string): AskSource[] {
  const cited = new Set<number>();
  const citationPattern = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = citationPattern.exec(answerText))) {
    const num = Number(match[1]);
    if (!Number.isNaN(num) && num > 0) cited.add(num - 1);
  }
  if (!cited.size) return [];
  const citedByIndex = new Set(
    Array.from(cited)
      .map((zeroBased) => zeroBased + 1) // stored index values are 1-based
      .filter((num) => sources.some((s) => s.index === num))
  );
  if (!citedByIndex.size) return [];
  const picked: AskSource[] = [];
  sources.forEach((source) => {
    if (citedByIndex.has(source.index)) picked.push(source);
  });
  return picked;
}

function hasValidCitations(answerText: string, sources: AskSource[]): boolean {
  const citationPattern = /\[(\d+)\]/g;
  const valid = new Set(sources.map((source) => source.index));
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = citationPattern.exec(answerText))) {
    const num = Number(match[1]);
    if (!valid.has(num)) return false;
    found = true;
  }
  return found;
}

async function runAskQuestion(question: string, options?: AskOptions): Promise<AskResponse> {
  const signal = options?.signal;
  signal?.throwIfAborted();
  const normalized = question?.trim();
  if (!normalized) {
    throw new Error('Please enter a question');
  }
  const settings = await getSettings();
  const defaultSources = settings.askMaxSources ?? 0;
  const answerMode = settings.answerMode === 'detailed' ? 'detailed' : 'concise';
  const calibration = getCalibrationSnapshot();
  const baseContext = Math.max(400, Math.min(6000, settings.contextWindowChars ?? 1200));
  const contextLimit = Math.round(baseContext * (1 + calibration.wLLM));
  const maxResultsInput = options?.maxResults;
  const dynamicLimit = Math.max(5, Math.round(((defaultSources || 10) * (1 + calibration.wLLM)) || 10));
  const maxResults = typeof maxResultsInput === 'number' && maxResultsInput > 0 ? Math.max(1, maxResultsInput) : dynamicLimit;
  const enableTools = settings.enableTools !== false;
  const maxToolSteps = Math.max(0, settings.maxToolSteps ?? 0);
  const toolTimeoutMs = Math.max(1000, settings.toolTimeoutMs ?? 8000);
  const queryRewriteEnabled = settings.queryRewrite !== false;
  const askRerankEnabled = settings.askRerank !== false;
  const useToolAugmentation = enableTools;
  const requestId = options?.requestId;
  const config = { ...await getChatConfig(), signal };
  signal?.throwIfAborted();

  sendProgress('Analyzing question…', requestId);
  const subQueries = queryRewriteEnabled ? await decomposeQuestion(normalized, config) : [normalized];

  const initialHits = await gatherSearchHits(subQueries, normalized, maxResults, options?.useSearch !== false, requestId, signal);
  signal?.throwIfAborted();
  const dedupedHits = dedupeAskHitsByUrl(initialHits);
  const hits = await rerankAskHits(normalized, dedupedHits, askRerankEnabled, config);
  signal?.throwIfAborted();
  if (!hits.length) {
    const message = 'I could not find any captured pages related to your question yet. Try browsing a few articles first.';
    sendProgress(message, requestId);
    return { answer: message, sources: [] };
  }

  sendProgress(`Found ${hits.length} candidate page${hits.length === 1 ? '' : 's'}. Building context…`, requestId);
  const { blocks, sources } = await buildContextBlocks(hits, contextLimit);
  let extraction:
    | { notes: string; metrics: ToolMetric[]; usedUrls: string[] }
    | null = null;
  if (useToolAugmentation) {
    const runtime = await createToolsRuntime(toolTimeoutMs, sources, contextLimit, signal);
    sendProgress('Running tool-augmented extraction…', requestId);
    extraction = await runExtractionWithTools({
      config,
      question: normalized,
      contextBlocks: blocks,
      runtime,
      sources,
      enableTools,
      maxToolSteps,
      requestId
    }).catch((err) => {
      signal?.throwIfAborted();
      console.warn('[beta-background:ask] extraction failed', err);
      return null;
    });
    if (extraction?.metrics.length) {
      const summary = extraction.metrics.map((metric) => `${metric.name}:${metric.ok ? `${Math.round(metric.ms)}ms` : 'error'}`).join(', ');
      sendProgress(`Tool metrics: ${summary}`, requestId);
    }
  }

  let answer = '';
  signal?.throwIfAborted();
  sendProgress('Composing final answer…', requestId);
  try {
    const mergedSources = sources;
    const mergedBlocks = await buildContextFromSources(mergedSources, contextLimit);
    answer = await synthesizeGroundedAnswer({
      config,
      question: normalized,
      contextBlocks: mergedBlocks,
      notes: extraction ? stripCoverageLine(extraction.notes) : undefined,
      answerStyle: answerMode,
      sources: mergedSources,
      requestId
    });
    if (!answer.trim()) {
      answer = buildFallbackAnswer(mergedSources);
    }
    const filteredSources = filterSourcesByCitations(mergedSources, answer);
    sendAnswerUpdate(answer, requestId);
    sendProgress('Answer ready.', requestId);
    return {
      answer,
      sources: filteredSources
    };
  } catch (err) {
    signal?.throwIfAborted();
    console.warn('[beta-background:ask] answer synthesis failed', err);
    answer = buildFallbackAnswer(sources);
  }

  sendAnswerUpdate(answer, requestId);
  sendProgress('Answer ready.', requestId);
  return {
    answer,
    sources: filterSourcesByCitations(sources, answer)
  };
}

const activeRequests = new Map<string, AbortController>();

export function cancelAskQuestion(requestId: string): boolean {
  const controller = activeRequests.get(requestId);
  if (!controller) return false;
  controller.abort(new Error('Answer stopped'));
  return true;
}

export async function handleAskQuestion(question: string, options?: AskOptions): Promise<AskResponse> {
  const requestId = options?.requestId || crypto.randomUUID();
  if (activeRequests.has(requestId)) throw new Error('This question is already running');
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  try {
    return await abortable(runAskQuestion(question, { ...options, requestId, signal: controller.signal }), controller.signal);
  } finally {
    if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
  }
}
