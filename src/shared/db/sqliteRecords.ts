import type { Database } from '@sqlite.org/sqlite-wasm';
import type { FailedProcessingTarget, PageRecord, ProcessingEntry, ProcessingSummary } from './index';
import { forgetVersions, matchesReconciledJob, nextPageRecord, nextProcessingEntry, updatedSummary, versionEdit, type PageWrite, type PageWriteOptions } from './recordChanges';
import { identifySavedVersions, readVersionSelection, versionSnapshot, versionSource, type SavedVersionSelection, type SavedVersionSource } from '../pageHistory';
import { matchesSearchFilters, readSearchFilters, type SearchFilters } from '../searchFilters';
import type { RecentCursor, RecentPageBatch } from '../recents';
import { parseSqliteRecord, putSqliteJob, putSqlitePage, requireActiveLibrary, urlOrderKey } from './sqliteLibrary';
import { SemanticRecords } from './semanticRecords';
import { compareTextRanks, createLexicalSearch, type TextRank, type TextSearchReply } from './lexicalSearch';
import { sqlitePayloadSize } from './sqlitePayload';
import { decodeTextIndex } from './textIndex';
import { createTextBound } from '../textSearch';
import { searchPageRecord } from './search';

const MAX_BATCH_ROWS = 64;
const BATCH_TARGET = 2 * 1024 * 1024;
const SEARCH_PAGES = 'saved_pages as page indexed by saved_pages_by_url_order left join saved_search as projection using(url_order)';

export type LibraryOperation =
  | { op: 'read' | 'searchPage' | 'versions' | 'job' | 'removeJob'; url: string }
  | { op: 'pages' | 'jobs' | 'search'; after?: string; limit?: number }
  | { op: 'jobSummaries' | 'failedJobTargets' }
  | { op: 'searchText'; query: string; limit: number; filters: SearchFilters; scopeUrls?: string[] }
  | { op: 'recents' | 'recentRecords'; limit: number; after?: RecentCursor }
  | { op: 'save'; record: PageWrite; options?: PageWriteOptions }
  | { op: 'editVersion'; url: string; versionId: string; action: 'keep' | 'release' | 'delete' }
  | { op: 'summary'; url: string; text: string; summary: string; expected?: string; title?: string; versionId?: string | null }
  | { op: 'delete'; urls: string[]; filters?: SearchFilters }
  | { op: 'forget'; selection: SavedVersionSelection[]; filters: SearchFilters }
  | { op: 'appendJob'; entry: ProcessingEntry }
  | { op: 'semanticTop'; queries: number[][]; limit: number; key: string }
  | { op: 'semanticChunks'; queries: number[][]; question: string; key: string; urls: string[] }
  | { op: 'invalidateSemantic' }
  | { op: 'setJob'; entry: ProcessingEntry; create: boolean };

function batchLimit(value: number): number {
  return Number.isInteger(value) ? Math.min(MAX_BATCH_ROWS, Math.max(0, value)) : 0;
}

function validUrl(url: unknown): url is string { return typeof url === 'string' && Boolean(url); }
function optionalText(value: unknown): boolean { return value === undefined || typeof value === 'string'; }

function validJob(entry: ProcessingEntry): boolean {
  const payload = entry?.payload;
  return Boolean(entry && validUrl(entry.url) && typeof entry.title === 'string' &&
    ['queued', 'processing', 'failed', 'done'].includes(entry.status) &&
    [entry.attempts, entry.createdAt, entry.updatedAt, entry.lastAttemptAt].every(Number.isFinite) &&
    (payload === undefined || (payload && payload.url === entry.url && typeof payload.title === 'string' &&
      Number.isFinite(payload.timestamp) && typeof payload.text === 'string' && Array.isArray(payload.chunks) &&
      payload.chunks.every(text => typeof text === 'string') && optionalText(payload.captureId))));
}

function validPageWrite(record: PageWrite, options?: PageWriteOptions): boolean {
  if (!record || !validUrl(record.url) || typeof record.title !== 'string' || typeof record.text !== 'string' || !Array.isArray(record.chunks)) return false;
  if (options === undefined) return true;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  return [options.requireProcessing, options.replace, options.preserveMissingEmbeddings, options.discardProcessing].every(value => value === undefined || typeof value === 'boolean') &&
    (options.expectedUpdatedAt === undefined || Number.isFinite(options.expectedUpdatedAt)) &&
    (options.expectedCaptureId === null || optionalText(options.expectedCaptureId)) &&
    (options.captureEntry === undefined || validJob(options.captureEntry));
}

