/// <reference types="chrome" />

import { runOperation, cancelOperation } from './operations';
import { CHAT_PROVIDER_DISABLED } from '../../shared/config/index';
import { cancelSavedWork } from '../processing/savedWork';
import { getSettings, updateSettings, toggleCapturePause, excludeCaptureSite } from '../settings/index';
import { captureTab } from '../capture/manual';
import {
  getEmbeddingConfig,
  updateEmbeddingConfig,
  getBrowserEmbedStatus,
  prefetchBrowserEmbeddings,
  listBrowserModels,
  deleteBrowserModel,
  getBrowserModelDownload,
  cancelBrowserModelDownload,
  probeBrowserEmbeddingRuntime
} from '../embeddings/index';
import { searchStoredPages } from '../search/index';
import { handleAskQuestion, cancelAskQuestion, cancelAllAskQuestions, type AskOptions } from '../ask/index';
import {
  deleteManagePages,
  previewForgetPages,
  forgetManagePages,
  exportManagePages,
  exportBackupPage,
  importBackupPage,
  getManagePages,
  getPagePreview,
  importManagePages
} from '../manage/index';
import { getHighlightForDate, listHighlightDates } from '../highlights/index';
import { getModelSettings, updateModelSettings } from '../models/index';
import { providerManager } from '../providers/manager';
import { getProviderBaseUrl } from '../providers/config';
import { listLogs, clearLogs } from '../logs/index';
import { backfillMissingEmbeddings } from '../embeddings/backfill';
import { queuePageSummary } from '../summaries/index';
import type { BetaSettings, EmbeddingConfig } from '../../shared/config/index';
import { AppleSafetyBlockError } from '../../shared/providerErrors';
import { getRecentPages } from '../manage/recents';
import { readSearchFilters } from '../../shared/searchFilters';
import { getSavedPage, getSavedHistory } from '../manage/reader';
import { storageManager } from '../storage/manager';
import { bindBackupTransfers } from '../manage/backup';
import { bindFolderBackups, getFolderBackup, setFolderBackup, runFolderBackup } from '../manage/folderBackup';
import { isTrustedUi } from './trustedUi';
import { needsLibraryRecovery } from '../storage/libraryRecovery';

