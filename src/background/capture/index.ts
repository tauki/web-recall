import { processCapturePayload } from './processor';
import type { CapturePayload, QueueItem } from './types';
import { shouldCaptureUrl, getCachedSettingsSnapshot } from '../settings/index';
import { markQueued, markProcessing, markFailed, markDone, getProcessingEntryByUrl, listProcessingEntries } from '../processing/index';
import { log } from '../../shared/logger/index';
import { matchesSearchFilters, type SearchFilters } from '../../shared/searchFilters';
import { readCaptureInfo } from '../../shared/capture';
import { storageManager } from '../storage/manager';

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
    force: message.force === true,
    manual: message.manual === true,
    captureInfo: readCaptureInfo(message.captureInfo)
  };
}

const cancelHandlers = new Set<(urls: string[], filters?: SearchFilters, captureIds?: ReadonlyMap<string, string | null>) => Promise<QueueItem[]>>();
export async function cancelCaptureJobs(urls: string[], filters?: SearchFilters, captureIds?: ReadonlyMap<string, string | null>): Promise<QueueItem[]> {
  return (await Promise.all(Array.from(cancelHandlers, cancel => cancel(urls, filters, captureIds)))).flat();
}

export function createCaptureQueue(processFn = processCapturePayload) {
  const queue: QueueItem[] = [];
  const enqueuedUrls = new Set<string>();
  let currentUrl: string | null = null;
  let currentItem: QueueItem | undefined;
  let currentController: AbortController | undefined;
  const cancelled = new WeakSet<QueueItem>();
  cancelHandlers.add((urls, filters, captureIds) => {
    const targets = new Set(urls);
    const stopped = new Set<QueueItem>();
    const matches = (item: QueueItem): boolean => targets.has(item.url) && (!filters || matchesSearchFilters(item.payload, filters)) && (!captureIds || captureIds.has(item.url) && captureIds.get(item.url) === (item.payload.captureId ?? null));
    const cancelMaterialized = (): void => {
      if (currentItem && matches(currentItem)) {
        cancelled.add(currentItem);
        stopped.add(currentItem);
        currentController?.abort();
      }
      for (let index = queue.length - 1; index >= 0; index--) {
        if (matches(queue[index]!)) {
          stopped.add(queue[index]!);
          enqueuedUrls.delete(queue[index]!.url);
          queue.splice(index, 1);
        }
      }
    };
    cancelMaterialized();
    return updateQueue(async () => {
      await ensureReady();
      cancelMaterialized();
    }).then(() => [...stopped]);
  });
  let processing = false;
  let processedCount = 0;
  let failedCount = 0;
  let retryCount = 0;
  let enqueueTail: Promise<void> = Promise.resolve();

  function updateQueue(operation: () => Promise<void>): Promise<void> {
    const pending = enqueueTail.then(operation);
    enqueueTail = pending.catch(() => {});
    return pending;
  }

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
        currentController = new AbortController();
        try {
          if (item.delayMs > 0) await sleep(item.delayMs);
          if (cancelled.has(item)) continue;
          if (!await shouldCaptureUrl(item.url, { ignorePaused: true })) {
            await updateQueue(async () => {
              if (!cancelled.has(item) && !queue.some(entry => entry.url === item.url)) await markDone(item.url);
            });
            continue;
          }
          if (cancelled.has(item)) continue;
          if (await markProcessing(item.payload, item.attempts) === false) continue;
          if (cancelled.has(item)) continue;
          const result = await processFn(item.payload, () => !cancelled.has(item), currentController.signal);
          if (cancelled.has(item)) continue;
          if (result?.embeddingError) {
            failedCount += 1;
            await updateQueue(async () => {
              if (!cancelled.has(item) && !queue.some(entry => entry.url === item.url)) await markFailed(item.payload, item.attempts, result.embeddingError);
            });
            continue;
          }
          processedCount += 1;
          const includeBodies = getCachedSettingsSnapshot().logFullBodies;
          await log('info', 'capture processed', {
            url: item.url,
            attempts: item.attempts,
            chunkCount: item.payload.chunks.length,
            ...(includeBodies ? { payload: item.payload.text } : {})
          });
          await updateQueue(async () => {
            if (cancelled.has(item)) return;
            const replacement = queue.find((entry) => entry.url === item.url);
            if (replacement) await markQueued(replacement.payload, replacement.attempts, false);
            else await markDone(item.url);
          });
        } catch (err) {
          if (cancelled.has(item)) continue;
          const includeBodies = getCachedSettingsSnapshot().logFullBodies;
          await log('error', 'capture failed', {
            url: item.url,
            error: err instanceof Error ? err.message : String(err),
            ...(includeBodies ? { payload: item.payload.text } : {})
          });
          await updateQueue(async () => {
            if (cancelled.has(item)) return;
            if (queue.some(entry => entry.url === item.url)) return;
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
              await markQueued(item.payload, nextAttempt, false);
            } else {
              failedCount += 1;
              await markFailed(item.payload, nextAttempt, err instanceof Error ? err.message : String(err));
            }
          });
        } finally {
          currentUrl = null;
          currentItem = undefined;
          currentController = undefined;
          logQueueState('after-iteration', { lastProcessed: item.url });
        }
      }
    } finally {
      processing = false;
    }
  }

  let readiness: Promise<void> | undefined;
  async function recoverQueue(): Promise<void> {
    const recovered: QueueItem[] = [];
    const entries = await listProcessingEntries();
    for (const entry of entries) {
      if (!entry.payload || (entry.status !== 'queued' && entry.status !== 'processing')) continue;
      if (!await shouldCaptureUrl(entry.url, { ignorePaused: true })) {
        await markDone(entry.url);
        continue;
      }
      if (await markQueued(entry.payload, entry.attempts, false) === false) continue;
      recovered.push({ url: entry.url, payload: entry.payload, attempts: entry.attempts, delayMs: 0 });
    }
    for (const item of recovered) { queue.push(item); enqueuedUrls.add(item.url); }
  }
  function ensureReady(): Promise<void> {
    return readiness ??= recoverQueue().catch(error => { readiness = undefined; throw error; });
  }
  void ensureReady().then(runQueue).catch((err) => console.error('[capture] recovery failed', err));

  function enqueue(payload: CapturePayload, delayMs = 0): Promise<void> {
    return updateQueue(() => persistAndEnqueue(payload, delayMs));
  }

  async function persistAndEnqueue(payload: CapturePayload, delayMs: number, retryOf?: string | null): Promise<void> {
    await ensureReady();
    if (!payload.url) throw new Error('Capture URL is required');
    if (!await shouldCaptureUrl(payload.url, { ignorePaused: retryOf !== undefined || payload.manual })) throw new Error('Capture blocked by your capture rules.');
    payload = { ...payload, captureId: crypto.randomUUID() };
    await markQueued(payload, 0, true, retryOf);
    if (currentItem?.url === payload.url) {
      cancelled.add(currentItem);
      currentController?.abort();
    }
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
  }

  async function requeueProcessing(targets: Array<{ url: string; captureId?: string | null }>): Promise<{ retried: number }> {
    let retried = 0;
    for (const target of targets) {
      try {
        await updateQueue(async () => {
          const entry = await getProcessingEntryByUrl(target.url);
          if (entry?.status !== 'failed' || !entry.payload) return;
          const captureId = entry.payload.captureId ?? null;
          if (target.captureId !== undefined && captureId !== target.captureId) return;
          await persistAndEnqueue(entry.payload, 0, captureId);
          retried += 1;
        });
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
        void updateQueue(async () => {
          const payload = normalizePayload(message);
          const allow = await shouldCaptureUrl(payload.url, { ignorePaused: payload.manual });
          if (!allow) throw new Error('Capture blocked by your capture rules.');
          await persistAndEnqueue(payload, 0);
        }).then(() => sendResponse?.({ status: 'queued' }))
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
          requeueProcessing(targetUrl ? [{ url: targetUrl }] : [])
            .then((result) => sendResponse({ retried: result.retried }))
            .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
          return true;
        }
        return false;
      }
      if (message.type === 'RETRY_FAILED_CAPTURES') {
        if (typeof sendResponse === 'function') {
          storageManager.listFailedProcessingTargets()
            .then(requeueProcessing)
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
    get ready() { return ensureReady(); },
    bindRuntimeListener,
    isProcessing: () => processing,
    peekQueue: (): readonly QueueItem[] => queue
  };
}
