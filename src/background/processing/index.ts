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
    manual: payload.manual
  };
}

async function broadcastQueue(): Promise<void> {
  try {
    const queue = await listProcessingEntries();
    chrome.runtime.sendMessage({ type: 'CAPTURE_QUEUE_UPDATED', queue });
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
}): Promise<void> {
  const existing = await storageManager.getProcessingEntry(params.url);
  const now = Date.now();
  const entry: ProcessingEntry = {
    url: params.url,
    title: params.title || existing?.title || params.url,
    status: params.status,
    attempts: params.attempts,
    createdAt: existing?.createdAt ?? now,
    lastAttemptAt: now,
    updatedAt: now,
    payload: params.payload ? toStoredPayload(params.payload) : existing?.payload
  };
  await storageManager.appendProcessing(entry);
  await broadcastQueue();
}

export async function markQueued(payload: CapturePayload, attempts: number): Promise<void> {
  await saveEntry({ url: payload.url, title: payload.title, status: 'queued', attempts, payload });
}

export async function markProcessing(payload: CapturePayload, attempts: number): Promise<void> {
  await saveEntry({ url: payload.url, title: payload.title, status: 'processing', attempts, payload });
}

export async function markFailed(payload: CapturePayload, attempts: number): Promise<void> {
  await saveEntry({ url: payload.url, title: payload.title, status: 'failed', attempts, payload });
}

export async function markDone(url: string): Promise<void> {
  await storageManager.deleteProcessing(url);
  await broadcastQueue();
}

export function listProcessingEntries(): Promise<ProcessingEntry[]> {
  return storageManager.listProcessing().then((entries) =>
    entries.sort((a: ProcessingEntry, b: ProcessingEntry) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  );
}

export function getProcessingEntryByUrl(url: string): Promise<ProcessingEntry | undefined> {
  return storageManager.getProcessingEntry(url);
}
