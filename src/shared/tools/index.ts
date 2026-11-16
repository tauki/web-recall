export { ToolsRuntime } from './runtime';
export const SAVED_MEMORY_TOOL_GUIDANCE = 'Use the supplied previews directly when they answer the question. For a precise detail missing from a preview, search_within_page locates its chunkIndex and character offset; fetch_more reads at that exact offset. Use search_memory to discover other authorized saved pages. Summary and chunk-list tools are for broad overviews, not substitutes for locating a specific fact. Repeating identical read arguments returns identical evidence, never the next passage. Follow nextArgs to advance. If a tool reports no progress, change the lookup rather than repeat it. Once saved text supports the answer, finish immediately; do not verify the same fact by rereading it.';
export type {
  FetchMoreArgs,
  GetPageChunksArgs,
  SearchMemoryArgs,
  SearchWithinPageArgs,
  SummaryArgs,
  ToolMetric,
  ToolName,
  ToolRunResult,
  ToolSearchHit,
  ToolsRuntimeOptions
} from './types';
