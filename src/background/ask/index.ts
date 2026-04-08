import { storageManager } from '../storage/manager';
import { searchStoredPages } from '../search/index';
import { ToolsRuntime, type ToolMetric } from '../../shared/tools/index';
import { callChat, callChatJson, getChatConfig, type ChatConfig } from '../providers/chat';
import { getSettings } from '../settings/index';
import { getCalibrationSnapshot } from '../calibration/index';

export type AskSource = {
  index: number;
  title: string;
  url: string;
  snippet: string;
  domain: string;
};

export type AskResponse = {
  answer: string;
  sources: AskSource[];
};

export type AskOptions = {
  useSearch?: boolean;
  maxResults?: number;
  requestId?: string;
};

type SearchHit = Awaited<ReturnType<typeof searchStoredPages>>[number];

type ToolCall = {
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
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
  name?: string;
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
  return normalized.slice(0, Math.min(contextLimit, 1200));
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
    console.warn('[beta-background:ask] question decomposition failed', err);
    return fallback;
  }
}

async function gatherSearchHits(
  subQueries: string[],
  normalized: string,
  maxResults: number,
  useSearch: boolean,
  requestId?: string
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
    if (!sub) continue;
    sendProgress(`Searching memory: ${sub}`, requestId);
    try {
      const hits = await searchStoredPages(sub, Math.max(maxResults * 2, 5), {
        rewrite: false,
        rerank: false
      });
      hits.forEach((hit) => {
        const key = `${hit.url}::${hit.snippet}`;
        const existing = aggregated.get(key);
        if (!existing || existing.score < hit.score) {
          aggregated.set(key, hit);
        }
      });
    } catch (err) {
      console.warn('[beta-background:ask] search failed', err);
    }
  }
  if (!aggregated.size) {
    const fallback = await searchStoredPages(normalized, Math.max(5, maxResults), {
      rewrite: false,
      rerank: false
    });
    fallback.forEach((hit) => aggregated.set(`${hit.url}::${hit.snippet}`, hit));
  }
  return Array.from(aggregated.values()).sort((a, b) => b.score - a.score).slice(0, maxResults);
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
      const text = (record?.chunks?.find((chunk) => (chunk.text || '').trim())?.text || source.snippet || record?.text || record?.summary || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, Math.min(contextLimit, 1200));
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
        description: 'Fetch additional text slices from a stored page. Provide chunkIndex for precise snippets when possible.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            chunkIndex: { type: 'integer' },
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
        description: 'Retrieve the stored summary for a captured page',
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
        name: 'search_memory',
        description: 'Search captured memory with a semantic query and return top results',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, k: { type: 'integer' } },
          required: ['query']
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

async function createToolsRuntime(toolTimeoutMs: number): Promise<ToolsRuntime | null> {
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
      searchMemory: (query, k) => searchStoredPages(query, k, { rewrite: false, rerank: false }),
      quickSearchMemory: (query, k) => searchStoredPages(query, k, { rewrite: false, rerank: false }),
      toolTimeoutMs
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
}): Promise<string> {
  const { config, question, contextBlocks, notes, answerStyle, retryStrict } = params;
  const systemPrompt =
    `You answer questions using only the provided numbered sources. Synthesize in plain language instead of copying raw source phrases. Cite factual claims with [n]. If the sources are incomplete, say so explicitly. ${
      retryStrict ? 'Every sentence with a factual claim must include at least one valid citation.' : ''
    } Provide a ${
      answerStyle === 'detailed' ? 'detailed' : 'concise'
    } response while remaining faithful to the sources.`;
  const userPrompt = `Question: ${question}\n\nSources:\n${contextBlocks}${notes ? `\n\nAnalyst notes:\n${notes}` : ''}\n\nWrite the final answer with [n] citations.`;
  const response = await callChat(config, {
    model: config.model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    options: { temperature: 0.2 }
  });
  return (response.message?.content || '').trim();
}

async function synthesizeGroundedAnswer(params: {
  config: ChatConfig;
  question: string;
  contextBlocks: string;
  notes?: string;
  answerStyle: 'concise' | 'detailed';
  sources: AskSource[];
}): Promise<string> {
  const firstPass = await composeAnswerFromContext({
    config: params.config,
    question: params.question,
    contextBlocks: params.contextBlocks,
    notes: params.notes,
    answerStyle: params.answerStyle
  });
  if (firstPass.trim() && hasValidCitations(firstPass, params.sources)) {
    return firstPass;
  }
  const retry = await composeAnswerFromContext({
    config: params.config,
    question: params.question,
    contextBlocks: params.contextBlocks,
    notes: params.notes,
    answerStyle: params.answerStyle,
    retryStrict: true
  });
  return retry.trim();
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
    'You are preparing research notes for a final grounded answer. Review the numbered sources, use tools when needed to inspect details or gather missing context, and then write concise analyst notes with [n] citations. Do not write the final user-facing answer. End with a line "Coverage: low|medium|high".';
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
    if (!toolCalls.length || step === steps - 1) {
      return { notes: content || fallbackBulletsFromSources(sources), metrics: runtime.metrics, usedUrls: Array.from(runtime.usedUrlOrder) };
    }
    messages = [...messages, { role: 'assistant', content: resp.message?.content || '', tool_calls: toolCalls }];
    for (const call of toolCalls) {
      const name = call.function?.name;
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = call.function?.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch (err) {
        console.warn('[beta-background:ask] unable to parse tool args', err);
      }
      sendProgress(`Tool: ${name}`, requestId);
      try {
        const result = await runtime.runToolCall(name as 'fetch_more' | 'get_page_summary' | 'search_memory', args);
        messages.push({ role: 'tool', name, content: String(result.content || '') });
      } catch (err) {
        messages.push({ role: 'tool', name, content: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) });
      }
    }
    messages.push({ role: 'user', content: 'Update the analyst notes based on tool results. Keep citations as [n] and keep the coverage line.' });
  }
  return { notes: content || fallbackBulletsFromSources(sources), metrics: runtime.metrics, usedUrls: Array.from(runtime.usedUrlOrder) };
}

