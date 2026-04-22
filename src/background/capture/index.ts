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

export function createCaptureQueue(processFn = processCapturePayload) {
  const queue: QueueItem[] = [];
  const enqueuedUrls = new Set<string>();
  let currentUrl: string | null = null;
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
        await markProcessing(item.payload, item.attempts);
        if (item.delayMs > 0) {
          await sleep(item.delayMs);
        }
        try {
          await processFn(item.payload);
          processedCount += 1;
          const includeBodies = getCachedSettingsSnapshot().logFullBodies;
          await log('info', 'capture processed', {
            url: item.url,
            attempts: item.attempts,
            chunkCount: item.payload.chunks.length,
            ...(includeBodies ? { payload: item.payload.text } : {})
          });
          await markDone(item.url);
        } catch (err) {
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
          logQueueState('after-iteration', { lastProcessed: item.url });
        }
      }
    } finally {
      processing = false;
    }
  }

  function enqueue(payload: CapturePayload, delayMs = 0): void {
    if (!payload.url) return;
    const existing = queue.find((it) => it.url === payload.url);
    if (existing) {
      existing.payload = payload;
      existing.delayMs = Math.max(existing.delayMs, delayMs);
      existing.attempts = 0;
      return;
    }
    queue.push({ url: payload.url, payload, delayMs, attempts: 0 });
    enqueuedUrls.add(payload.url);
    void markQueued(payload, 0);
    void runQueue();
    logQueueState('enqueue');
  }

  async function requeueProcessing(urls: string[]): Promise<{ retried: number }> {
    let retried = 0;
    for (const url of urls) {
      try {
        const entry = await getProcessingEntryByUrl(url);
        if (entry?.payload) {
          enqueue({
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
        enqueue(payload);
        if (typeof sendResponse === 'function') {
          sendResponse({ status: 'queued' });
        }
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
    bindRuntimeListener,
    isProcessing: () => processing,
    peekQueue: (): readonly QueueItem[] => queue
  };
}