export class SqliteRecords {
  private readonly semantic = new SemanticRecords();

  constructor(private readonly db: Database, id: string) {
    requireActiveLibrary(db, id);
  }

  page(url: string, search = false): PageRecord | undefined {
    if (search) return this.searchPage(this.db.selectValue('select record from saved_search where url_order=?', [urlOrderKey(url)]), url);
    return parseSqliteRecord(this.db.selectValue('select record from saved_pages where url=?', [url]), url);
  }

  private searchPage(raw: unknown, url: string): PageRecord | undefined {
    let record: PageRecord | undefined;
    try { if (raw instanceof Uint8Array) record = parseSqliteRecord<PageRecord>(raw, url); }
    catch { record = undefined; }
    if (record) return record;
    const source = this.page(url);
    return source && searchPageRecord(source);
  }

  job(url: string): ProcessingEntry | undefined {
    return parseSqliteRecord(this.db.selectValue('select record from saved_processing where url=?', [url]), url);
  }

  private jobSummaries(): ProcessingSummary[] {
    const rows = this.db.selectArrays(`select url,json_extract(record,'$.url','$.title','$.status','$.attempts','$.updatedAt','$.error','$.textSaved')
      from saved_processing order by url`);
    return rows.map<ProcessingSummary>(([url, metadata]) => {
      if (!validUrl(url) || typeof metadata !== 'string') throw new Error('Invalid saved capture job.');
      const [recordUrl, title, status, attempts, updatedAt, error, textSaved] = JSON.parse(metadata) as unknown[];
      if (url !== recordUrl || typeof title !== 'string' || typeof attempts !== 'number' || typeof updatedAt !== 'number' ||
          (status !== 'queued' && status !== 'processing' && status !== 'failed' && status !== 'done')) {
        throw new Error('Invalid saved capture job.');
      }
      return { url, title, status, attempts, updatedAt, error: typeof error === 'string' ? error : undefined,
        textSaved: typeof textSaved === 'boolean' ? textSaved : undefined };
    }).sort((first, second) => second.updatedAt - first.updatedAt);
  }

  private failedJobTargets(): FailedProcessingTarget[] {
    const rows = this.db.selectArrays(`select url,json_extract(record,'$.payload.captureId') from saved_processing
      where json_extract(record,'$.status')='failed' and json_type(record,'$.payload')='object'
      order by json_extract(record,'$.updatedAt') desc,url`);
    return rows.map(([url, captureId]) => {
      if (!validUrl(url) || (typeof captureId !== 'string' && captureId !== null)) throw new Error('Invalid saved capture job.');
      return { url, captureId };
    });
  }

  private revision(kind: 'pages' | 'jobs'): number {
    const revision = this.db.selectValue(kind === 'jobs' ? 'select job_revision from saved_library' : 'select page_revision from saved_library');
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid saved library revision.');
    return revision;
  }

  batch(kind: 'pages' | 'search' | 'jobs', after?: string, limit = MAX_BATCH_ROWS): { records: (PageRecord | ProcessingEntry)[]; after: string | null; revision: number } {
    const count = batchLimit(limit);
    const revision = this.revision(kind === 'jobs' ? 'jobs' : 'pages');
    if (!count) return { records: [], after: null, revision };
    const table = kind === 'jobs' ? 'saved_processing' : kind === 'search' ? SEARCH_PAGES : 'saved_pages';
    const order = kind === 'jobs' ? 'url' : kind === 'search' ? 'page.url_order' : 'url_order';
    const fields = kind === 'search' ? 'page.url,projection.record' : 'url,record';
    const { records, more } = this.readBatch<PageRecord | ProcessingEntry>(
      'select ' + fields + ' from ' + table + (after === undefined ? '' : ' where ' + order + '>?') + ' order by ' + order + ' limit ?',
      after === undefined ? [count + 1] : [kind === 'jobs' ? after : urlOrderKey(after), count + 1], count, kind === 'search');
    return { records, after: more ? records.at(-1)!.url : null, revision };
  }