async function mergeToolSources(sources: AskSource[], usedUrls: string[], contextLimit: number): Promise<AskSource[]> {
  if (!usedUrls.length) return sources;
  const known = new Map(sources.map((source) => [source.url, source]));
  let cursor = sources.reduce((max, s) => Math.max(max, s.index || 0), sources.length);
  for (const url of usedUrls) {
    if (known.has(url)) continue;
    const record = await storageManager.getPageRecord(url);
    cursor += 1;
    let domain = '';
    try {
      domain = new URL(url).hostname;
    } catch {
      domain = url;
    }
    const snippet = summarizeSnippet(record?.summary || record?.text || '', Math.min(DEFAULT_SNIPPET_CHARS, contextLimit));
    known.set(url, {
      index: cursor,
      title: record?.title || url,
      url,
      snippet,
      domain
    });
  }
  return Array.from(known.values()).sort((a, b) => a.index - b.index);
}

function filterSourcesByCitations(sources: AskSource[], answerText: string): AskSource[] {
  const cited = new Set<number>();
  const citationPattern = /\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = citationPattern.exec(answerText))) {
    const num = Number(match[1]);
    if (!Number.isNaN(num) && num > 0) cited.add(num - 1);
  }
  if (!cited.size) return sources;
  const citedByIndex = new Set(
    Array.from(cited)
      .map((zeroBased) => zeroBased + 1) // stored index values are 1-based
      .filter((num) => sources.some((s) => s.index === num))
  );
  if (!citedByIndex.size) return sources;
  const picked: AskSource[] = [];
  sources.forEach((source) => {
    if (citedByIndex.has(source.index)) picked.push(source);
  });
  return picked.length ? picked : sources;
}

function filterSourcesByUsedUrls(sources: AskSource[], usedUrls: string[]): AskSource[] {
  if (!usedUrls.length) return sources;
  const usedSet = new Set(usedUrls);
  const ordered = sources.filter((source) => usedSet.has(source.url));
  return ordered.length ? ordered : sources;
}

function hasValidCitations(answerText: string, sources: AskSource[]): boolean {
  const citationPattern = /\[(\d+)\]/g;
  const valid = new Set(sources.map((source) => source.index));
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = citationPattern.exec(answerText))) {
    const num = Number(match[1]);
    if (valid.has(num)) {
      found = true;
      break;
    }
  }
  return found;
}

export async function handleAskQuestion(question: string, options?: AskOptions): Promise<AskResponse> {
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
  const config = await getChatConfig();

  sendProgress('Analyzing question…', requestId);
  const subQueries = queryRewriteEnabled ? await decomposeQuestion(normalized, config) : [normalized];

  const initialHits = await gatherSearchHits(subQueries, normalized, maxResults, options?.useSearch !== false, requestId);
  const hits = await rerankAskHits(normalized, initialHits, askRerankEnabled, config);
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
    const runtime = await createToolsRuntime(toolTimeoutMs);
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
      console.warn('[beta-background:ask] extraction failed', err);
      return null;
    });
    if (extraction?.metrics.length) {
      const summary = extraction.metrics.map((metric) => `${metric.name}:${metric.ok ? `${Math.round(metric.ms)}ms` : 'error'}`).join(', ');
      sendProgress(`Tool metrics: ${summary}`, requestId);
    }
  }

  let answer = '';
  sendProgress('Composing final answer…', requestId);
  try {
    const mergedSources = await mergeToolSources(sources, extraction?.usedUrls || [], contextLimit);
    const mergedBlocks = await buildContextFromSources(mergedSources, contextLimit);
    answer = await synthesizeGroundedAnswer({
      config,
      question: normalized,
      contextBlocks: mergedBlocks,
      notes: extraction ? stripCoverageLine(extraction.notes) : undefined,
      answerStyle: answerMode,
      sources: mergedSources
    });
    if (!answer.trim()) {
      answer = buildFallbackAnswer(mergedSources);
    }
    const filteredSources = filterSourcesByCitations(
      filterSourcesByUsedUrls(mergedSources, extraction?.usedUrls || []),
      answer
    );
    sendAnswerUpdate(answer, requestId);
    sendProgress('Answer ready.', requestId);
    return {
      answer,
      sources: filteredSources
    };
  } catch (err) {
    console.warn('[beta-background:ask] answer synthesis failed', err);
    answer = buildFallbackAnswer(sources);
  }

  sendAnswerUpdate(answer, requestId);
  sendProgress('Answer ready.', requestId);
  return {
    answer,
    sources
  };
}
