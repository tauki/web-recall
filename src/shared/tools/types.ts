import type { PageRecord } from '../db/index';

export type ToolSearchHit = {
  title: string;
  url: string;
  snippet: string;
  domain?: string;
  chunkIndex?: number;
  score?: number;
  hitsFromPage?: number;
  partial?: boolean;
  timestamp?: number;
};

export type ToolsRuntimeOptions = {
  allowedUrls: Set<string>;
  pageText: Map<string, string>;
  pages: PageRecord[];
  maxSlice?: number;
  recordEvidence?: (url: string, text: string, metadata?: { timestamp?: number; title?: string }) => number;
  loadPage?: (url: string) => Promise<PageRecord | undefined>;
  maxCalls?: number;
  signal?: AbortSignal;
  onActivity?: (event: ToolActivity) => void;
  allowSearchDiscovery?: boolean;
  searchMemory: (query: string, k: number) => Promise<ToolSearchHit[]>;
};

export type ToolRunResult = {
  content: string;
};

export type ToolActivity = {
  callId: string;
  tool: string;
  status: 'started' | 'completed' | 'failed' | 'cached' | 'cancelled';
  ms?: number;
  error?: string;
};

export type ToolMetric = {
  name: ToolName;
  ms: number;
  ok: boolean;
  error?: string | null;
  deduped?: boolean;
};

export type FetchMoreArgs = {
  url: string;
  chunkIndex?: number;
  aroundChunkIndex?: number;
  radius?: number;
  start?: number;
  end?: number;
  offset?: number;
  limit?: number;
};

export type SearchMemoryArgs = { query: string; k?: number; offset?: number };
export type SearchWithinPageArgs = { url: string; query: string; k?: number; offset?: number };
export type GetPageChunksArgs = { url: string; limit?: number; offset?: number };
export type SummaryArgs = { url: string };

export type ToolName =
  | 'fetch_more'
  | 'get_page_summary'
  | 'search_memory'
  | 'get_page_chunks'
  | 'search_within_page';

export type ToolHandlerError = {
  code: string;
  message: string;
  suggest?: string;
};

export type ToolHandlerResult = {
  ok: boolean;
  content: string;
  error?: ToolHandlerError | null;
};

export type ToolsCache = {
  summary: Map<string, string>;
  search: Map<string, string>;
  searchResults: Map<string, ToolSearchHit[]>;
};

export interface ToolsHandlerContext {
  allowedUrls: Set<string>;
  pageText: Map<string, string>;
  pages: PageRecord[];
  maxSlice: number;
  searchMemory: (query: string, k: number) => Promise<ToolSearchHit[]>;
  cache: ToolsCache;
  metrics: ToolMetric[];
  usedUrls: Set<string>;
  usedUrlOrder: string[];
  getPage(url: string): PageRecord | undefined;
  extractDomain(url: string): string;
  cleanPreview(text: string, limit?: number): string;
  buildChunkRows(url: string, limit?: number, offset?: number): Array<{ chunkIndex: number; preview: string; length: number }>;
  scoreChunkMatch(text: string, query: string): number;
  ensureUrlTracked(url: string): void;
}