  private readBatch<RecordType extends { url: string }>(sql: string, bind: (string | number | Uint8Array)[], count: number, projection = false) {
    const stmt = this.db.prepare(sql);
    const records: RecordType[] = [];
    let size = 0;
    try {
      stmt.bind(bind);
      while (stmt.step()) {
        const raw = stmt.get(1), url = stmt.get(0);
        if (typeof url !== 'string') throw new Error('Invalid saved library row.');
        if (records.length >= count) return { records, more: true };
        const storedSize = projection ? undefined : sqlitePayloadSize(raw);
        if (records.length && storedSize !== undefined && size + storedSize > BATCH_TARGET) return { records, more: true };
        const record = projection ? this.searchPage(raw, url) as RecordType | undefined : parseSqliteRecord<RecordType>(raw, url);
        if (!record) throw new Error('Missing saved library row.');
        const weight = storedSize ?? JSON.stringify(record).length;
        if (records.length && size + weight > BATCH_TARGET) return { records, more: true };
        records.push(record);
        size += weight;
      }
      return { records, more: false };
    } finally { stmt.finalize(); }
  }

  recentRecords(limit: number, after?: RecentCursor) {
    const count = batchLimit(limit), revision = this.revision('pages');
    if (!count) return { records: [], after: null, revision };
    const { records, more } = this.readBatch<PageRecord>(`select url,record from saved_pages ${after ? 'where (captured_at,url)<(?,?)' : ''}
      order by captured_at desc, url desc limit ?`, after ? [after.timestamp, after.url, count + 1] : [count + 1], count);
    const last = records.at(-1);
    return { records, after: more && last ? { url: last.url, title: last.title, timestamp: last.timestamp } : null, revision };
  }

  recent(limit: number, after?: RecentCursor): RecentPageBatch {
    const count = batchLimit(limit);
    if (!count) return { pages: [], nextCursor: null };
    const rows = this.db.selectArrays(`select captured_at,url,title from saved_pages ${after ? 'where (captured_at,url)<(?,?)' : ''}
      order by captured_at desc, url desc limit ?`, after ? [after.timestamp, after.url, count + 1] : [count + 1]);
    const pages = rows.slice(0, count).map(row => {
      const [timestamp, url, title] = row;
      if (typeof timestamp !== 'number' || typeof url !== 'string' || typeof title !== 'string') throw new Error('Invalid saved page metadata.');
      return { timestamp, url, title: title || url };
    });
    return { pages, nextCursor: rows.length > count ? pages.at(-1)! : null };
  }

  save(record: PageWrite, options: PageWriteOptions = {}): void {
    this.db.transaction(() => {
      const current = this.page(record.url);
      if (options.expectedUpdatedAt !== undefined) {
        if (current?.updatedAt !== options.expectedUpdatedAt) throw new Error('Page update aborted');
      } else if (options.requireProcessing) {
        const job = this.job(record.url);
        if (!job || (options.expectedCaptureId !== undefined && (job.payload?.captureId ?? null) !== options.expectedCaptureId)) {
          throw new Error('Page update aborted');
        }
      }
      const next = nextPageRecord(record, current, options, Date.now());
      putSqlitePage(this.db, next);
      if (options.captureEntry) {
        if (options.captureEntry.url !== record.url) throw new Error('The capture job does not match the saved page.');
        putSqliteJob(this.db, options.captureEntry);
      }
      if (options.discardProcessing || (options.reconcileFailedProcessing && matchesReconciledJob(next, this.job(record.url), options.reconcileFailedProcessing))) {
        this.removeJob(record.url);
      }
    });
  }

  versions(url: string) {
    return this.db.transaction(() => {
      const page = this.page(url);
      if (!page) return [];
      const identified = identifySavedVersions(page);
      if (!page.versionId || page.versions?.some(version => !version.versionId)) putSqlitePage(this.db, identified);
      return [versionSnapshot(identified), ...(identified.versions || [])];
    });
  }

  editVersion(url: string, versionId: string, action: 'keep' | 'release' | 'delete'): SavedVersionSource[] {
    return this.db.transaction(() => {
      const result = versionEdit(this.page(url), versionId, action);
      putSqlitePage(this.db, result.page);
      return result.removed;
    });
  }

  summary(url: string, text: string, summary: string, expected?: string, title?: string, versionId?: string | null): boolean {
    return this.db.transaction(() => {
      const next = updatedSummary(this.page(url), text, summary, expected, title, versionId);
      if (!next) return false;
      putSqlitePage(this.db, next);
      return true;
    });
  }