type RuntimeMessage =
  | { type: 'GET_BACKUP_RESTORE_MODE' }
  | { type: 'GET_FOLDER_BACKUP'; probe?: boolean }
  | { type: 'SET_FOLDER_BACKUP'; automatic: unknown; keep: unknown }
  | { type: 'RUN_FOLDER_BACKUP' }
  | { type: 'CANCEL_ASK'; requestId: string }
  | { type: 'CANCEL_SEARCH'; requestId: string }
  | { type: 'CANCEL_BACKFILL'; requestId: string }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; payload?: Partial<BetaSettings> }
  | { type: 'TOGGLE_CAPTURE_PAUSE' }
  | { type: 'EXCLUDE_ACTIVE_SITE' }
  | { type: 'SET_APPLE_CLOUD'; enabled: boolean; acknowledgeCloud?: boolean }
  | { type: 'GET_EMBEDDING_CONFIG' }
  | { type: 'SET_EMBEDDING_CONFIG'; payload?: Partial<EmbeddingConfig>; acknowledgeRemoteOrigin?: boolean }
  | { type: 'SEARCH_QUERY'; query: string; limit?: number; requestId?: string; filters?: unknown }
  | { type: 'ASK_QUESTION'; question: string; options?: AskOptions }
  | { type: 'GET_MODEL_SETTINGS' }
  | { type: 'SET_MODEL'; key: 'chatModel'; value?: string }
  | { type: 'LIST_MODELS' }
  | { type: 'GET_PROVIDERS' }
  | { type: 'GET_PROVIDER_CONFIG'; providerId: string }
  | { type: 'SET_PROVIDER_SETTING'; providerId: string; key: string; value?: string; acknowledgeRemoteOrigin?: boolean }
  | { type: 'PROVIDER_ACTION'; providerId: string; action: string; baseOverride?: string }
  | { type: 'GET_PAGE_LIST' }
  | { type: 'GET_RECENT_PAGES'; after?: unknown }
  | { type: 'GET_PAGE_PREVIEW'; url: string; timestamp?: number; versionId?: string }
  | { type: 'GET_SAVED_PAGE'; url: string; timestamp?: number; query?: string; chunkIndex?: number; versionId?: string }
  | { type: 'GET_SAVED_HISTORY'; url: string }
  | { type: 'UPDATE_SAVED_VERSION'; url: string; versionId: string; action: 'keep' | 'release' | 'delete' }
  | { type: 'DELETE_PAGE'; url?: string; urls?: string[] }
  | { type: 'PREVIEW_FORGET_PAGES'; filters?: unknown }
  | { type: 'FORGET_PAGES'; selection?: unknown; filters?: unknown }
  | { type: 'GET_ALL_PAGES' }
  | { type: 'GET_BACKUP_PAGE'; afterUrl?: string }
  | { type: 'IMPORT_BACKUP_PAGE'; line: string }
  | { type: 'IMPORT_PAGES'; pages: Array<Record<string, unknown>>; schemaVersion?: number }
  | { type: 'LIST_HIGHLIGHT_DATES'; from?: string; to?: string; offset?: number; limit?: number }
  | { type: 'GET_HIGHLIGHTS'; date?: string }
  | { type: 'GET_LOGS' }
  | { type: 'CLEAR_LOGS' }
  | { type: 'GET_PROCESSING' }
  | { type: 'CAPTURE_ACTIVE_TAB' }
  | { type: 'BACKFILL_EMBEDDINGS'; requestId?: string; limit?: number; force?: boolean; urls?: string[]; createSummaries?: boolean; regenerateSummaries?: boolean }
  | { type: 'REGENERATE_PAGE_SUMMARY'; requestId: string; url: string }
  | { type: 'GET_BROWSER_EMBED_STATUS'; probe?: boolean }
  | { type: 'DOWNLOAD_BROWSER_EMBED'; requestId?: string; model?: string; revision?: string }
  | { type: 'GET_BROWSER_MODEL_DOWNLOAD' }
  | { type: 'CANCEL_BROWSER_MODEL_DOWNLOAD'; requestId: string }
  | { type: 'LIST_BROWSER_MODELS' }
  | { type: 'DELETE_BROWSER_MODEL'; model: string; revision: string };

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
  promise.then(sendResponse).catch((err) => sendResponse({
    error: toErrorMessage(err),
    ...(err instanceof AppleSafetyBlockError ? { errorCode: err.code } : {})
  }));
  return true;
}

function handleCaptureActiveTab(sendResponse: SendResponse): boolean {
  return respondWith(chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then((tabs: Array<{ id?: number }>) => captureTab(tabs[0]?.id)), sendResponse);
}

