import { processCapturePayload } from './processor';
import type { CapturePayload, QueueItem } from './types';
import { shouldCaptureUrl, getCachedSettingsSnapshot } from '../settings/index';
import { markQueued, markProcessing, markFailed, markDone, getProcessingEntryByUrl, listProcessingEntries } from '../processing/index';
import { log } from '../../shared/logger/index';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1500;
const MAX_BACKOFF_MS = 60_000;

function normalizePayload(message: Record<string, unknown>): CapturePayload {
  return {
    url: String(message.url || ''),
    title: String(message.title || message.url || ''),
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
    text: typeof message.text === 'string' ? message.text : '',
    chunks: Array.isArray(message.chunks) ? message.chunks.map((c) => String(c)) : [],
    force: Boolean(message.force),
    manual: Boolean(message.manual)
  };
}

const cancelHandlers = new Set<(urls: string[]) => void>();
export function cancelCaptureJobs(urls: string[]): void {
  cancelHandlers.forEach((cancel) => cancel(urls));
}

export function createCaptureQueue(processFn = processCapturePayload) {
  const queue: QueueItem[] = [];
  const enqueuedUrls = new Set<string>();
  let currentUrl: string | null = null;
  let currentItem: QueueItem | undefined;
  const cancelled = new WeakSet<QueueItem>();
  cancelHandlers.add((urls) => {
    const targets = new Set(urls);
    if (currentItem && targets.has(currentItem.url)) cancelled.add(currentItem);
    for (let index = queue.length - 1; index >= 0; index--) {
      if (targets.has(queue[index]!.url)) {
        enqueuedUrls.delete(queue[index]!.url);
        queue.splice(index, 1);
      }
    }
  });
  let processing = false;
  let processedCount = 0;
  let failedCount = 0;
  let retryCount = 0;

  function nextBackoff(attempt: number): number {
    const computed = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(computed, MAX_BACKOFF_MS);
  }

  function logQueueState(context: string, extra: Record<string, unknown> = {}): void {
    console.info('[beta-background:capture] queue event', context, {
      queued: queue.length,
      uniqueQueued: enqueuedUrls.size,
      currentUrl,
      processing,
      processedCount,
      retryCount,
      failedCount,
      ...extra
    });
  }

  async function runQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        enqueuedUrls.delete(item.url);
        currentUrl = item.url;
        currentItem = item;
        try {
          if (item.delayMs > 0) await sleep(item.delayMs);
          if (cancelled.has(item)) continue;
          await markProcessing(item.payload, item.attempts);
          if (cancelled.has(item)) continue;
          await processFn(item.payload, () => !cancelled.has(item));
          if (cancelled.has(item)) continue;
          processedCount += 1;
          const includeBodies = getCachedSettingsSnapshot().logFullBodies;
          await log('info', 'capture processed', {
            url: item.url,
            attempts: item.attempts,
            chunkCount: item.payload.chunks.length,
            ...(includeBodies ? { payload: item.payload.text } : {})
          });
          const replacement = queue.find((entry) => entry.url === item.url);
          if (replacement) await markQueued(replacement.payload, replacement.attempts);
          else await markDone(item.url);
        } catch (err) {
          if (cancelled.has(item)) continue;
          const includeBodies = getCachedSettingsSnapshot().logFullBodies;
          await log('error', 'capture failed', {
            url: item.url,
            error: err instanceof Error ? err.message : String(err),
            ...(includeBodies ? { payload: item.payload.text } : {})
          });
          const nextAttempt = item.attempts + 1;
          if (nextAttempt <= MAX_ATTEMPTS) {
            const retryDelay = nextBackoff(nextAttempt);
            queue.push({
              url: item.url,
              payload: item.payload,
              delayMs: retryDelay,
              attempts: nextAttempt
            });
            enqueuedUrls.add(item.url);
            retryCount += 1;
            await markQueued(item.payload, nextAttempt);
          } else {
            failedCount += 1;
            await markFailed(item.payload, nextAttempt);
          }
        } finally {
          currentUrl = null;
          currentItem = undefined;
          logQueueState('after-iteration', { lastProcessed: item.url });
        }
      }
    } finally {
      processing = false;
    }
  }

  const ready = (async () => {
    const entries = await listProcessingEntries();
    for (const entry of entries) {
      if (!entry.payload || (entry.status !== 'queued' && entry.status !== 'processing')) continue;
      queue.push({ url: entry.url, payload: entry.payload, attempts: entry.attempts, delayMs: 0 });
      enqueuedUrls.add(entry.url);
    }
  })();
  void ready.then(runQueue).catch((err) => console.error('[capture] recovery failed', err));
  let enqueueTail: Promise<void> = Promise.resolve();

  function enqueue(payload: CapturePayload, delayMs = 0): Promise<void> {
    const operation = enqueueTail.then(async () => {
      await ready;
      if (!payload.url) throw new Error('Capture URL is required');
      // ACK only after the durable job exists. A restart can recover it from here.
      await markQueued(payload, 0);
      const existing = queue.find((item) => item.url === payload.url);
      if (existing) {
        existing.payload = payload;
        existing.delayMs = Math.max(existing.delayMs, delayMs);
        existing.attempts = 0;
      } else {
        queue.push({ url: payload.url, payload, delayMs, attempts: 0 });
        enqueuedUrls.add(payload.url);
      }
      void runQueue().catch((err) => console.error('[capture] worker failed', err));
      logQueueState('enqueue');
    });
    enqueueTail = operation.catch(() => {});
    return operation;
  }

  async function requeueProcessing(urls: string[]): Promise<{ retried: number }> {
    let retried = 0;
    for (const url of urls) {
      try {
        const entry = await getProcessingEntryByUrl(url);
        if (entry?.payload) {
          await enqueue({
            url: entry.payload.url,
            title: entry.payload.title,
            timestamp: entry.payload.timestamp,
            chunks: entry.payload.chunks,
            text: entry.payload.text,
            force: entry.payload.force,
            manual: entry.payload.manual
          });
          retried += 1;
        }
      } catch (err) {
        console.warn('[beta-background:capture] requeue failed', err);
      }
    }
    return { retried };
  }

  function bindRuntimeListener(): void {
    chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender: unknown, sendResponse?: (response?: unknown) => void) => {
      if (!message || typeof message !== 'object') return false;
      if (message.type === 'SAVE_PAGE') {
        const payload = normalizePayload(message);
        void enqueue(payload).then(() => sendResponse?.({ status: 'queued' }))
          .catch((err) => sendResponse?.({ error: err instanceof Error ? err.message : String(err) }));
        return true;
      }
      if (message.type === 'SHOULD_CAPTURE') {
        if (typeof sendResponse === 'function') {
          const url = typeof message.url === 'string' ? message.url : '';
          shouldCaptureUrl(url)
            .then((allow) => sendResponse({ allow }))
            .catch((err) => {
              console.error('[beta-background:capture] shouldCapture failed', err);
              sendResponse({ allow: false, error: err instanceof Error ? err.message : String(err) });
            });
          return true;
        }
        return false;
      }
      if (message.type === 'RETRY_PROCESSING') {
        if (typeof sendResponse === 'function') {
          const targetUrl = typeof message.url === 'string' ? message.url : '';
          requeueProcessing(targetUrl ? [targetUrl] : [])
            .then((result) => sendResponse({ retried: result.retried }))
            .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
          return true;
        }
        return false;
      }
      if (message.type === 'RETRY_FAILED_CAPTURES') {
        if (typeof sendResponse === 'function') {
          listProcessingEntries()
            .then((entries) => entries.filter((entry) => entry.status === 'failed').map((entry) => entry.url))
            .then((urls) => requeueProcessing(urls))
            .then((result) => sendResponse({ retried: result.retried }))
            .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
          return true;
        }
        return false;
      }
      return false;
    });
  }

  return {
    enqueue,
    ready,
    bindRuntimeListener,
    isProcessing: () => processing,
    peekQueue: (): readonly QueueItem[] => queue
  };
}
