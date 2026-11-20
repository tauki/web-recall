import type { CapturePayload } from '../capture/types';
import { storageManager, type ProcessingEntry } from '../storage/manager';

function toStoredPayload(payload: CapturePayload): ProcessingEntry['payload'] {
  return {
    url: payload.url,
    title: payload.title,
    timestamp: payload.timestamp,
    chunks: payload.chunks,
    text: payload.text,
    force: payload.force,
    manual: payload.manual,
    captureId: payload.captureId,
    captureInfo: payload.captureInfo
  };
}

function broadcastQueue(): void {
  try {
    chrome.runtime.sendMessage({ type: 'CAPTURE_QUEUE_UPDATED' }, () => { void chrome.runtime.lastError; });
  } catch (err) {
    console.warn('[beta-processing] broadcast failed', err);
  }
}

async function saveEntry(params: {
  url: string;
  title: string;
  status: ProcessingEntry['status'];
  attempts: number;
  payload?: CapturePayload;
  error?: string;
  retryOf?: string | null;
}, create = false): Promise<boolean> {
  const now = Date.now();
  const entry: ProcessingEntry = {
    url: params.url,
    title: params.title || params.url,
    status: params.status,
    attempts: params.attempts,
    createdAt: now,
    lastAttemptAt: now,
    updatedAt: now,
    payload: params.payload ? toStoredPayload(params.payload) : undefined,
    error: params.error,
    textSaved: create ? true : undefined
  };
  let updated: boolean;
  if (create && params.payload) {
    await storageManager.savePageRecord({
      url: params.url,
      title: params.title || params.url,
      timestamp: params.payload.timestamp,
      text: params.payload.text,
      manual: Boolean(params.payload.manual),
      captureInfo: params.payload.captureInfo,
      chunks: params.payload.chunks.map(text => ({ text, embedding: [] }))
    }, {
      preserveMissingEmbeddings: true, captureEntry: entry,
      ...(params.retryOf !== undefined && { requireProcessing: true, expectedCaptureId: params.retryOf })
    });
    updated = true;
  } else updated = await storageManager.updateProcessingEntry(entry, create);
  broadcastQueue();
  return updated;
}

export async function markQueued(payload: CapturePayload, attempts: number, create = true, retryOf?: string | null): Promise<boolean> {
  return saveEntry({ url: payload.url, title: payload.title, status: 'queued', attempts, payload, retryOf }, create);
}

export async function markProcessing(payload: CapturePayload, attempts: number): Promise<boolean> {
  return saveEntry({ url: payload.url, title: payload.title, status: 'processing', attempts, payload });
}

export async function markFailed(payload: CapturePayload, attempts: number, error?: string): Promise<void> {
  await saveEntry({ url: payload.url, title: payload.title, status: 'failed', attempts, payload, error });
}

export async function markDone(url: string): Promise<void> {
  await storageManager.deleteProcessing(url);
  broadcastQueue();
}

export function listProcessingEntries(): Promise<ProcessingEntry[]> {
  return storageManager.listProcessing().then((entries) =>
    entries.sort((a: ProcessingEntry, b: ProcessingEntry) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  );
}

export function getProcessingEntryByUrl(url: string): Promise<ProcessingEntry | undefined> {
  return storageManager.getProcessingEntry(url);
}
