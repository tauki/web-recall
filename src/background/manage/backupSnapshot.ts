import { encodePageFrames, FRAMED_BACKUP_HEADER } from '../../shared/backupFrames';
import { pageContent } from '../../shared/pageContent';
import { storageManager, type PageRecord } from '../storage/manager';

type Identity = { libraryId: string; revision: number };
type Format = 'backup' | 'markdown' | 'json';
export type ExportChunk = { line: string; complete: boolean; pages: number };

export function exportOptions(format: unknown, urls: unknown): { format: Format; scope?: Set<string> } {
  if (format === undefined && urls === undefined) return { format: 'backup' };
  if ((format !== 'json' && format !== 'markdown') ||
      (urls !== undefined && (!Array.isArray(urls) || !urls.every(url => typeof url === 'string')))) {
    throw new Error('Invalid page export options.');
  }
  return { format, ...(Array.isArray(urls) ? { scope: new Set<string>(urls) } : {}) };
}

export async function openBackupSnapshot(signal: AbortSignal) {
  const first = await storageManager.getBackupBatch(undefined, signal);
  const identity: Identity = { libraryId: first.libraryId, revision: first.revision };
  return {
    ...identity,
    hasPages: Boolean(first.page),
    async *pages(): AsyncGenerator<PageRecord> {
      let batch = first;
      let after: string | undefined;
      while (batch.page) {
        signal.throwIfAborted();
        if (after !== undefined && batch.page.url <= after) throw new Error('Backup cursor did not advance.');
        after = batch.page.url;
        yield batch.page;
        batch = await storageManager.getBackupBatch(after, signal);
        if (batch.libraryId !== identity.libraryId || batch.revision !== identity.revision) {
          throw new Error('The saved library changed while exporting. Try again.');
        }
      }
      signal.throwIfAborted();
    }
  };
}

export async function* exportSnapshot(snapshot: Awaited<ReturnType<typeof openBackupSnapshot>>, signal: AbortSignal, format: Format = 'backup', scope?: Set<string>): AsyncGenerator<ExportChunk> {
  let pages = 0;
  const chunk = (line: string, complete = false): ExportChunk => ({ line, complete, pages });
  if (format === 'backup') yield chunk(FRAMED_BACKUP_HEADER);
  if (format === 'json') yield chunk('{"format":"web-recall-export","schemaVersion":1,"pages":[\n');
  if (format === 'markdown') yield chunk('# Web Recall export\n');
  for await (const page of snapshot.pages()) {
    if (scope && !scope.has(page.url)) continue;
    if (format === 'backup') {
      for (const line of encodePageFrames(page)) {
        signal.throwIfAborted();
        yield chunk(line);
      }
      pages++;
    } else {
      const record = { title: page.title || page.url, url: page.url, capturedAt: new Date(page.timestamp).toJSON(), text: pageContent(page), ...(page.summary ? { summary: page.summary } : {}) };
      const line = format === 'json'
        ? `${pages ? ',\n' : ''}${JSON.stringify(record)}`
        : `\n## ${record.title.replace(/[\r\n]+/gu, ' ')}\n\nSource: ${record.url}\nCaptured: ${record.capturedAt ?? 'Unknown'}\n\n${record.summary ? `Summary: ${record.summary}\n\n` : ''}${record.text}\n`;
      pages++;
      yield chunk(line);
    }
  }
  if (format === 'backup') yield chunk(JSON.stringify({ type: 'end', pages }), true);
  else yield chunk(format === 'json' ? '\n]}\n' : '', true);
}
