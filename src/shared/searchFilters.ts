export type SearchFilters = { domain?: string; from?: number; before?: number };

export function readSearchFilters(value: unknown): SearchFilters {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Search filters must be an object.');
  const raw = value as Record<string, unknown>;
  const filters: SearchFilters = {};
  if (raw.domain !== undefined && raw.domain !== '') {
    if (typeof raw.domain !== 'string') throw new Error('Enter a valid site domain.');
    const domain = raw.domain.trim();
    try {
      const parsed = new URL(`https://${domain}`);
      if (!domain || /[\s/@?#:*]/u.test(domain) || parsed.pathname !== '/' || !parsed.hostname) throw new Error();
      filters.domain = parsed.hostname.toLowerCase().replace(/\.$/, '');
      if (!filters.domain || filters.domain.split('.').some(label => !label)) throw new Error();
    } catch { throw new Error('Enter a site domain such as example.com, without a URL path.'); }
  }
  for (const key of ['from', 'before'] as const) {
    const bound = raw[key];
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isFinite(bound) || Number.isNaN(new Date(bound).getTime())) throw new Error('Choose a valid capture date.');
    filters[key] = bound;
  }
  if (filters.from !== undefined && filters.before !== undefined && filters.from >= filters.before) throw new Error('The end date must not be earlier than the start date.');
  return filters;
}

export function readCaptureDateRange(from: string, through: string): Pick<SearchFilters, 'from' | 'before'> {
  function boundary(value: string, nextDay: boolean): number | undefined {
    if (!value) return undefined;
    const parts = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
    if (!parts) throw new Error('Choose a valid capture date.');
    const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
    const check = new Date(0); check.setFullYear(year, month - 1, day); check.setHours(12, 0, 0, 0);
    if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) throw new Error('Choose a valid capture date.');
    const date = new Date(0); date.setFullYear(year, month - 1, day + Number(nextDay)); date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  return { from: boundary(from, false), before: boundary(through, true) };
}

export function matchesSearchFilters(page: { url: string; timestamp: number }, filters: SearchFilters): boolean {
  if (filters.domain) {
    try {
      const hostname = new URL(page.url).hostname.toLowerCase().replace(/\.$/, '');
      if (hostname !== filters.domain && !hostname.endsWith(`.${filters.domain}`)) return false;
    } catch { return false; }
  }
  return Number.isFinite(page.timestamp) && (filters.from === undefined || page.timestamp >= filters.from) && (filters.before === undefined || page.timestamp < filters.before);
}