  delete(urls: string[], filters?: SearchFilters) {
    return this.db.transaction(() => {
      const result = { deleted: 0, removedVersions: [] as SavedVersionSource[] };
      for (const url of new Set(urls)) {
        const page = this.page(url);
        if (filters && (!page || !matchesSearchFilters(page, filters))) continue;
        if (page) {
          result.deleted++;
          result.removedVersions.push(...[versionSnapshot(page), ...(page.versions || [])].map(version => versionSource(url, version)));
        }
        this.db.exec('delete from saved_pages where url=?', { bind: [url] });
        this.removeJob(url);
      }
      return result;
    });
  }

  forget(selection: SavedVersionSelection[], filters: SearchFilters) {
    return this.db.transaction(() => {
      const result = { pages: 0, versions: 0, removedVersions: [] as SavedVersionSource[], captureJobs: [] as Array<{ url: string; captureId: string | null }> };
      for (const item of selection) {
        const page = this.page(item.url);
        if (!page) continue;
        const change = forgetVersions(page, item, filters, Date.now());
        if (!change) continue;
        if (change.page) putSqlitePage(this.db, change.page);
        else this.db.exec('delete from saved_pages where url=?', { bind: [item.url] });
        const job = this.job(item.url);
        if (change.removesJob(job)) {
          this.removeJob(item.url);
          result.captureJobs.push({ url: item.url, captureId: job?.payload?.captureId ?? null });
        }
        result.pages++;
        result.versions += change.removed.length;
        result.removedVersions.push(...change.removed);
      }
      return result;
    });
  }

  setJob(entry: ProcessingEntry, create: boolean): boolean {
    return this.db.transaction(() => {
      const next = nextProcessingEntry(entry, this.job(entry.url), create);
      if (!next) return false;
      putSqliteJob(this.db, next);
      return true;
    });
  }

  removeJob(url: string): void {
    this.db.exec('delete from saved_processing where url=?', { bind: [url] });
  }

  private *savedPages(): Iterable<PageRecord> {
    const cursor = this.db.prepare('select url,record from saved_pages order by url');
    try {
      while (cursor.step()) {
        const url = cursor.get(0);
        if (typeof url !== 'string') throw new Error('Invalid saved page identity.');
        const page = parseSqliteRecord<PageRecord>(cursor.get(1), url);
        if (page) yield page;
      }
    } finally { cursor.finalize(); }
  }

  private *selectedPages(urls: string[], search = false): Iterable<PageRecord | undefined> {
    for (const url of urls) yield this.page(url, search);
  }

  private *searchCandidates(ranks: TextRank[]): Iterable<PageRecord> {
    const cursor = this.db.prepare('select page.url,projection.record from ' + SEARCH_PAGES + ' where page.url_order in (' + ranks.map(() => '?').join(',') + ')');
    try {
      cursor.bind(ranks.map(rank => urlOrderKey(rank.url)));
      while (cursor.step()) {
        const url = cursor.get(0);
        if (typeof url !== 'string') throw new Error('Invalid saved search row.');
        const record = this.searchPage(cursor.get(1), url);
        if (record) yield record;
      }
    } finally { cursor.finalize(); }
  }

