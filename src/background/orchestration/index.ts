/// <reference types="chrome" />

import { getSettings, shouldCaptureUrl, updateSettings } from '../settings/index';
import {
  getEmbeddingConfig,
  updateEmbeddingConfig,
  getBrowserEmbedStatus,
  prefetchBrowserEmbeddings
} from '../embeddings/index';
import { searchStoredPages } from '../search/index';
import { handleAskQuestion } from '../ask/index';
import {
  deleteManagePages,
  exportManagePages,
  getManagePages,
  importManagePages
} from '../manage/index';
import { getHighlightForDate, listHighlightDates } from '../highlights/index';
import { getModelSettings, updateModelSettings } from '../models/index';
import { providerManager } from '../providers/manager';
import { listLogs, clearLogs } from '../logs/index';
import { listProcessingEntries } from '../processing/index';
import { getCalibration, updateCalibration } from '../calibration/index';
import { backfillMissingEmbeddings } from '../embeddings/backfill';
import type { BetaSettings, EmbeddingConfig } from '../../shared/config/index';

type RuntimeMessage =
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; payload?: Partial<BetaSettings> }
  | { type: 'GET_EMBEDDING_CONFIG' }
  | { type: 'SET_EMBEDDING_CONFIG'; payload?: Partial<EmbeddingConfig> }
  | { type: 'SEARCH_QUERY'; query: string; limit?: number }
  | { type: 'ASK_QUESTION'; question: string; options?: { useSearch?: boolean; maxResults?: number; requestId?: string } }
  | { type: 'GET_MODEL_SETTINGS' }
  | { type: 'SET_MODEL'; key: 'chatModel' | 'summaryModel'; value?: string }
  | { type: 'LIST_MODELS' }
  | { type: 'GET_PROVIDERS' }
  | { type: 'SET_PROVIDER_SETTING'; providerId: string; key: string; value?: string }
  | { type: 'PROVIDER_ACTION'; providerId: string; action: string; baseOverride?: string }
  | { type: 'GET_PAGE_LIST' }
  | { type: 'DELETE_PAGE'; url?: string; urls?: string[] }
  | { type: 'GET_ALL_PAGES' }
  | { type: 'IMPORT_PAGES'; pages: Array<Record<string, unknown>>; schemaVersion?: number }
  | { type: 'LIST_HIGHLIGHT_DATES'; from?: string; to?: string; offset?: number; limit?: number }
  | { type: 'GET_HIGHLIGHTS'; date?: string }
  | { type: 'GET_LOGS' }
  | { type: 'CLEAR_LOGS' }
  | { type: 'GET_PROCESSING' }
  | { type: 'CAPTURE_ACTIVE_TAB' }
  | { type: 'GET_CALIBRATION' }
  | { type: 'SET_CALIBRATION'; payload?: { wSim?: number; wLLM?: number } }
  | { type: 'BACKFILL_EMBEDDINGS'; limit?: number; force?: boolean; urls?: string[] }
  | { type: 'GET_BROWSER_EMBED_STATUS' }
  | { type: 'DOWNLOAD_BROWSER_EMBED' };

