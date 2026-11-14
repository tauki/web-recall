import { normalizeBackupPage } from './db/records';
import type { PageRecord } from './db/index';

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export const BACKUP_HEADER = '{"format":"web-recall","schemaVersion":2}\n';

function checkRecordSize(bytes: number): void {
  if (bytes > MAX_RECORD_BYTES) throw new Error('Backup record exceeds the maximum size of 16 MB.');
}

export function encodeBackupPage(page: PageRecord): string {
  normalizeBackupPage(page);
  const encoded = JSON.stringify({ type: 'page', page });
  checkRecordSize(new TextEncoder().encode(encoded).length);
  return encoded;
}

export function decodeBackupPage(line: string): PageRecord {
  checkRecordSize(new TextEncoder().encode(line).length);
  const record = JSON.parse(line);
  if (record?.type !== 'page' || !record.page || typeof record.page !== 'object' || Array.isArray(record.page)) {
    throw new Error('Invalid backup page record.');
  }
  return normalizeBackupPage(record.page);
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let start = 0;
      while (start < value.length) {
        const newline = value.indexOf(10, start);
        const end = newline < 0 ? value.length : newline;
        bytes += end - start;
        checkRecordSize(bytes);
        pending += decoder.decode(value.subarray(start, end), { stream: newline < 0 });
        if (newline >= 0) {
          yield pending;
          pending = '';
          bytes = 0;
        }
        start = newline < 0 ? value.length : newline + 1;
      }
    }
    pending += decoder.decode();
    if (pending) yield pending;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* readBackupPages(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let headerSeen = false;
  let ended = false;
  let pages = 0;
  for await (const line of readLines(stream)) {
    if (ended) throw new Error('Unexpected data after the backup end record.');
    const record = JSON.parse(line);
    if (!headerSeen) {
      if (record?.format !== 'web-recall' || record.schemaVersion !== 2) throw new Error('Unsupported backup format.');
      headerSeen = true;
    } else if (record?.type === 'end') {
      if (record.pages !== pages) throw new Error('Backup page count does not match its end record.');
      ended = true;
    } else {
      decodeBackupPage(line);
      pages++;
      yield line;
    }
  }
  if (!headerSeen || !ended) throw new Error('Backup is incomplete: the end record is missing.');
}