  private async searchText(request: Extract<LibraryOperation, { op: 'searchText' }>, check: () => void): Promise<TextSearchReply> {
    const filters = readSearchFilters(request.filters);
    const search = createLexicalSearch(request.query, request.limit, filters, request.scopeUrls);
    check();
    let nextYield = performance.now() + 24;
    const pauseWhenDue = (): Promise<void> | undefined => {
      if (performance.now() >= nextYield) {
        return new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => { check(); nextYield = performance.now() + 24; });
      }
    };
    if (request.scopeUrls) {
      const pages = this.selectedPages([...new Set(request.scopeUrls)].sort(), true);
      for (const page of pages) {
        if (page) search.visit(page);
        const pause = pauseWhenDue(); if (pause) await pause;
      }
      check();
      return search.finish();
    }
    const upperBound = request.query.trim() ? createTextBound(request.query) : () => ({ score: 0, containsExact: false });
    const eligibleUrls = Object.keys(filters).length ? [] as string[] : undefined;
    const candidates: TextRank[] = [];
    let hasPages = false;
    const cursor = this.db.prepare('select page.url,hints from saved_pages as page indexed by saved_pages_by_url_order left join saved_text_index using(url_order) order by page.url_order');
    try {
      while (cursor.step()) {
        const url = cursor.get(0);
        if (typeof url !== 'string') throw new Error('Invalid saved page identity.');
        const versions = decodeTextIndex(cursor.get(1));
        if (versions) {
          let best: TextRank | undefined;
          let eligible = false;
          for (const version of versions) {
            if (!matchesSearchFilters({ url, timestamp: version.timestamp }, filters)) continue;
            eligible = true;
            const possible = upperBound(version.title, url, version.signature, version.words);
            if (!possible) continue;
            const rank = { ...possible, url, timestamp: version.timestamp };
            if (!best || compareTextRanks(rank, best) < 0) best = rank;
          }
          if (eligible) { hasPages = true; eligibleUrls?.push(url); }
          if (best) candidates.push(best);
        } else {
          const page = this.page(url, true);
          if (!page) throw new Error('Missing saved search row.');
          if ([page, ...(page.versions || [])].some(version => matchesSearchFilters({ url, timestamp: version.timestamp }, filters))) {
            hasPages = true; eligibleUrls?.push(url);
          }
          search.visit(page);
        }
        const pause = pauseWhenDue(); if (pause) await pause;
      }
    } finally { cursor.finalize(); }
    candidates.sort(compareTextRanks);
    for (let offset = 0; offset < candidates.length; offset += MAX_BATCH_ROWS) {
      if (!search.couldImprove(candidates[offset]!)) break;
      const batch = candidates.slice(offset, offset + MAX_BATCH_ROWS).filter(search.couldImprove);
      for (const page of this.searchCandidates(batch)) {
        search.visit(page);
        const pause = pauseWhenDue(); if (pause) await pause;
      }
    }
    check();
    return { ...search.finish(), hasPages, scopeUrls: eligibleUrls };
  }

  run(request: LibraryOperation, check = (): void => {}): unknown {
    switch (request?.op) {
      case 'read': return this.page(request.url) ?? null;
      case 'searchPage': return { record: this.page(request.url, true) ?? null, revision: this.revision('pages') };
      case 'pages': case 'search': case 'jobs': return this.batch(request.op, request.after, request.limit);
      case 'jobSummaries': return this.jobSummaries();
      case 'failedJobTargets': return this.failedJobTargets();
      case 'searchText':
        if (typeof request.query !== 'string' || !Number.isFinite(request.limit) || request.limit <= 0 ||
            (request.scopeUrls !== undefined && (!Array.isArray(request.scopeUrls) || !request.scopeUrls.every(validUrl)))) break;
        return this.searchText(request, check);
      case 'recents': return this.recent(request.limit, request.after);
      case 'recentRecords': return this.recentRecords(request.limit, request.after);
      case 'versions': return this.versions(request.url);
      case 'save':
        if (!validPageWrite(request.record, request.options)) break;
        this.save(request.record, request.options); return null;
      case 'editVersion':
        if (!validUrl(request.url) || !validUrl(request.versionId) || !['keep', 'release', 'delete'].includes(request.action)) break;
        return this.editVersion(request.url, request.versionId, request.action);
      case 'summary':
        if (!validUrl(request.url) || typeof request.text !== 'string' || typeof request.summary !== 'string' ||
            !optionalText(request.expected) || !optionalText(request.title) || (request.versionId !== null && !optionalText(request.versionId))) break;
        return this.summary(request.url, request.text, request.summary, request.expected, request.title, request.versionId);
      case 'delete':
        if (!Array.isArray(request.urls) || !request.urls.every(validUrl)) break;
        return this.delete(request.urls, request.filters === undefined ? undefined : readSearchFilters(request.filters));
      case 'forget': return this.forget(readVersionSelection(request.selection), readSearchFilters(request.filters));
      case 'job': return this.job(request.url) ?? null;
      case 'appendJob':
        if (!validJob(request.entry)) break;
        putSqliteJob(this.db, request.entry); return null;
      case 'setJob':
        if (typeof request.create !== 'boolean' || !validJob(request.entry)) break;
        return this.setJob(request.entry, request.create);
      case 'removeJob':
        if (!validUrl(request.url)) break;
        this.removeJob(request.url); return null;
      case 'semanticTop': return { pages: this.semantic.top(() => this.savedPages(), this.revision('pages'), request.queries, request.limit, request.key) };
      case 'semanticChunks': return { candidates: this.semantic.chunks(this.selectedPages([...new Set(request.urls)]), request.queries, request.question, request.key) };
      case 'invalidateSemantic': this.semantic.invalidate(); return { ok: true };
      default: throw new Error('Unknown active library operation.');
    }
    throw new Error('Invalid active library operation arguments.');
  }
}