type SendResponse = (response?: Record<string, unknown>) => void;
type RuntimeHandler<K extends RuntimeMessage['type']> = (
  message: Extract<RuntimeMessage, { type: K }> & Record<string, unknown>,
  sendResponse: SendResponse
) => boolean;
type RuntimeHandlerMap = {
  [K in RuntimeMessage['type']]: RuntimeHandler<K>;
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function respondWith(
  promise: Promise<Record<string, unknown>>,
  sendResponse: SendResponse
): boolean {
  promise.then(sendResponse).catch((err) => sendResponse({ error: toErrorMessage(err) }));
  return true;
}

function handleCaptureActiveTab(sendResponse: SendResponse): boolean {
  chrome.tabs.query(
    { active: true, lastFocusedWindow: true },
    (tabs: Array<{ id?: number | null; windowId?: number }>) => {
      const tab = tabs?.[0];
      const url = tab && typeof tab === 'object' ? (tab as { url?: string }).url : '';
      const isSupported =
        typeof url === 'string' &&
        (url.startsWith('http://') || url.startsWith('https://'));
      if (!tab?.id) {
        sendResponse({ error: 'No active tab' });
        return;
      }
      if (!isSupported) {
        sendResponse({ error: 'Cannot capture this page (unsupported or restricted URL).' });
        return;
      }
      void shouldCaptureUrl(url, { ignorePaused: true })
        .then((allow) => {
          if (!allow) {
            sendResponse({
              error: 'Capture blocked by your allowlist or denylist rules for this page.'
            });
            return;
          }
          const attemptCapture = (retries = 1): void => {
            chrome.tabs.sendMessage(
              tab.id!,
              { type: 'FORCE_CAPTURE', payload: { manual: true } },
              (response?: { ok?: boolean }) => {
                const err = chrome.runtime.lastError;
                if (
                  err &&
                  retries > 0 &&
                  err.message?.includes('Receiving end does not exist')
                ) {
                  try {
                    chrome.scripting
                      .executeScript({
                        target: { tabId: tab.id! },
                        files: ['dist/beta/content.js']
                      })
                      .then(() => {
                        attemptCapture(retries - 1);
                      })
                      .catch(() => {
                        sendResponse({
                          error: 'Capture failed: content script unavailable for this page.'
                        });
                      });
                  } catch {
                    sendResponse({
                      error: 'Capture failed: content script unavailable for this page.'
                    });
                  }
                  return;
                }
                if (err) {
                  sendResponse({
                    error: 'Capture failed: content script unavailable for this page.'
                  });
                } else {
                  sendResponse({ ok: true, received: response?.ok === true });
                }
              }
            );
          };
          attemptCapture();
        })
        .catch((err) => {
          sendResponse({ error: toErrorMessage(err) });
        });
    }
  );
  return true;
}

const runtimeHandlers: RuntimeHandlerMap = {
  GET_SETTINGS: (_message, sendResponse) =>
    respondWith(getSettings().then((settings) => ({ settings })), sendResponse),

  SET_SETTINGS: (message, sendResponse) =>
    respondWith(
      updateSettings(message.payload || {}).then((settings) => ({ settings })),
      sendResponse
    ),

  GET_EMBEDDING_CONFIG: (_message, sendResponse) => {
    try {
      sendResponse({ config: getEmbeddingConfig() });
    } catch (err) {
      sendResponse({ error: toErrorMessage(err) });
    }
    return false;
  },

  SET_EMBEDDING_CONFIG: (message, sendResponse) =>
    respondWith(
      updateEmbeddingConfig(message.payload || {}).then(() => ({
        config: getEmbeddingConfig()
      })),
      sendResponse
    ),

  SEARCH_QUERY: (message, sendResponse) =>
    respondWith(
      searchStoredPages(
        String(message.query || ''),
        typeof message.limit === 'number' ? message.limit : 10
      ).then((results) => ({ results })),
      sendResponse
    ),

  ASK_QUESTION: (message, sendResponse) =>
    respondWith(
      handleAskQuestion(String(message.question || ''), message.options).then((payload) => ({
        ...payload
      })),
      sendResponse
    ),

  GET_MODEL_SETTINGS: (_message, sendResponse) =>
    respondWith(
      getModelSettings().then((settings) => ({ settings })),
      sendResponse
    ),

  SET_MODEL: (message, sendResponse) => {
    if (message.key === 'chatModel' && typeof message.value === 'string') {
      return respondWith(
        updateModelSettings({ chatModel: message.value }).then(() => ({
          settings: { chatModel: message.value }
        })),
        sendResponse
      );
    }
    return respondWith(
      updateModelSettings({
        [message.key]: message.value
      } as Partial<Awaited<ReturnType<typeof getModelSettings>>>).then((settings) => ({
        settings
      })),
      sendResponse
    );
  },

  LIST_MODELS: (_message, sendResponse) =>
    respondWith(
      providerManager.listModels('ollama').then((models) => ({ models })),
      sendResponse
    ),

  GET_PROVIDERS: (_message, sendResponse) =>
    respondWith(
      providerManager.getProviders().then((providers) => ({ providers })),
      sendResponse
    ),

  SET_PROVIDER_SETTING: (message, sendResponse) =>
    respondWith(
      providerManager
        .setProviderSetting(message.providerId, message.key, String(message.value || ''))
        .then(() => providerManager.getProviders())
        .then((providers) => ({ providers })),
      sendResponse
    ),

  PROVIDER_ACTION: (message, sendResponse) =>
    respondWith(
      providerManager.runAction(message.providerId, message.action, {
        baseOverride:
          typeof message.baseOverride === 'string' ? message.baseOverride : undefined
      }) as Promise<Record<string, unknown>>,
      sendResponse
    ),

  GET_PAGE_LIST: (_message, sendResponse) =>
    respondWith(
      getManagePages().then((pages) => ({ pages })),
      sendResponse
    ),

  DELETE_PAGE: (message, sendResponse) => {
    const urls = Array.isArray(message.urls)
      ? message.urls.map((url) => String(url)).filter(Boolean)
      : message.url
        ? [String(message.url)]
        : [];
    return respondWith(
      deleteManagePages(urls).then((deleted) => ({ deleted })),
      sendResponse
    );
  },

  GET_ALL_PAGES: (_message, sendResponse) =>
    respondWith(
      exportManagePages().then((pages) => ({ pages })),
      sendResponse
    ),

  IMPORT_PAGES: (message, sendResponse) =>
    respondWith(
      importManagePages({
        pages: Array.isArray(message.pages)
          ? message.pages.map((entry) => ({ ...(entry as Record<string, unknown>) }))
          : []
      }).then((result) => ({ ...result })),
      sendResponse
    ),

  LIST_HIGHLIGHT_DATES: (message, sendResponse) =>
    respondWith(
      listHighlightDates({
        from: message.from,
        to: message.to,
        offset: message.offset,
        limit: message.limit
      }).then((payload) => ({ ...payload })),
      sendResponse
    ),

  GET_HIGHLIGHTS: (message, sendResponse) =>
    respondWith(
      getHighlightForDate(String(message.date || '')).then((highlight) => ({
        highlight
      })),
      sendResponse
    ),

  GET_LOGS: (_message, sendResponse) =>
    respondWith(listLogs().then((logs) => ({ logs })), sendResponse),

  CLEAR_LOGS: (_message, sendResponse) =>
    respondWith(clearLogs().then(() => ({ ok: true })), sendResponse),

  GET_PROCESSING: (_message, sendResponse) =>
    respondWith(
      listProcessingEntries().then((queue) => ({ queue })),
      sendResponse
    ),

  CAPTURE_ACTIVE_TAB: (_message, sendResponse) => handleCaptureActiveTab(sendResponse),

  GET_CALIBRATION: (_message, sendResponse) =>
    respondWith(
      getCalibration().then((calibration) => ({ calibration })),
      sendResponse
    ),

  SET_CALIBRATION: (message, sendResponse) =>
    respondWith(
      updateCalibration(message.payload || {}).then((calibration) => ({ calibration })),
      sendResponse
    ),

  BACKFILL_EMBEDDINGS: (message, sendResponse) =>
    respondWith(
      backfillMissingEmbeddings(
        typeof message.limit === 'number' ? message.limit : 50,
        Boolean(message.force),
        Array.isArray(message.urls) ? (message.urls as string[]) : undefined
      ).then((result) => ({ result })),
      sendResponse
    ),

  GET_BROWSER_EMBED_STATUS: (_message, sendResponse) => {
    sendResponse({ status: getBrowserEmbedStatus() });
    return false;
  },

  DOWNLOAD_BROWSER_EMBED: (_message, sendResponse) =>
    respondWith(prefetchBrowserEmbeddings().then(() => ({ ok: true })), sendResponse)
};

export function orchestrateLifecycle(): void {
  console.info('[beta-background:orchestration] lifecycle orchestration ready');
  chrome.runtime.onMessage.addListener(
    (
      message: (RuntimeMessage & Record<string, unknown>) | undefined,
      _sender: unknown,
      sendResponse: SendResponse
    ) => {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        return false;
      }
      const handler = runtimeHandlers[message.type as RuntimeMessage['type']];
      if (!handler) return false;
      return (handler as (message: RuntimeMessage & Record<string, unknown>, sendResponse: SendResponse) => boolean)(
        message,
        sendResponse
      );
    }
  );
}
