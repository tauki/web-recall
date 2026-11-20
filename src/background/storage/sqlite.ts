import type { StorageBackend } from './manager';
import type { PageRecord, ProcessingEntry } from '../../shared/db/index';
import type { LibraryOperation } from '../../shared/db/sqliteRecords';
import type { RecentCursor, RecentPageBatch } from '../../shared/recents';
import { ensureOffscreenDocument, sendOffscreenMessage } from '../offscreen/index';
import { readLibraryAuthority } from './libraryAuthorityState';

export async function callSavedLibraryWorker<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  await ensureOffscreenDocument();
  if (request.kind === 'stage' || request.kind === 'activate') {
    const state = await readLibraryAuthority();
    if (!state || state.id !== request.id ||
        (request.kind === 'stage' ? state.phase !== 'preparing' || state.source !== request.source : state.phase !== 'active')) {
      throw new Error('The saved library operation is not authorized by the startup identity.');
    }
    if (request.kind === 'stage') request = { ...request, preparing: true };
    else request = { ...request, replacement: state.source === 'backup' };
  } else if (request.kind === 'recover') {
    const state = await readLibraryAuthority();
    if (state?.phase !== 'active' || !state.retired || state.id !== request.id ||
        (request.action !== 'check' && (!state.recoveryId || state.recoveryId !== request.recoveryId))) {
      throw new Error('The saved library recovery is not authorized.');
    }
    request = { ...request, replacement: state.source === 'backup' };
  }
  signal?.throwIfAborted();
  if (!signal || request.kind !== 'operate') return sendOffscreenMessage<T>({ type: 'OFFSCREEN_SAVED_LIBRARY', request }, signal);
  const operationId = crypto.randomUUID();
  const cancel = (): void => {
    void sendOffscreenMessage({ type: 'OFFSCREEN_SAVED_LIBRARY', request: { kind: 'cancel', id: request.id, operationId } }).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try { return await sendOffscreenMessage<T>({ type: 'OFFSCREEN_SAVED_LIBRARY', request: { ...request, operationId } }, signal); }
  catch (error) { throw signal.aborted ? signal.reason : error; }
  finally { signal.removeEventListener('abort', cancel); }
}

type Batch<RecordType> = { records: RecordType[]; after: string | null; revision: number };

function verifyRevision(previous: number | undefined, next: number): number {
  if (!Number.isSafeInteger(next) || (previous !== undefined && previous !== next)) throw new Error('The saved library changed during the scan. Try again.');
  return next;
}

export function createSqliteBackend(id: string, logs: Pick<StorageBackend, 'listLogs' | 'clearLogs'>, replacement = false): StorageBackend {
  const call = async <Result>(action: LibraryOperation, signal?: AbortSignal): Promise<Result> => {
    const response = await callSavedLibraryWorker<{ value?: Result }>({ kind: 'operate', id, action, replacement }, signal);
    if (!Object.hasOwn(response, 'value')) throw new Error('Saved library operation did not return a result.');
    return response.value as Result;
  };

  async function* scan<RecordType extends PageRecord | ProcessingEntry>(op: 'pages' | 'jobs' | 'search', signal?: AbortSignal): AsyncIterable<RecordType> {
    let after: string | undefined;
    let revision: number | undefined;
    do {
      const batch: Batch<RecordType> = await call({ op, after }, signal);
      revision = verifyRevision(revision, batch.revision);
      if (batch.after !== null && (!batch.after || batch.after === after || batch.records.at(-1)?.url !== batch.after)) {
        throw new Error('Saved library scan did not advance.');
      }
      after = batch.after ?? undefined;
      for (const record of batch.records) { signal?.throwIfAborted(); yield record; }
    } while (after !== undefined);
    signal?.throwIfAborted();
  }

  const getPageRecord = async (url: string): Promise<PageRecord | undefined> => (await call<PageRecord | null>({ op: 'read', url })) ?? undefined;
  const listRecentPageSummaries = (limit: number, after?: RecentCursor): Promise<RecentPageBatch> => call({ op: 'recents', limit, after });
  return {
    listLogs: logs.listLogs,
    clearLogs: logs.clearLogs,
    getPageRecord,
    listRecentPageSummaries,
    async listRecentPages(limit = 50) {
      const matches: PageRecord[] = [];
      let after: RecentCursor | undefined;
      let revision: number | undefined;
      while (matches.length < limit) {
        const response = await call<{ records: PageRecord[]; after: RecentCursor | null; revision: number }>({ op: 'recentRecords', limit: limit - matches.length, after });
        revision = verifyRevision(revision, response.revision);
        matches.push(...response.records);
        if (!response.after) break;
        if (response.after.url === after?.url || response.records.at(-1)?.url !== response.after.url) throw new Error('Recent saved pages did not advance.');
        after = response.after;
      }
      return matches;
    },
    async listAllPages() {
      const pages: PageRecord[] = [];
      for await (const page of scan<PageRecord>('pages')) pages.push(page);
      return pages;
    },
    async getNextPageRecord(after) { return (await call<Batch<PageRecord>>({ op: 'pages', after, limit: 1 })).records[0]; },
    async getBackupBatch(after, signal) {
      const { records, revision } = await call<Batch<PageRecord>>({ op: 'pages', after, limit: 1 }, signal);
      return { libraryId: id, revision, page: records[0] };
    },
    searchTextPages(query, limit, filters, { signal, scopeUrls } = {}) {
      return call({ op: 'searchText', query, limit, filters, scopeUrls }, signal);
    },
    async scanSearchPages(visit, options = {}) {
      const { signal, scopeUrls } = options;
      signal?.throwIfAborted();
      if (scopeUrls) {
        let revision: number | undefined;
        for (const url of [...new Set(scopeUrls)].sort()) {
          const { record, revision: found } = await call<{ record: PageRecord | null; revision: number }>({ op: 'searchPage', url }, signal);
          revision = verifyRevision(revision, found);
          signal?.throwIfAborted();
          if (record) visit(record);
        }
      } else for await (const page of scan<PageRecord>('search', signal)) visit(page);
      signal?.throwIfAborted();
    },
    async savePageRecord(record, input = {}) {
      const { signal, ...options } = input;
      await call({ op: 'save', record, options }, signal);
    },
    listPageVersions(url, signal) { return call({ op: 'versions', url }, signal); },
    updateSavedVersion(url, versionId, action) { return call({ op: 'editVersion', url, versionId, action }); },
    savePageSummary(url, text, summary, signal, expected, title, versionId) { return call({ op: 'summary', url, text, summary, expected, title, versionId }, signal); },
    deletePages(urls, filters) { return call({ op: 'delete', urls, filters }); },
    forgetPageVersions(selection, filters) { return call({ op: 'forget', selection, filters }); },
    async appendProcessing(entry) { await call({ op: 'appendJob', entry }); },
    updateProcessingEntry(entry, create = false) { return call({ op: 'setJob', entry, create }); },
    async deleteProcessing(url) { await call({ op: 'removeJob', url }); },
    listProcessingSummaries() { return call({ op: 'jobSummaries' }); },
    listFailedProcessingTargets() { return call({ op: 'failedJobTargets' }); },
    async listProcessing() {
      const entries: ProcessingEntry[] = [];
      for await (const job of scan<ProcessingEntry>('jobs')) entries.push(job);
      return entries;
    },
    async getProcessingEntry(url) { return (await call<ProcessingEntry | null>({ op: 'job', url })) ?? undefined; }
  };
}
