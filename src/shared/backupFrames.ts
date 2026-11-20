import { checkRecordSize, decodeBackupPage, readBackupLines } from './backup';
import { normalizeBackupPage } from './db/records';
import type { PageRecord, PageVersion } from './db/index';

export const FRAMED_BACKUP_HEADER = '{"format":"web-recall","schemaVersion":3}';
export const MAX_BACKUP_PAGE_BYTES = 128 * 1024 * 1024;
type BackupEvent =
  | { type: 'header'; schema: 2 | 3 }
  | { type: 'legacy-page'; page: PageRecord }
  | { type: 'page'; page: PageRecord; versionCount: number }
  | { type: 'version'; version: PageVersion }
  | { type: 'page-end' }
  | { type: 'end'; pages: number };

function encodedFrame(value: unknown): string {
  const line = JSON.stringify(value);
  checkRecordSize(new TextEncoder().encode(line).length);
  return line;
}

export function* encodePageFrames(page: PageRecord): Generator<string> {
  const { versions = [], ...current } = page;
  const decoder = new BackupFrameDecoder();
  decoder.consume(FRAMED_BACKUP_HEADER);
  const lines = function* (): Generator<string> {
    yield encodedFrame({ type: 'page', page: current, versionCount: versions.length });
    for (const [index, version] of versions.entries()) yield encodedFrame({ type: 'version', url: page.url, index, version });
    yield encodedFrame({ type: 'page-end', url: page.url, versionCount: versions.length });
  };
  for (const line of lines()) { decoder.consume(line); yield line; }
}

export class BackupFrameDecoder {
  private schema?: 2 | 3;
  private current?: { url: string; count: number; received: number; bytes: number; identities: Set<string> };
  private previousUrl?: string;
  private pages = 0;
  private ended = false;

  consume(line: string): BackupEvent {
    const bytes = new TextEncoder().encode(line).length;
    checkRecordSize(bytes);
    if (this.ended) throw new Error('Unexpected data after the backup end record.');
    const record = JSON.parse(line);
    if (!this.schema) {
      if (record?.format !== 'web-recall' || ![2, 3].includes(record.schemaVersion)) throw new Error('Unsupported backup format.');
      this.schema = record.schemaVersion as 2 | 3;
      return { type: 'header', schema: this.schema };
    }
    if (record?.type === 'end') {
      if (this.current || !Number.isSafeInteger(record.pages) || record.pages !== this.pages) throw new Error('Backup page count does not match its end record.');
      this.ended = true;
      return { type: 'end', pages: this.pages };
    }
    if (this.schema === 2) { const page = decodeBackupPage(line); this.pages++; return { type: 'legacy-page', page }; }
    if (record?.type === 'page') {
      if (this.current || !record.page || typeof record.page !== 'object' || Array.isArray(record.page) || Object.hasOwn(record.page, 'versions') || !Number.isSafeInteger(record.versionCount) || record.versionCount < 0) throw new Error('Invalid backup page frame.');
      const page = normalizeBackupPage(record.page);
      if (this.previousUrl !== undefined && page.url <= this.previousUrl) throw new Error('Backup page URLs must advance without duplicates.');
      this.current = { url: page.url, count: record.versionCount, received: 0, bytes, identities: new Set(page.versionId ? [page.versionId] : []) };
      return { type: 'page', page, versionCount: record.versionCount };
    }
    const current = this.current;
    if (!current || record?.url !== current.url) throw new Error('Backup frame does not match an open page.');
    current.bytes += bytes;
    if (current.bytes > MAX_BACKUP_PAGE_BYTES) throw new Error('Saved page history exceeds the backup limit of 128 MB. No versions were dropped.');
    if (record.type === 'version') {
      if (record.index !== current.received || current.received >= current.count || !record.version || typeof record.version !== 'object' || Array.isArray(record.version)) throw new Error('Invalid or reordered backup version frame.');
      const version = normalizeBackupPage({ url: current.url, versions: [record.version] }).versions![0]!;
      if (version.versionId && current.identities.has(version.versionId)) throw new Error('Saved version identities must be unique within a page.');
      if (version.versionId) current.identities.add(version.versionId);
      current.received++;
      return { type: 'version', version };
    }
    if (record.type !== 'page-end' || record.versionCount !== current.count || current.received !== current.count) throw new Error('Incomplete or invalid backup page end record.');
    this.previousUrl = current.url;
    this.current = undefined;
    this.pages++;
    return { type: 'page-end' };
  }

  finish(): void {
    if (!this.ended) throw new Error('Backup is incomplete: the end record is missing.');
  }
}

export async function validateBackup(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<number> {
  const decoder = new BackupFrameDecoder();
  let pages = 0;
  for await (const line of readBackupLines(stream, signal)) {
    const event = decoder.consume(line);
    if (event.type === 'end') pages = event.pages;
  }
  decoder.finish();
  return pages;
}