const runtimeHandlers: RuntimeHandlerMap = {
  GET_BACKUP_RESTORE_MODE: (_message, respond) => respondWith(needsLibraryRecovery().then(recover => ({ recover })), respond),
  GET_FOLDER_BACKUP: (message, respond) => respondWith(getFolderBackup(message.probe === true), respond),
  SET_FOLDER_BACKUP: (message, respond) => respondWith(setFolderBackup(message.automatic, message.keep).then(() => ({ ok: true })), respond),
  RUN_FOLDER_BACKUP: (_message, respond) => respondWith(runFolderBackup(), respond),
  TOGGLE_CAPTURE_PAUSE: (_message, sendResponse) => respondWith(toggleCapturePause().then(settings => ({ settings })), sendResponse),
  EXCLUDE_ACTIVE_SITE: (_message, sendResponse) => respondWith(chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs: Array<{ url?: string }>) => excludeCaptureSite(tabs[0]?.url || '')), sendResponse),
  PREVIEW_FORGET_PAGES: (message, sendResponse) => respondWith(previewForgetPages(message.filters), sendResponse),
  FORGET_PAGES: (message, sendResponse) => respondWith(forgetManagePages(message.selection, message.filters), sendResponse),
  GET_BACKUP_PAGE: (message, sendResponse) =>
    respondWith(exportBackupPage(message.afterUrl), sendResponse),
  IMPORT_BACKUP_PAGE: (message, sendResponse) =>
    respondWith(importBackupPage(message.line), sendResponse),
  CANCEL_SEARCH: (message, sendResponse) => {
    sendResponse({ cancelled: cancelOperation('search', message.requestId) });
    return false;
  },
  CANCEL_BACKFILL: (message, sendResponse) => {
    sendResponse({ cancelled: cancelOperation('backfill', message.requestId) });
    return false;
  },
  CANCEL_ASK: (message, sendResponse) => {
    sendResponse({ cancelled: cancelAskQuestion(String(message.requestId || '')) });
    return false;
  },
  GET_SETTINGS: (_message, sendResponse) =>
    respondWith(getSettings().then((settings) => ({ settings })), sendResponse),

  SET_SETTINGS: (message, sendResponse) => {
    const payload = { ...message.payload };
    delete payload.applePrivateCloud;
    return respondWith(updateSettings(payload).then(settings => {
      if (payload.activeProviderId === CHAT_PROVIDER_DISABLED) cancelAllAskQuestions();
      return { settings };
    }), sendResponse);
  },

  SET_APPLE_CLOUD: (message, sendResponse) => {
    if (typeof message.enabled !== 'boolean' || (message.enabled && message.acknowledgeCloud !== true)) {
      sendResponse({ error: 'Private Cloud Compute requires explicit acknowledgement.' }); return false;
    }
    return respondWith(updateSettings({ applePrivateCloud: message.enabled }).then(settings => ({ settings })), sendResponse);
  },

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
      updateEmbeddingConfig(message.payload || {}, { acknowledgeRemoteOrigin: message.acknowledgeRemoteOrigin === true }).then(async () => ({
        config: getEmbeddingConfig(),
        settings: await getSettings()
      })),
      sendResponse
    ),

  SEARCH_QUERY: (message, sendResponse) =>
    respondWith(
      runOperation('search', message.requestId, (signal) => searchStoredPages(
        String(message.query || ''),
        typeof message.limit === 'number' ? message.limit : 10,
        { signal, filters: readSearchFilters(message.filters), onTextResults: results => {
          if (message.requestId) void Promise.resolve(chrome.runtime.sendMessage({ type: 'SEARCH_RESULTS_UPDATE', requestId: message.requestId, results })).catch(() => {});
        } }
      )).then((results) => ({ results })),
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
    sendResponse({ error: 'Choose a chat model.' });
    return false;
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

  GET_PROVIDER_CONFIG: (message, sendResponse) =>
    respondWith(getProviderBaseUrl(message.providerId).then(baseUrl => ({ baseUrl })), sendResponse),

  SET_PROVIDER_SETTING: (message, sendResponse) =>
    respondWith(
      providerManager
        .setProviderSetting(message.providerId, message.key, String(message.value || ''), {
          acknowledgeRemoteOrigin: message.acknowledgeRemoteOrigin === true
        })
        .then(() => providerManager.getProviders())
        .then(async (providers) => ({ providers, settings: await getSettings() })),
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

  GET_PAGE_PREVIEW: (message, sendResponse) => respondWith(getPagePreview(String(message.url || ''), message.timestamp, message.versionId).then(page => ({ page })), sendResponse),
  GET_SAVED_PAGE: (message, sendResponse) => respondWith(getSavedPage(String(message.url || ''), message.timestamp, String(message.query || ''), message.chunkIndex, message.versionId).then(page => ({ page })), sendResponse),
  GET_SAVED_HISTORY: (message, sendResponse) => respondWith(getSavedHistory(String(message.url || '')).then(versions => ({ versions })), sendResponse),
  UPDATE_SAVED_VERSION: (message, sendResponse) => {
    if (!['keep', 'release', 'delete'].includes(message.action)) { sendResponse({ error: 'Choose a supported saved-version action.' }); return false; }
    return respondWith(storageManager.updateSavedVersion(String(message.url || ''), String(message.versionId || ''), message.action).then(removed => { cancelSavedWork(removed); return { ok: true }; }), sendResponse);
  },

  GET_PAGE_LIST: (_message, sendResponse) =>
    respondWith(
      getManagePages().then((pages) => ({ pages })),
      sendResponse
    ),

  GET_RECENT_PAGES: (message, sendResponse) =>
    respondWith(getRecentPages(message.after).then(batch => ({ ...batch })), sendResponse),

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
        schemaVersion: message.schemaVersion,
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
    respondWith(storageManager.listProcessingSummaries().then(queue => ({ queue })), sendResponse),

  CAPTURE_ACTIVE_TAB: (_message, sendResponse) => handleCaptureActiveTab(sendResponse),

  BACKFILL_EMBEDDINGS: (message, sendResponse) =>
    respondWith(
      runOperation('backfill', message.requestId, (signal) => backfillMissingEmbeddings(
        typeof message.limit === 'number' ? message.limit : 50,
        Boolean(message.force),
        Array.isArray(message.urls) ? (message.urls as string[]) : undefined,
        (progress) => { void chrome.runtime.sendMessage({ type: 'BACKFILL_PROGRESS', requestId: message.requestId, ...progress }).catch(() => {}); },
        signal,
        message.createSummaries === true,
        message.regenerateSummaries === true
      )).then((result) => ({ result })),
      sendResponse
    ),

  REGENERATE_PAGE_SUMMARY: (message, sendResponse) => {
    if (typeof message.url !== 'string' || !/^https?:\/\//i.test(message.url) || typeof message.requestId !== 'string' || !message.requestId) {
      sendResponse({ error: 'Choose a saved page to regenerate its summary.' }); return false;
    }
    return respondWith(runOperation('backfill', message.requestId, async signal => ({ updated: await queuePageSummary(message.url, signal, true) })), sendResponse);
  },

  GET_BROWSER_EMBED_STATUS: (message, sendResponse) =>
    message.probe
      ? respondWith(probeBrowserEmbeddingRuntime().then((status) => ({ status })), sendResponse)
      : (() => {
          sendResponse({ status: getBrowserEmbedStatus() });
          return false;
        })(),

  DOWNLOAD_BROWSER_EMBED: (message, sendResponse) =>
    respondWith(prefetchBrowserEmbeddings({ requestId: message.requestId, model: message.model, revision: message.revision }).then(() => ({ ok: true })), sendResponse),

  GET_BROWSER_MODEL_DOWNLOAD: (_message, sendResponse) => respondWith(getBrowserModelDownload().then(download => ({ download })), sendResponse),

  CANCEL_BROWSER_MODEL_DOWNLOAD: (message, sendResponse) => respondWith(cancelBrowserModelDownload(String(message.requestId || '')), sendResponse),

  LIST_BROWSER_MODELS: (_message, sendResponse) => respondWith(listBrowserModels().then(models => ({ models })), sendResponse),

  DELETE_BROWSER_MODEL: (message, sendResponse) => respondWith(deleteBrowserModel(String(message.model || ''), String(message.revision || '')), sendResponse)
};

export function orchestrateLifecycle(): void {
  console.info('[beta-background:orchestration] lifecycle orchestration ready');
  bindBackupTransfers();
  bindFolderBackups();
  chrome.runtime.onMessage.addListener(
    (
      message: (RuntimeMessage & Record<string, unknown>) | undefined,
      sender: unknown,
      sendResponse: SendResponse
    ) => {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        return false;
      }
      const handler = runtimeHandlers[message.type as RuntimeMessage['type']];
      if (!handler) return false;
      const captureActions = ['TOGGLE_CAPTURE_PAUSE', 'EXCLUDE_ACTIVE_SITE', 'PREVIEW_FORGET_PAGES', 'FORGET_PAGES', 'GET_SAVED_HISTORY', 'UPDATE_SAVED_VERSION'];
      const backupActions = ['GET_ALL_PAGES', 'GET_BACKUP_PAGE', 'IMPORT_BACKUP_PAGE', 'IMPORT_PAGES', 'GET_BACKUP_RESTORE_MODE', 'GET_FOLDER_BACKUP', 'SET_FOLDER_BACKUP', 'RUN_FOLDER_BACKUP'];
      const guarded = ['SET_SETTINGS', 'ASK_QUESTION', 'SEARCH_QUERY', 'GET_SAVED_PAGE', 'CANCEL_ASK', 'CANCEL_SEARCH', 'PROVIDER_ACTION', 'SET_APPLE_CLOUD', 'REGENERATE_PAGE_SUMMARY', 'BACKFILL_EMBEDDINGS', 'CANCEL_BACKFILL', ...backupActions, ...captureActions];
      if (guarded.includes(message.type)) {
        const source = sender as { id?: string; url?: string };
        const trusted = isTrustedUi(source);
        if (!trusted) { sendResponse({ error: captureActions.includes(message.type) ? 'Only Web Recall extension pages can use capture controls.' : backupActions.includes(message.type) ? 'Only Web Recall extension pages can transfer saved memory.' : message.type === 'GET_SAVED_PAGE' ? 'Only Web Recall extension pages can read saved captures.' : 'Only Web Recall extension pages can request model operations.' }); return false; }
      }
      return (handler as (message: RuntimeMessage & Record<string, unknown>, sendResponse: SendResponse) => boolean)(
        message,
        sendResponse
      );
    }
  );
}
