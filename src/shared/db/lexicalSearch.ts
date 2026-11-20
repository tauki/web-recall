import { pageContent } from '../pageContent';
import { matchesSearchFilters, type SearchFilters } from '../searchFilters';
import { createTextMatcher, type TextMatch } from '../textSearch';
import type { PageRecord } from './index';

export type TextSearchResult = {
  url: string;
  title: string;
  snippet: string;
  score: number;
  timestamp: number;
  versionId?: string;
  containsExact: boolean;
  textMatch: true;
  match?: TextMatch;
};

export type TextSearchReply = { results: TextSearchResult[]; scopeUrls?: string[]; hasPages: boolean };
export type TextSearchScope = { signal?: AbortSignal; scopeUrls?: string[] };
export type TextRank = Pick<TextSearchResult, 'url' | 'score' | 'timestamp' | 'containsExact'>;

export function compareTextRanks(first: TextRank, second: TextRank): number {
  return Number(second.containsExact) - Number(first.containsExact) || second.score - first.score ||
    second.timestamp - first.timestamp || first.url.localeCompare(second.url) || Number(first.url > second.url) - Number(first.url < second.url);
}

export function createLexicalSearch(query: string, limit: number, filters: SearchFilters, scopeUrls?: string[]) {
  const hasQuery = Boolean(query.trim());
  const match = createTextMatcher(query, { passage: false });
  const scored: Array<{ result: TextSearchResult; snapshot: PageRecord }> = [];
  const couldImprove = (candidate: TextRank): boolean => limit > 0 && (scored.length < limit || compareTextRanks(candidate, scored.at(-1)!.result) < 0);
  const filteredUrls = Object.keys(filters).length ? [] as string[] : undefined;
  let hasPages = false;
  return {
    couldImprove,
    visit(page: PageRecord): void {
      let best: TextSearchResult | undefined;
      let matchedSnapshot: PageRecord | undefined;
      let eligible = false;
      const versions = [page, ...(page.versions || []).slice().sort((first, second) => second.timestamp - first.timestamp)];
      for (const version of versions) {
        const snapshot = { ...page, ...version, url: page.url, title: version.title || page.url, versions: undefined };
        if (!matchesSearchFilters(snapshot, filters)) continue;
        eligible = true;
        const hit = hasQuery ? match(snapshot) : { score: 0, snippet: pageContent(snapshot).slice(0, 240), containsExact: false };
        if (!hit) continue;
        const candidate: TextSearchResult = { ...hit, url: page.url, title: snapshot.title, timestamp: version.timestamp, versionId: version.versionId, textMatch: true };
        const exactDifference = Number(candidate.containsExact) - Number(Boolean(best?.containsExact));
        if (!best || exactDifference > 0 || exactDifference === 0 && candidate.score > best.score) { best = candidate; matchedSnapshot = snapshot; }
      }
      if (eligible) { hasPages = true; filteredUrls?.push(page.url); }
      if (!best || !matchedSnapshot || !couldImprove(best)) return;
      let start = 0, end = scored.length;
      while (start < end) {
        const middle = (start + end) >>> 1;
        if (compareTextRanks(best, scored[middle]!.result) < 0) end = middle;
        else start = middle + 1;
      }
      scored.splice(start, 0, { result: best, snapshot: matchedSnapshot });
      if (scored.length > limit) scored.pop();
    },
    finish(): TextSearchReply {
      const locate = createTextMatcher(query);
      const results = scored.slice(0, limit).map(({ result, snapshot }) => ({ ...result, ...(hasQuery ? locate(snapshot) : {}) }));
      return { results, scopeUrls: filteredUrls || scopeUrls, hasPages };
    }
  };
}
