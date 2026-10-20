import { storageManager, type PageRecord, type HighlightRecord } from '../storage/manager';

type ListDatesParams = {
  from?: string | null;
  to?: string | null;
  offset?: number;
  limit?: number;
};

type HighlightSummary = {
  text: string;
  entries: Array<{ title: string; url: string }>;
};

function formatLocalYMD(input: number | Date | string): string {
  const base = typeof input === 'string' ? new Date(`${input}T00:00:00`) : new Date(input);
  const year = base.getFullYear();
  const month = `${base.getMonth() + 1}`.padStart(2, '0');
  const day = `${base.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildSummary(pages: PageRecord[]): HighlightSummary {
  if (pages.length === 0) {
    return { text: '', entries: [] };
  }
  const entries = pages
    .slice(0, 4)
    .map((page) => ({
      title: page.title || page.url,
      url: page.url
    }));
  const text = entries.map((entry, index) => `${index + 1}. ${entry.title}`).join('\n');
  return { text, entries };
}

export async function listHighlightDates(params: ListDatesParams): Promise<{ dates: Array<{ date: string; count: number }>; total: number }> {
  const pages = await storageManager.listAllPages();
  const counts = new Map<string, number>();
  const from = params.from ? formatLocalYMD(params.from) : null;
  const to = params.to ? formatLocalYMD(params.to) : null;
  for (const page of pages) {
    const dateKey = formatLocalYMD(page.timestamp);
    if (from && dateKey < from) continue;
    if (to && dateKey > to) continue;
    counts.set(dateKey, (counts.get(dateKey) || 0) + 1);
  }
  const sorted = Array.from(counts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const offset = Math.max(0, params.offset ?? 0);
  const limit = Math.max(1, params.limit ?? 14);
  return {
    dates: sorted.slice(offset, offset + limit),
    total: sorted.length
  };
}

export async function getHighlightForDate(date: string): Promise<HighlightSummary> {
  const formatted = formatLocalYMD(date);
  const pages = await storageManager.listAllPages();
  const todaysPages = pages.filter((page) => formatLocalYMD(page.timestamp) === formatted);
  const summary = buildSummary(todaysPages);
  const record: HighlightRecord = {
    date: formatted,
    payload: summary,
    updatedAt: Date.now()
  };
  await storageManager.upsertHighlight(record);
  return summary;
}
