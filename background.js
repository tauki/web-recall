/**
 * Background service worker:
 * - receives capture payloads from content scripts
 * - calls local Ollama endpoints for embeddings/chat
 * - persists pages/highlights in IndexedDB
 * - responds to search, Ask, highlights, and settings requests from UI surfaces
 */
// Import side-effect modules so IndexedDB helpers and text utilities register on global scope.
import './db.js';
import './text.js';

// ---------------------------------------------------------------------------
// Capture queue: ensures we process one page at a time per MV3 limitations.
// ---------------------------------------------------------------------------
const PROCESS_QUEUE = [];
let PROCESSING = false;
const ENQUEUED_URLS = new Set();
let CURRENT_URL = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function enqueueProcess(message, delayMs = 0) {
  try {
    const url = message && message.url;
    if (!url) return;
    // If already queued, update payload and keep the larger delay
    for (let i = 0; i < PROCESS_QUEUE.length; i++) {
      const it = PROCESS_QUEUE[i];
      if (it.url === url) {
        it.message = message;
        it.delayMs = Math.max(it.delayMs || 0, delayMs || 0);
        return;
      }
    }
    // If currently processing this exact URL, skip enqueuing a duplicate
    if (CURRENT_URL === url) return;
    PROCESS_QUEUE.push({ url, message, delayMs: delayMs || 0 });
    ENQUEUED_URLS.add(url);
    runProcessQueue();
  } catch (_) {}
}

async function runProcessQueue() {
  if (PROCESSING) return;
  PROCESSING = true;
  try {
    while (PROCESS_QUEUE.length > 0) {
      const { url, message, delayMs } = PROCESS_QUEUE.shift();
      ENQUEUED_URLS.delete(url);
      CURRENT_URL = url;
      if (delayMs && delayMs > 0) {
        try { await sleep(delayMs); } catch (_) {}
      }
      try {
        await processAndStore(message);
      } catch (err) {
        try { await LOGGER.error('queue worker error', { url, error: String(err) }); } catch (_) {}
      } finally {
        CURRENT_URL = null;
      }
    }
  } finally {
    PROCESSING = false;
  }
}

// ---------------------------------------------------------------------------
// Summary backfill queue: generate missing per-page summaries independently.
// ---------------------------------------------------------------------------
const SUMMARY_QUEUE = [];
let SUMMARY_RUNNING = false;

// Used by highlights view and maintenance flows to (re)generate missing summaries.
function enqueueSummaryBackfill(task) {
  // task: { id, date }
  if (!task || typeof task.id !== 'number') return;
  if (SUMMARY_QUEUE.find(t => t.id === task.id)) return; // dedupe by id
  SUMMARY_QUEUE.push({ id: task.id, date: task.date || null, attempts: 0 });
  runSummaryQueue();
}

async function runSummaryQueue() {
  if (SUMMARY_RUNNING) return;
  SUMMARY_RUNNING = true;
  try {
    while (SUMMARY_QUEUE.length > 0) {
      const task = SUMMARY_QUEUE.shift();
      try {
        const page = await getPageById(task.id);
        if (!page) continue;
        if (page.summary && page.summary.length > 0) continue;
        const combined = (page.items || []).map(it => it.text || '').join(' ').trim();
        if (!combined) continue;
        const sum = await withRetry(() => computeSummary(combined), { retries: 1, delayMs: 1200 });
        if (sum && sum.length > 0) {
          page.summary = sum;
          const db = await openDB();
          await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(page);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          const dateStr = task.date || formatLocalYMD(page.timestamp);
          try { await removeHighlightCache(dateStr); } catch (_) {}
          try { await getHighlights(dateStr); } catch (_) {}
        } else {
          // retry with backoff
          task.attempts = (task.attempts || 0) + 1;
          if (task.attempts <= 3) {
            const backoff = 1000 * Math.pow(2, task.attempts - 1);
            setTimeout(() => enqueueSummaryBackfill(task), backoff);
          }
        }
      } catch (_) {
        // continue
      }
    }
  } finally {
    SUMMARY_RUNNING = false;
  }
}

/**
 * Format a Date or timestamp into local YYYY-MM-DD string (no UTC skew).
 * @param {number|Date} d
 * @returns {string}
 */
// Cross-context: used by highlights.html, logs, and cache invalidation paths.
function formatLocalYMD(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Highlights cache helpers (IndexedDB store).
// ---------------------------------------------------------------------------
async function getHighlightCache(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(HIGHLIGHTS_STORE, 'readonly');
      const req = tx.objectStore(HIGHLIGHTS_STORE).get(date);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function setHighlightCache(date, obj) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(HIGHLIGHTS_STORE, 'readwrite');
      tx.objectStore(HIGHLIGHTS_STORE).put({ ...(obj || {}), date });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (e) { resolve(); }
  });
}
// Cross-context: highlights cache invalidation; called from delete/import/update flows.
async function removeHighlightCache(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(HIGHLIGHTS_STORE, 'readwrite');
      tx.objectStore(HIGHLIGHTS_STORE).delete(date);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    } catch (e) { resolve(); }
  });
}

// ---------------------------------------------------------------------------
// IndexedDB CRUD helpers for pages.
// ---------------------------------------------------------------------------
async function savePage(pageRecord) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(pageRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllPages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      resolve(request.result || []);
    };
    request.onerror = () => {
      reject(request.error);
    };
  });
}

async function getPageList() {
  const pages = await getAllPages();
  return pages
    .map(p => ({ id: p.id, url: p.url, title: p.title, timestamp: p.timestamp }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** Delete a page record by id */
async function deletePageById(id) {
  const db = await openDB();
  // Load page to invalidate highlight cache for its day
  let page = null;
  try {
    const txr = db.transaction(STORE_NAME, 'readonly');
    page = await new Promise((resolve) => {
      const req = txr.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) {}
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = async () => {
      try { if (page && page.timestamp) await removeHighlightCache(formatLocalYMD(page.timestamp)); } catch (_) {}
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}


// ---------------------------------------------------------------------------
// Embedding + summary helpers (Ollama integration).
// ---------------------------------------------------------------------------
async function computeEmbedding(text) {
  const { embedModel } = await getModelSettings();
  const model = embedModel || 'embeddinggemma';
  LOGGER.debug('computeEmbedding start');
  try {
    const body = { model, input: text };
    const base = await getOllamaBase();
    const res = await logFetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { kind: 'embed' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.embeddings) && data.embeddings.length > 0) {
        LOGGER.debug('computeEmbedding ok via /api/embed');
        const vec = data.embeddings[0];
        try { await ensureEmbeddingMeta(model, Array.isArray(vec) ? vec.length : 0); } catch (_) {}
        return vec;
      }
    }
  } catch (err) {
    LOGGER.error('computeEmbedding failed', { error: String(err) });
    throw err;
  }
  throw new Error('No embedding returned by Ollama');
}

/**
 * Batch embeddings for multiple texts using Ollama's `/api/embed` endpoint.
 *
 * In newer releases of Ollama, `/api/embed` accepts an array of strings
 * and returns an `embeddings` array with one vector per input.  If
 * the batch request fails (e.g. network error or mismatched length),
 * this function falls back to calling `computeEmbedding()` on each
 * string individually.  We no longer call the deprecated
 * `/api/embeddings` route; per‑item calls still use `/api/embed` under
 * the hood.
 *
 * @param {string[]} texts  The list of text snippets to embed.
 * @param {string} model    Optional override for the embedding model.
 * @returns {Promise<number[][]>}  A list of embedding vectors in the
 *   same order as the input.
 */
async function computeEmbeddingsBatch(texts, model) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  // Try /api/embed with array input first
  try {
    LOGGER.debug('computeEmbeddingsBatch start', { count: texts.length });
    const { embedModel } = await getModelSettings();
    const useModel = model || embedModel || 'embeddinggemma';
    const body = { model: useModel, input: texts };
    const base = await getOllamaBase();
    const res = await logFetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { kind: 'embed_batch', n: texts.length });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) {
        LOGGER.debug('computeEmbeddingsBatch ok', { count: data.embeddings.length });
        const dim = Array.isArray(data.embeddings[0]) ? (data.embeddings[0].length || 0) : 0;
        try { await ensureEmbeddingMeta(useModel, dim); } catch (_) {}
        return data.embeddings;
      }
    }
  } catch (_) {}
  // Fallback: per-text using /api/embed
  const out = [];
  for (const t of texts) {
    try {
      const emb = await computeEmbedding(t);
      out.push(emb);
    } catch (err) {
      LOGGER.error('computeEmbeddingsBatch item failed', { error: String(err) });
    }
  }
  return out;
}

/**
 * List the models available locally via the Ollama API.  This returns an
 * array of model names (e.g. "llama3", "gemma:2b").  It does not
 * include embedding models; you can filter on the UI if necessary.
 *
 * @returns {Promise<string[]>}
 */
async function listModels() {
  try {
    const base = await getOllamaBase();
    const res = await logFetch(`${base}/api/tags`, {}, { kind: 'tags' });
    if (!res.ok) {
      throw new Error(`Model list request failed with ${res.status}`);
    }
    const data = await res.json();
    LOGGER.debug('listModels ok', { count: (data.models || []).length });
    return (data.models || []).map(m => m.name);
  } catch (err) {
    LOGGER.error('listModels failed', { error: String(err) });
    return [];
  }
}

/**
 * Retrieve the currently selected models for summarisation and chat from
 * chrome.storage.local.  Returns null for keys that are not set.
 *
 * @returns {Promise<{summaryModel: string|null, chatModel: string|null}>}
 */
function getModelSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['summaryModel', 'chatModel', 'embedModel'], (result) => {
      resolve({
        summaryModel: result.summaryModel || null,
        chatModel: result.chatModel || null,
        embedModel: result.embedModel || null
      });
    });
  });
}

/**
 * Retrieve stored embedding metadata if present.
 * @returns {Promise<{model:string|null, dim:number}|null>}
 */
function getEmbeddingMeta() {
  return new Promise(resolve => {
    chrome.storage.local.get(['embeddingMeta'], (res) => {
      const m = res && res.embeddingMeta;
      if (m && typeof m === 'object' && Number.isFinite(m.dim)) resolve({ model: m.model || null, dim: m.dim });
      else resolve(null);
    });
  });
}

/**
 * Persist embedding metadata once if not already present. Used to detect
 * vector dimension mismatches gracefully during imports and processing.
 * @param {string|null} model
 * @param {number} dim
 */
async function ensureEmbeddingMeta(model, dim) {
  try {
    if (!Number.isFinite(dim) || dim <= 0) return;
    const cur = await getEmbeddingMeta();
    if (!cur) {
      await new Promise(resolve => chrome.storage.local.set({ embeddingMeta: { model: model || null, dim } }, resolve));
      try { await LOGGER.info('embedding meta persisted', { model: model || null, dim }); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
}

/**
 * Update the selected model in chrome.storage.local.  Accepts the key
 * ("summaryModel" or "chatModel") and the model name.
 *
 * @param {string} key The key to update.
 * @param {string} value The model name.
 * @returns {Promise<void>}
 */
function setModel(key, value) {
  return new Promise(resolve => {
    const obj = {};
    obj[key] = value;
    chrome.storage.local.set(obj, () => resolve());
  });
}

// Track processing pages in storage for UI visibility across SW restarts
// Cross-context: surfaced in sidepanel for live status, survives SW restarts.
function getProcessingPages() {
  return new Promise(resolve => {
    chrome.storage.local.get(['processingPages'], (res) => {
      resolve(Array.isArray(res.processingPages) ? res.processingPages : []);
    });
  });
}
// Internal helper for getProcessingPages(); not invoked directly by UI.
function setProcessingPages(list) {
  return new Promise(resolve => {
    chrome.storage.local.set({ processingPages: list }, () => resolve());
  });
}
// Called on capture start; read by sidepanel.js via GET_PROCESSING.
async function addProcessingPage(meta) {
  const list = await getProcessingPages();
  if (!list.find(p => p.url === meta.url)) list.unshift(meta);
  await setProcessingPages(list.slice(0, 100));
  try { chrome.runtime.sendMessage({ type: 'PAGE_PROCESSING_STARTED', page: meta }); } catch (_) {}
}
// Called when capture concludes (success or failure); updates sidepanel list.
async function removeProcessingPage(url) {
  const list = await getProcessingPages();
  const next = list.filter(p => p.url !== url);
  await setProcessingPages(next);
  try { chrome.runtime.sendMessage({ type: 'PAGE_PROCESSING_ENDED', url }); } catch (_) {}
}
// Updates status/attempts; used by retry logic to keep UI in sync.
async function updateProcessingPage(url, fields) {
  const list = await getProcessingPages();
  const next = list.map(p => p.url === url ? { ...p, ...fields } : p);
  await setProcessingPages(next);
  try { chrome.runtime.sendMessage({ type: 'PAGE_PROCESSING_UPDATED', url, fields }); } catch (_) {}
}


/**
 * Get extension settings controlling search behavior.
 * Defaults: queryRewrite=true, crossEncoder=true
 * @returns {Promise<{queryRewrite:boolean, crossEncoder:boolean}>}
 */
function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['queryRewrite', 'crossEncoder', 'answerMode', 'logLevel', 'logFullBodies', 'ollamaBase', 'enableTools', 'maxToolSteps', 'toolTimeoutMs', 'versioningMaxVersions', 'versioningSimilarityThreshold', 'askTopConcise', 'askTopDetailed', 'askCtxConcise', 'askCtxDetailed', 'paused'], (result) => {
      resolve({
        queryRewrite: result.queryRewrite !== undefined ? result.queryRewrite : false,
        crossEncoder: result.crossEncoder !== undefined ? result.crossEncoder : false,
        answerMode: result.answerMode || 'concise',
        logLevel: result.logLevel || 'info',
        logFullBodies: !!result.logFullBodies,
        ollamaBase: result.ollamaBase || 'http://127.0.0.1:11434',
        enableTools: result.enableTools !== undefined ? !!result.enableTools : true,
        maxToolSteps: typeof result.maxToolSteps === 'number' ? result.maxToolSteps : 2,
        toolTimeoutMs: typeof result.toolTimeoutMs === 'number' ? result.toolTimeoutMs : 0,
        versioningMaxVersions: typeof result.versioningMaxVersions === 'number' ? result.versioningMaxVersions : 3,
        versioningSimilarityThreshold: typeof result.versioningSimilarityThreshold === 'number' ? result.versioningSimilarityThreshold : 0.98,
        askTopConcise: typeof result.askTopConcise === 'number' ? result.askTopConcise : 3,
        askTopDetailed: typeof result.askTopDetailed === 'number' ? result.askTopDetailed : 5,
        askCtxConcise: typeof result.askCtxConcise === 'number' ? result.askCtxConcise : 1200,
        askCtxDetailed: typeof result.askCtxDetailed === 'number' ? result.askCtxDetailed : 2400,
        paused: !!result.paused,
      });
    });
  });
}

// Capture rules
function getCaptureRules() {
  return new Promise(resolve => {
    chrome.storage.local.get(['whitelistDomains', 'blacklistDomains'], (res) => {
      resolve({
        whitelistDomains: Array.isArray(res.whitelistDomains) ? res.whitelistDomains : [],
        blacklistDomains: Array.isArray(res.blacklistDomains) ? res.blacklistDomains : [],
      });
    });
  });
}
function setCaptureRules({ whitelistDomains = [], blacklistDomains = [] }) {
  return new Promise(resolve => {
    const norm = (arr) => (Array.isArray(arr) ? arr : []).map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
    chrome.storage.local.set({ whitelistDomains: norm(whitelistDomains), blacklistDomains: norm(blacklistDomains) }, () => resolve());
  });
}
function domainFromUrl(u) { try { return new URL(u).hostname; } catch (_) { return ''; } }
function matchesDomain(host, list) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const pat = String(raw || '').trim().toLowerCase();
    if (!pat) continue;
    if (pat.startsWith('*.')) {
      const suffix = pat.slice(1); // .example.com
      if (h.endsWith(suffix)) return true;
      continue;
    }
    // Treat bare domain as matching itself and all subdomains
    if (h === pat || h.endsWith('.' + pat)) return true;
  }
  return false;
}
async function shouldCapture(url) {
  // Global pause: short-circuit auto-capture
  try {
    const { paused } = await getSettings();
    if (paused) return false;
  } catch (_) {}
  const { whitelistDomains, blacklistDomains } = await getCaptureRules();
  const host = domainFromUrl(url);
  if (whitelistDomains.length > 0) {
    return matchesDomain(host, whitelistDomains);
  }
  if (matchesDomain(host, blacklistDomains)) return false;
  return true;
}

/**
 * Partially update extension settings.
 * @param {{queryRewrite?:boolean, crossEncoder?:boolean}} partial
 * @returns {Promise<void>}
 */
function setSettings(partial) {
  return new Promise(resolve => {
    chrome.storage.local.set(partial, () => resolve());
  });
}

// -------- Pending capture payloads (for retries) --------
// Cross-context: persists pending capture payloads so retries can survive SW suspend.
function getPendingCaptures() {
  return new Promise(resolve => {
    chrome.storage.local.get(['pendingCaptures'], (res) => {
      resolve(res.pendingCaptures || {});
    });
  });
}
// Internal helper for get/save/remove pending capture maps.
function setPendingCaptures(map) {
  return new Promise(resolve => {
    chrome.storage.local.set({ pendingCaptures: map }, () => resolve());
  });
}
// Called on transient failures to persist the capture message for retry.
async function savePendingCapture(url, payload) {
  const map = await getPendingCaptures();
  map[url] = payload;
  await setPendingCaptures(map);
}
// Clears pending payload after success or when abandoning a retry.
async function removePendingCapture(url) {
  const map = await getPendingCaptures();
  if (map[url]) {
    delete map[url];
    await setPendingCaptures(map);
  }
}
// Retrieves a persisted pending payload for a URL; used by retry worker.
async function getPendingCapture(url) {
  const map = await getPendingCaptures();
  return map[url] || null;
}

// -------- Logging utilities (centralized) --------
import './logger.js'; // attaches LOGGER to global self in MV3 module worker
import './vectors.js'; // attaches cosineSimilarity, recencyWeight, computeCentroid to global self

// ----- Tunables & constants -----
let LOG_FULL_BODIES = false;
const FETCH_TIMEOUT_MS = 0; // default network timeout (0 = caller must specify)
let ACTIVE_TAB_ID = null;

function refreshActiveTabId() {
  if (!chrome.tabs || !chrome.tabs.query) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs && tabs[0] && typeof tabs[0].id === 'number' ? tabs[0].id : null;
    if (typeof id === 'number') ACTIVE_TAB_ID = id;
  });
}

if (chrome.tabs) {
  try {
    chrome.tabs.onActivated.addListener((info) => {
      if (info && typeof info.tabId === 'number') ACTIVE_TAB_ID = info.tabId;
    });
  } catch (_) {}
  try {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (tab && tab.active && typeof tabId === 'number') ACTIVE_TAB_ID = tabId;
    });
  } catch (_) {}
  // Seed initial value on startup/install
  refreshActiveTabId();
}

if (chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    refreshActiveTabId();
  });
}
if (chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    refreshActiveTabId();
  });
}
function getOllamaBase() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ollamaBase'], (res) => resolve(res.ollamaBase || 'http://127.0.0.1:11434'));
  });
}

async function updateActionBadge(paused) {
  if (!chrome.action) return;
  try {
    await chrome.action.setBadgeText({ text: paused ? 'II' : '' });
    if (paused) {
      try { await chrome.action.setBadgeBackgroundColor({ color: '#777' }); } catch (_) {}
      try { await chrome.action.setTitle({ title: 'Web Recall — Paused (click to resume)' }); } catch (_) {}
    } else {
      try { await chrome.action.setTitle({ title: 'Web Recall — Active (click to pause)' }); } catch (_) {}
    }
  } catch (_) {}
}

// Track active Ollama communications to pause polling while busy
let OLLAMA_ACTIVE = 0;

// Quick health check: is the Ollama API reachable?
async function checkModelsOnline() {
  try {
    const st = await getOllamaStatus();
    // If we checked recently (<= 10s), trust cached status
    if (st && typeof st.checkedAt === 'number' && (Date.now() - st.checkedAt) <= 10000) {
      return !!st.online;
    }
  } catch (_) {}
  try {
    const base = await getOllamaBase();
    // Hit the base URL for a cheap health check (expects HTTP 200 OK)
    const res = await logFetch(`${base}/`, {}, { kind: 'health', timeoutMs: 5000 });
    const ok = !!(res && res.ok);
    await setOllamaStatus(ok, ok ? null : 'health check failed');
    return ok;
  } catch (e) {
    try { await setOllamaStatus(false, String(e)); } catch (_) {}
    return false;
  }
}

// Centralized Ollama status state and watcher
function getOllamaStatus() {
  return new Promise(resolve => {
    chrome.storage.local.get(['ollamaStatus'], (res) => {
      const st = res.ollamaStatus || { online: null, checkedAt: 0, lastError: null };
      resolve(st);
    });
  });
}
function setOllamaStatus(online, lastError = null) {
  return new Promise(resolve => {
    const st = { online: !!online, checkedAt: Date.now(), lastError: lastError ? String(lastError) : null };
    chrome.storage.local.set({ ollamaStatus: st }, () => {
      try { chrome.runtime.sendMessage({ type: 'PROVIDER_STATUS', id: 'ollama', status: st }); } catch (_) {}
      resolve();
    });
  });
}
function startOllamaWatcher(intervalMs = 15000) {
  let timer = null;
  async function tick() {
    try {
      // If we're actively communicating with Ollama, skip polling this cycle
      if (OLLAMA_ACTIVE > 0) {
        await LOGGER.debug('ollama watcher skipped (active calls in flight)');
      } else {
        const base = await getOllamaBase();
        const res = await logFetch(`${base}/`, {}, { kind: 'health' });
        await setOllamaStatus(!!res?.ok, res?.ok ? null : `status ${res?.status}`);
      }
    } catch (e) {
      try { await setOllamaStatus(false, String(e)); } catch (_) {}
    } finally {
      timer = setTimeout(tick, intervalMs);
    }
  }
  // Start once and schedule
  tick();
  return () => { if (timer) clearTimeout(timer); };
}

function appendLog(level, message, meta) {
  const entry = { ts: Date.now(), level, message: String(message), meta: meta || null };
  return new Promise(resolve => {
    chrome.storage.local.get(['logs'], (res) => {
      const logs = Array.isArray(res.logs) ? res.logs : [];
      logs.push(entry);
      const capped = logs.slice(-500);
      chrome.storage.local.set({ logs: capped }, () => resolve());
    });
  });
}
function getLogs() {
  return new Promise(resolve => {
    chrome.storage.local.get(['logs'], (res) => resolve(Array.isArray(res.logs) ? res.logs : []));
  });
}
function clearLogs() {
  return new Promise(resolve => {
    chrome.storage.local.set({ logs: [] }, () => resolve());
  });
}

// Generic retry helper with backoff
async function withRetry(fn, { retries = 2, delayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await appendLog('error', 'operation failed, will retry', { attempt: i, error: String(err) });
      if (i < retries) {
        await new Promise(r => setTimeout(r, delayMs * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}

// Calibration settings for combining similarity and LLM rank
function getCalibration() {
  return new Promise(resolve => {
    chrome.storage.local.get(['calibWSim', 'calibWLLM'], (res) => {
      // Default calibration favours similarity over LLM ranking.  If no
      // user-provided weights are present, use 0.8 similarity vs 0.2 LLM.
      let wSim = typeof res.calibWSim === 'number' ? res.calibWSim : 0.8;
      let wLLM = typeof res.calibWLLM === 'number' ? res.calibWLLM : 0.2;
      const sum = wSim + wLLM;
      if (sum <= 0) { wSim = 0.5; wLLM = 0.5; }
      else { wSim /= sum; wLLM /= sum; }
      resolve({ wSim, wLLM });
    });
  });
}
function setCalibration({ calibWSim, calibWLLM }) {
  return new Promise(resolve => {
    const obj = {};
    if (typeof calibWSim === 'number') obj.calibWSim = calibWSim;
    if (typeof calibWLLM === 'number') obj.calibWLLM = calibWLLM;
    chrome.storage.local.set(obj, () => resolve());
  });
}


/**
 * Summarise a block of text using the local Ollama chat API (`/api/chat`).
 * @param {string} text The text to summarise.
 * @returns {Promise<string>} A concise summary, or an empty string on failure.
 */
async function computeSummary(text) {
  // If no text, return an empty summary.
  if (!text || text.trim().length === 0) {
    return '';
  }
  // Fetch the selected summary model.  If none is configured, skip summarisation.
  const { summaryModel } = await getModelSettings();
  if (!summaryModel) {
    return '';
  }
  try {
    const body = {
      model: summaryModel,
      messages: [
        { role: 'system', content: 'You are a helpful summarization assistant.' },
        { role: 'user', content: `Summarise the following text:\n\n${text}\n\nSummary:` }
      ],
      stream: false
    };
    const base = await getOllamaBase();
    const response = await logFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { kind: 'chat_summary' });
    if (!response.ok) {
      throw new Error(`Summary model responded with status ${response.status}`);
    }
    const json = await response.json();
    const out = (json && json.message && json.message.content) ? json.message.content.trim() : '';
    LOGGER.debug('computeSummary ok', { length: out.length });
    return out;
  } catch (err) {
    LOGGER.error('computeSummary failed', { error: String(err) });
    return '';
  }
}

/**
 * Given a query embedding and a list of candidate embeddings, compute the
 * cosine similarity between them.  We normalise by the vector norms.
 *
 * @param {number[]} a Query embedding.
 * @param {number[]} b Candidate embedding.
 * @returns {number} Cosine similarity between -1 and 1.
 */

/**
 * Compute centroid (mean) vector from a list of items with embeddings.
 * @param {{embedding:number[]}[]} items
 * @returns {number[]|null}
 */

// stringHash and normalizeText are provided by text.js

/**
 * Ensure a version object has required fields: timestamp, items with embeddings,
 * centroid and hash. Embeds any items missing embeddings.
 * @param {{timestamp?:number, items?:Array<{text:string, embedding?:number[]}>, centroid?:number[], hash?:number, summary?:string}} v
 * @returns {Promise<typeof v>}
 */
async function ensureVersionData(v, opts = {}) {
  const out = { ...(v || {}) };
  if (typeof out.timestamp !== 'number') out.timestamp = Date.now();
  const items = Array.isArray(out.items) ? out.items : [];
  // Embed missing items
  const need = [];
  const needIdx = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i].embedding || !Array.isArray(items[i].embedding) || items[i].embedding.length === 0) {
      need.push(items[i].text || '');
      needIdx.push(i);
    }
  }
  if (need.length > 0) {
    try {
      const embs = await computeEmbeddingsBatch(need);
      for (let j = 0; j < needIdx.length; j++) {
        const idx = needIdx[j];
        if (embs[j]) items[idx].embedding = embs[j];
      }
    } catch (err) {
      LOGGER.warn('ensureVersionData embeddings failed', { error: String(err) });
      // best-effort: leave partial
    }
  }
  out.items = items;
  if (!out.centroid) {
    try { out.centroid = computeCentroid(items) || undefined; } catch (_) { /* ignore */ }
  }
  if (typeof out.hash !== 'number') {
    const combined = items.map(i => i.text || '').join(' ');
    out.hash = stringHash(combined);
  }
  // Optionally generate summary if missing
  if (opts.fillSummary && (!out.summary || out.summary.length === 0)) {
    try {
      const combined = items.map(i => i.text || '').join(' ').trim();
      if (combined) {
        const sum = await computeSummary(combined);
        if (sum && sum.length > 0) out.summary = sum;
      }
    } catch (_) { /* ignore */ }
  }
  return out;
}

/**
 * Merge a prepared version into the document identified by canonical URL,
 * applying centroid similarity to update latest vs append, and enforcing LRU.
 * @param {string} canUrl
 * @param {string} url
 * @param {string} title
 * @param {object} version Prepared version (ensureVersionData already applied)
 * @param {number} maxVersions
 * @param {number} similarityThreshold
 */
async function upsertVersion(canUrl, url, title, version, maxVersions, similarityThreshold) {
  const db = await openDB();
  let doc = await getByCanonicalUrl(canUrl);
  if (!doc) {
    const rec = {
      canonicalUrl: canUrl,
      url,
      title,
      timestamp: version.timestamp,
      latestVersionIndex: 0,
      versions: [version],
      items: version.items,
      centroid: version.centroid,
      summary: version.summary || ''
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).add(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return;
  }
  // Merge into existing
  if (!Array.isArray(doc.versions) || typeof doc.latestVersionIndex !== 'number') {
    // If somehow legacy, initialise versions with current top-level
    const prevItems = Array.isArray(doc.items) ? doc.items : [];
    doc.versions = [{
      timestamp: doc.timestamp || version.timestamp,
      hash: stringHash(prevItems.map(i => i.text || '').join(' ')),
      items: prevItems,
      centroid: doc.centroid || computeCentroid(prevItems) || undefined,
      summary: doc.summary || ''
    }];
    doc.latestVersionIndex = 0;
  }
  const latest = doc.versions[doc.latestVersionIndex];
  if (latest && latest.hash === version.hash) {
    // No content change; bump timestamp
    latest.timestamp = Math.max(latest.timestamp || 0, version.timestamp || 0);
  } else {
    let similar = false;
    const latestCentroid = latest?.centroid || (latest?.items ? computeCentroid(latest.items) : null);
    if (latestCentroid && version.centroid) {
      try { similar = cosineSimilarity(version.centroid, latestCentroid) >= similarityThreshold; } catch (_) { similar = false; }
    }
    if (similar) {
      doc.versions[doc.latestVersionIndex] = version;
    } else {
      doc.versions.push(version);
      doc.latestVersionIndex = doc.versions.length - 1;
      const maxN = Math.max(1, maxVersions || 3);
      if (doc.versions.length > maxN) {
        const drop = doc.versions.length - maxN;
        doc.versions.splice(0, drop);
        doc.latestVersionIndex = doc.versions.length - 1;
      }
    }
  }
  // Sync top-level fields
  doc.canonicalUrl = canUrl;
  doc.url = url;
  doc.title = title;
  const cur = doc.versions[doc.latestVersionIndex];
  doc.timestamp = cur.timestamp;
  doc.items = cur.items;
  doc.centroid = cur.centroid;
  doc.summary = cur.summary || '';
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(doc);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// normalizeText moved to text.js

/**
 * Canonicalize a URL by removing fragments, stripping common tracking params
 * and sorting remaining query params.
 * @param {string} url
 * @returns {string}
 */
function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const params = u.searchParams;
    const stripPrefixes = ['utm_', 'vero_', 'ga_', 'mc_', 'sb_'];
    const stripNames = new Set([
      'gclid', 'fbclid', 'ref', 'ref_src', 'ref_url', '_hsmi', '_hsenc',
      'mkt_tok', 'spm', 'igshid', 's', 'si', 'si_source', 'si_platform'
    ]);
    // Collect remaining params
    const keep = [];
    for (const [k, v] of params.entries()) {
      const lower = k.toLowerCase();
      if (stripNames.has(lower)) continue;
      if (stripPrefixes.some(p => lower.startsWith(p))) continue;
      keep.push([k, v]);
    }
    // Sort by key for stability
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    // Rebuild
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);
    return u.toString();
  } catch (_) {
    return url;
  }
}

/**
 * Lookup a document by canonicalUrl using an index if available; falls back
 * to scanning all pages and comparing canonicalized URLs.
 * @param {string} canUrl
 * @returns {Promise<object|null>}
 */
async function getByCanonicalUrl(canUrl) {
  const db = await openDB();
  // Try index first
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('canonicalUrl');
    const req = idx.get(canUrl);
    const res = await new Promise((resolve) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (res) return res;
  } catch (_) { /* index may not exist yet */ }
  // Fallback scan
  try {
    const all = await getAllPages();
    for (const p of all) {
      if (p.canonicalUrl && p.canonicalUrl === canUrl) return p;
    }
    for (const p of all) {
      try {
        const cand = canonicalizeUrl(p.url);
        if (cand === canUrl) return p;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

/**
 * Process a newly visited page: compute embeddings for each provided chunk and
 * store the record in IndexedDB. Chunking is authoritative in content.js; the
 * background assumes chunks are already sized appropriately.
 *
 * @param {object} message The message received from the content script.
 */
async function processAndStore(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Invalid message payload');
  }
  const { url, title, timestamp, chunks, text } = message;
  if (!url) {
    throw new Error('Missing url in message');
  }
  const normalizedText = normalizeText(text || '');
  const chunksArr = Array.isArray(chunks) && chunks.length > 0
    ? chunks.filter(c => typeof c === 'string' && c.trim().length > 0)
    : (normalizedText ? [normalizedText] : []);
  const contentHash = stringHash(normalizedText);
  const canUrl = canonicalizeUrl(url);
  let __stage = 'start';
  try {
    LOGGER.info('process start', { url, title, chunks: chunksArr.length });
    // track processing state for UI
    try { await addProcessingPage({ url, title, timestamp, status: 'processing', attempts: 0 }); } catch (_) {}
    __stage = 'after_add';
    // Versioning settings (always enabled)
    const { versioningMaxVersions, versioningSimilarityThreshold } = await getSettings();
    __stage = 'after_settings';
    // Try to find an existing document by canonical URL
    let doc = await getByCanonicalUrl(canUrl);
    __stage = 'after_lookup';

    // If exact same content as latest version, just bump timestamps and metadata.
    if (doc && Array.isArray(doc.versions) && typeof doc.latestVersionIndex === 'number') {
      const latest = doc.versions[doc.latestVersionIndex] || doc.versions[doc.versions.length - 1];
      if (latest && latest.hash === contentHash) {
        latest.timestamp = timestamp;
        doc.timestamp = timestamp; // keep top-level timestamp in sync
        doc.title = title || doc.title;
        doc.url = url || doc.url;
        // Persist
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(doc);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        try { await removePendingCapture(url); } catch (_) {}
        try { await removeProcessingPage(url); } catch (_) {}
        try { chrome.runtime.sendMessage({ type: 'PAGE_CAPTURED', url, title, timestamp }); } catch (_) {}
        try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_INVALIDATE_INDEX' }); } catch (_) {}
        LOGGER.info('process updated timestamp only (no content change)', { url });
        return;
      }
    }

    // Compute embeddings for current chunks; needed to decide update vs new version.
    let items = [];
    try {
      __stage = 'before_embed_batch';
      const embeddings = await withRetry(() => computeEmbeddingsBatch(chunksArr), { retries: 2, delayMs: 1000 });
      for (let i = 0; i < chunksArr.length; i++) {
        if (embeddings[i]) items.push({ text: chunksArr[i], embedding: embeddings[i] });
      }
      __stage = 'after_embed_batch';
    } catch (err) {
      LOGGER.warn('batch embeddings failed, fallback per-chunk', { error: String(err), url });
      items = [];
      for (const chunk of chunksArr) {
        try {
          __stage = 'before_embed_single';
          const embedding = await withRetry(() => computeEmbedding(chunk), { retries: 2, delayMs: 800 });
          items.push({ text: chunk, embedding });
        } catch (e) {
          LOGGER.error('embed chunk failed', { error: String(e) });
        }
      }
      __stage = 'after_embed_single';
    }
    LOGGER.debug('embeddings complete', { count: items.length });

    // Build new version payload
    const newVersion = {
      timestamp,
      hash: contentHash,
      items,
      centroid: computeCentroid(items) || undefined,
      summary: ''
    };
    if (text) {
      try {
        __stage = 'before_summary';
        const sum = await withRetry(() => computeSummary(text), { retries: 1, delayMs: 1200 });
        if (sum && sum.length > 0) newVersion.summary = sum;
      } catch (err) {
        LOGGER.warn('summary failed for page', { error: String(err) });
      }
    }

    const db = await openDB();
    {
      // Versioned path
      if (!doc) {
        // Create a new document with versions=[v0]
        const rec = {
          canonicalUrl: canUrl,
          url,
          title,
          timestamp,
          latestVersionIndex: 0,
          versions: [newVersion],
          // Keep top-level for compatibility with search until full refactor
          items: items,
          centroid: newVersion.centroid,
          summary: newVersion.summary,
        };
        __stage = 'db_add_new';
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).add(rec);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } else {
        // Decide update latest vs append (handle legacy docs without versions)
        if (!Array.isArray(doc.versions) || typeof doc.latestVersionIndex !== 'number') {
          const prevItems = Array.isArray(doc.items) ? doc.items : [];
          doc.versions = [{
            timestamp: doc.timestamp || timestamp,
            hash: stringHash(prevItems.map(i => i.text || '').join(' ')),
            items: prevItems,
            centroid: doc.centroid || computeCentroid(prevItems) || undefined,
            summary: doc.summary || ''
          }];
          doc.latestVersionIndex = 0;
        }
        const latest = doc.versions[doc.latestVersionIndex];
        const latestCentroid = latest.centroid || computeCentroid(latest.items) || [];
        const newCentroid = newVersion.centroid || [];
        let similar = false;
        if (latestCentroid.length && newCentroid.length) {
          try { similar = cosineSimilarity(newCentroid, latestCentroid) >= versioningSimilarityThreshold; } catch (_) { similar = false; }
        }
        if (similar) {
          // Overwrite latest version
          doc.versions[doc.latestVersionIndex] = newVersion;
        } else {
          // Append and enforce LRU
          doc.versions.push(newVersion);
          doc.latestVersionIndex = doc.versions.length - 1;
          const maxN = Math.max(1, versioningMaxVersions || 3);
          if (doc.versions.length > maxN) {
            // Drop from the front
            const drop = doc.versions.length - maxN;
            doc.versions.splice(0, drop);
            doc.latestVersionIndex = doc.versions.length - 1;
          }
        }
        // Sync top-level fields for compatibility
        doc.canonicalUrl = canUrl;
        doc.url = url;
        doc.title = title;
        doc.timestamp = timestamp;
        doc.items = newVersion.items;
        doc.centroid = newVersion.centroid;
        doc.summary = newVersion.summary;
        __stage = 'db_update_existing';
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(doc);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
    }
    try { await removePendingCapture(url); } catch (_) {}
    try { await removeProcessingPage(url); } catch (_) {}
    try { chrome.runtime.sendMessage({ type: 'PAGE_CAPTURED', url, title, timestamp }); } catch (_) {}
    try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_INVALIDATE_INDEX' }); } catch (_) {}
    try { await removeHighlightCache(formatLocalYMD(timestamp)); } catch (_) {}
    LOGGER.info('process saved new', { url });
  } catch (err) {
    try {
      const stack = err && err.stack ? String(err.stack) : undefined;
      LOGGER.error('processAndStore failed', { error: String(err), stack, url, stage: __stage });
    } catch (_) {
      LOGGER.error('processAndStore failed', { error: String(err), url, stage: __stage });
    }
    // increment attempts and possibly retry
    const list = await getProcessingPages();
    const entry = list.find(p => p.url === url) || { attempts: 0 };
    const attempts = (entry.attempts || 0) + 1;
    await updateProcessingPage(url, { status: 'error', attempts });
    if (attempts <= 3) {
      const backoff = 1000 * Math.pow(2, attempts - 1);
      LOGGER.info('scheduling retry', { url, attempts, backoff });
      setTimeout(() => {
        updateProcessingPage(url, { status: 'retrying' }).then(() => enqueueProcess(message));
      }, backoff);
    } else {
      LOGGER.error('giving up after retries', { url, attempts });
      try { await removeProcessingPage(url); } catch (_) {}
      try { await removePendingCapture(url); } catch (_) {}
    }
  }
}

/**
 * Generate semantic variations for a given query.  We leverage the configured
 * chat model to rewrite the query into multiple equivalent forms, which can
 * boost recall when computing embeddings.  If no chat model is set or the
 * rewrite fails, the original query is returned as a single‑element array.
 *
 * @param {string} query The original user query.
 * @param {number} n The number of variations to request.
 * @returns {Promise<string[]>} Array of queries.
 */
async function generateQueryVariations(query, n = 3) {
  // Always include the original query.
  const variations = [query];
  // Respect settings: allow disabling query rewriting.
  try {
    const { queryRewrite } = await getSettings();
    if (!queryRewrite) {
      return variations;
    }
  } catch (_) {}
  // Use the chat model to rewrite queries.  If no chat model is configured
  // or the API call fails, return just the original query.
  const { chatModel } = await getModelSettings();
  if (!chatModel) {
    return variations;
  }
  try {
    const body = {
      model: chatModel,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that rewrites search queries into semantically similar variations. You must only return the requested number of distinct queries, each on its own line.'
        },
        {
          role: 'user',
          content: `Rewrite the following search query into ${n} semantically similar queries. List each on a separate line without numbering.\n\nQuery: ${query}`
        }
      ],
      stream: false
    };
    const base = await getOllamaBase();
    const resp = await logFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { kind: 'chat_rewrite' });
    if (!resp.ok) {
      return variations;
    }
    const json = await resp.json();
    const content = (json && json.message && json.message.content) ? json.message.content.trim() : '';
    if (!content) {
      return variations;
    }
    // Split lines, filter empty and duplicates.
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line && !variations.includes(line)) {
        variations.push(line);
        if (variations.length >= n + 1) break;
      }
    }
  } catch (err) {
    console.error('Failed to rewrite query:', err);
  }
  return variations;
}


/**
 * Heuristic filter to drop low-information nav/toolbox snippets.
 * @param {string} text
 * @returns {boolean} true if text looks like nav/toolbox/too short
 */
function isLowInformation(text) {
  if (!text) return true;
  const t = text.trim();
  // Relax thresholds: allow shorter but still meaningful snippets
  if (t.length < 80) return true;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const letterRatio = letters / t.length;
  if (letterRatio < 0.4) return true;
  const tokens = t.split(/\s+/).filter(Boolean);
  const avgLen = tokens.reduce((s, w) => s + w.length, 0) / Math.max(1, tokens.length);
  if (avgLen < 3.0) return true;
  return false;
}

/**
 * Re‑rank a set of search results using a cross‑encoder implemented via the
 * configured chat model.  For each candidate, we ask the model to rate the
 * relevance of the passage to the query on a scale of 1–10.  The numeric
 * score returned by the model is used to sort the results.  If no chat
 * model is configured or the call fails, the original ordering is returned.
 *
 * @param {string} query The user’s search query.
 * @param {object[]} candidates List of result objects with `snippet` property.
 * @returns {Promise<object[]>} Candidates with an added `crossScore` and sorted.
 */
async function reRankWithCrossEncoder(query, candidates) {
  // Respect settings: allow disabling cross-encoder re-ranking.
  try {
    const { crossEncoder } = await getSettings();
    if (!crossEncoder) {
      return candidates;
    }
  } catch (_) {}
  const { chatModel } = await getModelSettings();
  if (!chatModel) {
    return candidates;
  }
  // Try batched re-ranking in one prompt returning a JSON array of numbers
  let ranked = candidates.slice();
  try {
    const list = candidates.map((c, i) => ({ index: i + 1, text: c.snippet }));
    const body = {
      model: chatModel,
      messages: [
        {
          role: 'system',
          content: 'You are a cross-encoder that rates each passage for relevance to a query from 0 to 10. Respond ONLY with a JSON array of numbers matching the order of the provided passages.'
        },
        {
          role: 'user',
          content: `Query: ${query}\nPassages (JSON):\n${JSON.stringify(list)}\n\nRespond with JSON array of numbers, e.g. [7.5, 3, 9]`
        }
      ],
      stream: false
    };
    const base = await getOllamaBase();
    const resp = await logFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { kind: 'chat_rerank_batch' });
    if (resp.ok) {
      const json = await resp.json();
      const content = (json && json.message && json.message.content) ? json.message.content.trim() : '';
      let scores = [];
      try { scores = JSON.parse(content); } catch (_) { scores = []; }
      if (Array.isArray(scores) && scores.length === candidates.length) {
        for (let i = 0; i < candidates.length; i++) {
          const v = parseFloat(scores[i]);
          if (!isNaN(v)) candidates[i].crossScore = v; else candidates[i].crossScore = 0;
        }
      } else {
        // Fallback to per-candidate parallel scoring
        await Promise.all(candidates.map(async (cand) => {
          let score = 0;
          try {
            const single = {
              model: chatModel,
              messages: [
                { role: 'system', content: 'You are a cross‑encoder that assesses the relevance of a text passage to a search query. Respond with a single number between 0 and 10, where higher means more relevant. Respond only with the number.' },
                { role: 'user', content: `Query: ${query}\nText: ${cand.snippet}\n\nRelevance score:` }
              ],
              stream: false
            };
            const r = await logFetch(`${base}/api/chat`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(single)
            }, { kind: 'chat_rerank' });
            if (r.ok) {
              const j = await r.json();
              const ctt = (j && j.message && j.message.content) ? j.message.content.trim() : '';
              const num = parseFloat(ctt); if (!isNaN(num)) score = num;
            }
          } catch (_) {}
          cand.crossScore = score;
        }));
      }
    }
    ranked = candidates.slice();
  } catch (err) {
    // If batching totally fails, return original ordering
    ranked = candidates.slice();
  }
  // Sort by crossScore descending, with a tiebreaker on original score
  ranked.sort((a, b) => {
    if (b.crossScore !== a.crossScore) {
      return b.crossScore - a.crossScore;
    }
    // Fallback to original weighted score
    return (b.weightedScore || b.score) - (a.weightedScore || a.score);
  });
  return ranked;
}

/**
 * Decompose a complex question into simpler sub‑queries to improve recall in
 * multi‑step retrieval.  We ask the chat model to break down the question
 * into separate search prompts, each on its own line.  If decomposition
 * fails, we return the original question as the only element.
 *
 * @param {string} question The user’s question.
 * @returns {Promise<string[]>} An array of sub‑queries.
 */
async function decomposeQuestion(question) {
  const subs = [question];
  const { chatModel } = await getModelSettings();
  if (!chatModel) {
    return subs;
  }
  try {
    const body = {
      model: chatModel,
      messages: [
        {
          role: 'system',
          content: 'You are an assistant that breaks complex questions into independent search queries for information retrieval. Return each sub‑query on a separate line and do not include any numbering or explanation.'
        },
        {
          role: 'user',
          content: `Break the following question into multiple search queries:\n\n${question}`
        }
      ],
      stream: false
    };
    const base = await getOllamaBase();
    const resp = await logFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { kind: 'chat_decompose' });
    if (!resp.ok) {
      return subs;
    }
    const json = await resp.json();
    const content = (json && json.message && json.message.content) ? json.message.content.trim() : '';
    if (!content) {
      return subs;
    }
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line && !subs.includes(line)) {
        subs.push(line);
      }
    }
  } catch (err) {
    console.error('Question decomposition failed:', err);
  }
  return subs;
}

/**
 * Search previously saved pages using a semantic query with advanced
 * enhancements: query rewriting, recency weighting and cross‑encoder
 * re‑ranking.  The function first generates query variations, computes
 * embeddings for each, aggregates scores for all stored chunks, applies a
 * recency weight, selects the top candidates, then optionally re‑ranks
 * them using a cross‑encoder.  The final list is truncated to `limit`.
 *
 * @param {string} query The user query.
 * @param {number} limit The maximum number of results to return.
 * @returns {Promise<object[]>} Array of result objects.
 */
async function searchMemory(query, limit = 10) {
  try { await LOGGER.debug('search start', { query, limit }); } catch (_) {}
  // Generate semantic variations of the query to improve recall.
  const variations = await generateQueryVariations(query, 3);
  // Batch embed variations for speed.
  const batched = await computeEmbeddingsBatch(variations);
  LOGGER.debug('search variations embedded', { count: batched.length });
  const variationEmbeddings = [];
  for (let i = 0; i < variations.length; i++) {
    if (batched[i]) variationEmbeddings.push({ query: variations[i], embedding: batched[i] });
  }
  if (variationEmbeddings.length === 0) {
    // If embeddings are empty, it may be due to offline models
    try {
      const online = await checkModelsOnline();
      if (!online) {
        throw new Error('Models are offline or unreachable. Start Ollama or update the base URL.');
      }
    } catch (e) {
      // Re-throw to allow UI to surface a clear message
      throw e;
    }
    return [];
  }
  // Two-stage retrieval using offscreen ANN helper for background ranking
  await ensureOffscreenDocument();
  // Stage 1: get top pages by centroid similarity
  const topPageResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_TOP_PAGES',
      variationEmbeddings: variationEmbeddings.map(v => v.embedding),
      topN: 30
    }, resolve);
  });
  let topPageIds = (topPageResp && Array.isArray(topPageResp.pages)) ? topPageResp.pages.map(p => p.id) : [];
  LOGGER.debug('search top pages', { count: topPageIds.length });
  // Augment with pages whose titles contain the original query tokens (exact text presence)
  try {
    const q = (query || '').toLowerCase().trim();
    const tokens = q.split(/\W+/).filter(t => t.length >= 3);
    if (tokens.length > 0) {
      const pages = await getAllPages();
      const matchIds = [];
      for (const p of pages) {
        const t = (p.title || '').toLowerCase();
        if (tokens.some(tok => t.includes(tok))) {
          matchIds.push(p.id);
        }
      }
      if (matchIds.length > 0) {
        const set = new Set(topPageIds);
        for (const id of matchIds) set.add(id);
        topPageIds = Array.from(set);
      }
    }
  } catch (_) {}
  // Stage 2: score chunks only within those pages in offscreen context
  const chunkResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_SCORE_CHUNKS',
      pageIds: topPageIds,
      variationEmbeddings: variationEmbeddings.map(v => v.embedding),
      originalQuery: query
    }, resolve);
  });
  const scores = (chunkResp && Array.isArray(chunkResp.candidates)) ? chunkResp.candidates : [];
  LOGGER.debug('search candidate chunks', { count: scores.length });
  // Sort by weighted score descending.
  scores.sort((a, b) => b.weightedScore - a.weightedScore);
  // Take a subset of top candidates for cross‑encoder re‑ranking.  We oversample by 2x.
  const topCandidates = scores.slice(0, Math.min(limit * 2, scores.length));
  // Perform cross‑encoder re‑ranking on the top candidates.
  const reRanked = await reRankWithCrossEncoder(query, topCandidates);
  const { wSim, wLLM } = await getCalibration();
  // Attach metrics: similarityPct, llmRankPct, calibrated
  const withMetrics = reRanked.map(c => {
    const hasCross = typeof c.crossScore === 'number' && !isNaN(c.crossScore);
    const simPct = typeof c.score === 'number' ? Math.max(0, Math.min(100, Math.round(((c.score + 1) / 2) * 100))) : undefined;
    const llmRankPct = hasCross ? Math.max(0, Math.min(100, Math.round(c.crossScore * 10))) : undefined;
    let calibrated;
    if (simPct !== undefined && llmRankPct !== undefined) {
      calibrated = Math.round(wSim * simPct + wLLM * llmRankPct);
    } else if (simPct !== undefined) {
      calibrated = simPct;
    } else if (llmRankPct !== undefined) {
      calibrated = llmRankPct;
    }
    // Attach canonicalUrl to enable UI collapses; compute from URL
    let can = '';
    try { can = canonicalizeUrl(c.url); } catch (_) { can = c.url; }
    return { ...c, similarityPct: simPct, llmRankPct, calibrated, canonicalUrl: can };
  });
  // Return the first `limit` results after re‑ranking.
  const out = withMetrics.slice(0, limit);
  LOGGER.info('search done', { returned: out.length });
  return out;
}

// Quick search without cross-encoder reranking, used for partial results on timeout
async function quickSearchMemory(query, limit = 5) {
  const variations = await generateQueryVariations(query, 3);
  const batched = await computeEmbeddingsBatch(variations);
  const variationEmbeddings = [];
  for (let i = 0; i < variations.length; i++) {
    if (batched[i]) variationEmbeddings.push({ query: variations[i], embedding: batched[i] });
  }
  if (variationEmbeddings.length === 0) {
    try {
      const online = await checkModelsOnline();
      if (!online) throw new Error('Models are offline or unreachable. Start Ollama or update the base URL.');
    } catch (e) {
      throw e;
    }
    return [];
  }
  await ensureOffscreenDocument();
  const topPageResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_TOP_PAGES', variationEmbeddings: variationEmbeddings.map(v => v.embedding), topN: 30 }, resolve);
  });
  let topPageIds = (topPageResp && Array.isArray(topPageResp.pages)) ? topPageResp.pages.map(p => p.id) : [];
  try {
    const q = (query || '').toLowerCase().trim();
    const tokens = q.split(/\W+/).filter(t => t.length >= 3);
    if (tokens.length > 0) {
      const pages = await getAllPages();
      const matchIds = [];
      for (const p of pages) {
        const t = (p.title || '').toLowerCase();
        if (tokens.some(tok => t.includes(tok))) matchIds.push(p.id);
      }
      if (matchIds.length) {
        const set = new Set(topPageIds);
        for (const id of matchIds) set.add(id);
        topPageIds = Array.from(set);
      }
    }
  } catch (_) {}
  const chunkResp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_SCORE_CHUNKS', pageIds: topPageIds, variationEmbeddings: variationEmbeddings.map(v => v.embedding), originalQuery: query }, resolve);
  });
  const scores = (chunkResp && Array.isArray(chunkResp.candidates)) ? chunkResp.candidates : [];
  scores.sort((a, b) => b.weightedScore - a.weightedScore);
  const top = scores.slice(0, Math.min(limit, scores.length));
  return top.map(h => ({ title: h.title, url: h.url, snippet: h.snippet, chunkIndex: h.chunkIndex }));
}

/**
 * Answer a natural language question using retrieval‑augmented generation (RAG).
 * The pipeline performs semantic search over stored pages to find relevant
 * passages and then calls a generative model via the Ollama API to
 * synthesise an answer.  If no model is configured or no context is found,
 * an informative message is returned.
 *
 * @param {string} question The user’s question.
 * @returns {Promise<string>} The generated answer or a fallback message.
 */
async function askQuestion(question) {
  // Retrieve model settings.
  const { chatModel } = await getModelSettings();
  const { answerMode } = await getSettings();
  // If Ollama is offline, return a clear message instead of generic no-results.
  try {
    const online = await checkModelsOnline();
    if (!online) {
      return { answer: 'Models are offline or unreachable. Please start Ollama (or update the base URL in settings) and try again.', sources: [], explanations: [] };
    }
  } catch (_) {}
  // We prefer a chat model for final synthesis, but can fall back if missing.
  // Decompose the question into potential sub‑queries to improve retrieval.
  let subQueries;
  try {
    try { chrome.runtime.sendMessage({ type: 'ASK_PROGRESS', message: 'Analyzing question' }); } catch (_) {}
    subQueries = await decomposeQuestion(question);
  } catch (err) {
    console.error('Failed to decompose question:', err);
    subQueries = [question];
  }
  // Use a map to de‑duplicate hits across sub‑queries.  Key by URL and snippet.
  const hitMap = new Map();
  for (const sub of subQueries) {
    try {
      try { chrome.runtime.sendMessage({ type: 'ASK_PROGRESS', message: `Searching memory: ${sub}` }); } catch (_) {}
      const t0 = Date.now();
      const hits = await searchMemory(sub, 5);
      const ms = Date.now() - t0;
      try {
        const exact = hits.filter(h => !!h.containsExact).length;
        const secs = (ms / 1000).toFixed(ms >= 10000 ? 0 : (ms >= 1000 ? 1 : 0));
        chrome.runtime.sendMessage({ type: 'ASK_PROGRESS', message: `\u2713 Searching memory: ${sub} — ${hits.length} hits${exact ? ` (${exact} exact)` : ''} — took ${secs}${ms>=1000?'s':'ms'}` });
      } catch (_) {}
      for (const hit of hits) {
        const key = `${hit.url}::${hit.snippet}`;
        if (!hitMap.has(key)) {
          hitMap.set(key, hit);
        } else {
          // If the hit already exists, keep the highest score.
          const existing = hitMap.get(key);
          if ((hit.crossScore || hit.weightedScore || hit.score) > (existing.crossScore || existing.weightedScore || existing.score)) {
            hitMap.set(key, hit);
          }
        }
      }
    } catch (err) {
      console.error('Search error in multi‑step retrieval:', err);
    }
  }
  const hitsArray = Array.from(hitMap.values());
  if (hitsArray.length === 0) {
    return 'No relevant context found.';
  }
  // Sort combined hits by crossScore/weightedScore.
  hitsArray.sort((a, b) => {
    const scoreA = a.crossScore !== undefined ? a.crossScore : (a.weightedScore || a.score);
    const scoreB = b.crossScore !== undefined ? b.crossScore : (b.weightedScore || b.score);
    return scoreB - scoreA;
  });
  // Filter nav/toolbox snippets and keep those that contain query terms.
  const stopwords = new Set(['what','did','how','the','a','an','in','on','to','is','are','was','were','and','or','of','about','say','who','why','when','where']);
  const queryTokens = question.toLowerCase().split(/\W+/).filter(t => t && !stopwords.has(t));
  // Avoid aggressive filtering here; keep all hits and use boosts instead
  let filteredHits = hitsArray.slice();
  if (queryTokens.length) {
    const containsToken = (sn) => queryTokens.some(tok => sn.includes(tok));
    filteredHits = filteredHits
      .map(h => ({ ...h, __tok: containsToken((h.snippet || '').toLowerCase()) ? 1 : 0 }))
      .sort((a, b) => {
        if (b.__tok !== a.__tok) return b.__tok - a.__tok;
        const sa = a.crossScore !== undefined ? a.crossScore : (a.weightedScore || a.score);
        const sb = b.crossScore !== undefined ? b.crossScore : (b.weightedScore || b.score);
        return sb - sa;
      })
      .map(({ __tok, ...rest }) => rest);
  }
  const { askTopConcise, askTopDetailed } = await getSettings();
  const topHits = filteredHits.slice(0, answerMode === 'detailed' ? Math.max(1, askTopDetailed) : Math.max(1, askTopConcise));

  // If we have a chat model, synthesise a focused answer using compact context.
  if (chatModel && topHits.length > 0) {
    // Build compact context blocks from top hits
    const contextPieces = [];
    for (let i = 0; i < topHits.length; i++) {
      const hit = topHits[i];
      let domain = '';
      try { domain = new URL(hit.url).hostname; } catch (_) { domain = ''; }
      const title = hit.title || hit.url;
      // Compact context: prefer stored summary, then a small window around focus chunk, else snippet
      let summary = '';
      let windowText = '';
      let chunkText = '';
      try {
        const pages = await getAllPages();
        const page = pages.find(p => p.url === hit.url);
        summary = (page && page.summary) ? page.summary : '';
        if (page && typeof hit.chunkIndex === 'number') {
          const idx = hit.chunkIndex|0;
          const items = Array.isArray(page.items) ? page.items : (Array.isArray(page.versions) && page.versions.length ? (page.versions[page.versions.length - 1].items || []) : []);
          const from = Math.max(0, idx - 1);
          const to = Math.min(items.length - 1, idx + 1);
          const slices = [];
          for (let j = from; j <= to; j++) {
            const label = (j === idx) ? 'Focus' : (j < idx ? 'Prev' : 'Next');
            const txt = String(items[j]?.text || '');
            if (txt) slices.push(`${label} chunk [${j}]: ${txt}`);
          }
          windowText = slices.join('\n');
          if (!windowText && items[idx]?.text) chunkText = String(items[idx].text);
        }
      } catch (_) {}
      const { answerMode, askCtxConcise, askCtxDetailed } = await getSettings();
      const capTotal = answerMode === 'detailed' ? askCtxDetailed : askCtxConcise;
      const perBlockCap = Math.max(400, Math.floor((capTotal || 1200) / Math.max(1, topHits.length)));
      const parts = [];
      if (summary) parts.push(`Summary: ${summary.slice(0, Math.max(200, Math.floor(perBlockCap/3)))}`);
      if (windowText) parts.push(windowText);
      else if (chunkText) parts.push(`Chunk: ${chunkText}`);
      else parts.push(`Snippet: ${hit.snippet}`);
      const block = parts.join('\n');
      contextPieces.push(`[${i+1}] Title: ${title}${domain ? ` (domain: ${domain})` : ''}\n${block.slice(0, perBlockCap)}`);
    }
    const contextBlocks = contextPieces.join('\n\n');

    // ---- Pass 1: Extract bullet-point facts with citations, tools allowed (auto) ----
    const extractSys = `You extract grounded facts from provided context.
Rules:
- Use only information from context or allowed tools.
- Output concise bullet points. End each bullet with a citation [n] referencing the numbered sources.
- If coverage is weak, keep bullets minimal.
- After bullets, add a line: Coverage: low|medium|high.
- Do not include titles/URLs in the bullets; use [n] only.`;
    const extractUser = `Question: ${question}\n\nContext:\n${contextBlocks}\n\nWrite bullet points with [n] citations, then a single line 'Coverage: <level>'.`;

    let usedToolUrls = [];
    let extracted = '';
    try {
      const base = await getOllamaBase();
      const extractBody = { model: chatModel, messages: [ { role: 'system', content: extractSys }, { role: 'user', content: extractUser } ], stream: false };
      // Attach tools if enabled
      try {
        const { enableTools } = await getSettings();
        if (enableTools) {
          extractBody.tools = [
            { type: 'function', function: { name: 'fetch_more', description: 'Fetch more text from a stored page. Prefer chunkIndex; otherwise provide a small start/end range.', parameters: { type: 'object', properties: { url: { type: 'string' }, chunkIndex: { type: 'integer' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['url'] } } },
            { type: 'function', function: { name: 'get_page_summary', description: 'Get the stored summary for a page URL', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
            { type: 'function', function: { name: 'search_memory', description: 'Search local memory for a query and return top k results', parameters: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'integer' } }, required: ['query'] } } }
          ];
          extractBody.tool_choice = 'auto';
        }
      } catch (_) {}
      try { chrome.runtime.sendMessage({ type: 'ASK_PROGRESS', message: 'Extracting facts' }); } catch (_) {}
      let resp = await logFetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...extractBody, options: { temperature: 0.2 } }) }, { kind: 'chat_ask_extract' });
      if (resp.ok) {
        let json = await resp.json();
        // Optional tool loop (cap at small number)
        try {
          const { enableTools, maxToolSteps, toolTimeoutMs } = await getSettings();
          if (enableTools && json && json.message && Array.isArray(json.message.tool_calls) && json.message.tool_calls.length > 0) {
            let messages = extractBody.messages.slice();
            messages.push({ role: 'assistant', content: json.message.content || '', tool_calls: json.message.tool_calls });
            let steps = 0;
            const pages = await getAllPages();
            const allowed = new Set(pages.map(p => p.url));
            const pageText = new Map();
            for (const p of pages) pageText.set(p.url, (p.items || []).map(it => it.text || '').join(' '));
            const runtime = new ToolsRuntime({ allowedUrls: allowed, pageText, pages, searchMemory, quickSearchMemory, toolTimeoutMs });
            const stepCap = Math.max(0, Math.min((maxToolSteps || 2), 2));
            while (steps < stepCap) {
              steps++;
              for (const tc of (json.message.tool_calls || [])) {
                const name = tc.function?.name;
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (_) {}
                try { chrome.runtime.sendMessage({ type: 'ASK_PROGRESS', message: `Tool: ${name}` }); } catch (_) {}
                const res = await runtime.runToolCall(name, args);
                messages.push({ role: 'tool', name, content: String(res.content || '') });
              }
              // Follow-up: ask for updated bullets only
              messages.push({ role: 'user', content: 'Update the bullet points based on the tool results. Keep the same format and citations.' });
              resp = await logFetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: chatModel, messages, stream: false, options: { temperature: 0.2 } }) }, { kind: 'chat_ask_extract_tools' });
              if (!resp.ok) break;
              const j2 = await resp.json();
              if (j2 && j2.message && Array.isArray(j2.message.tool_calls) && j2.message.tool_calls.length > 0) {
                json = j2;
                messages.push({ role: 'assistant', content: j2.message.content || '', tool_calls: j2.message.tool_calls });
                continue;
              } else {
                json = j2;
                break;
              }
            }
            try {
              await LOGGER.info('tool metrics', { metrics: runtime.metrics });
              chrome.runtime.sendMessage({ type: 'ASK_TOOL_METRICS', metrics: runtime.metrics });
              usedToolUrls = Array.isArray(runtime.usedUrlOrder) ? runtime.usedUrlOrder.slice() : [];
            } catch (_) {}
          }
        } catch (_) {}
        extracted = (json && json.message && json.message.content) ? String(json.message.content).trim() : '';
      }
    } catch (err) {
      console.error('ASK extract failed:', err);
    }

    // Normalize citations format
    if (extracted) extracted = extracted.replace(/[\u3010](\d+)[\u3011]/g, '[$1]');
    // Fallback if extraction failed
    if (!extracted) extracted = topHits.map((hit, i) => `- ${hit.snippet} [${i+1}]`).join('\n');

    // ---- Pass 2: Compose final answer from extracted bullets (no tools) ----
    const { answerMode } = await getSettings();
    const style = answerMode === 'detailed' ? 'detailed (6–10 sentences)' : 'concise (2–4 sentences)';
    const composeSys = `You compose an answer strictly from provided bullet points with citations.
Rules:
- Use only the provided bullets; do not invent new facts.
- Keep inline citations as [n] and ensure every claim has at least one citation.
- If bullets are insufficient, say so briefly and include Sources.
- Be ${style}.`;
    const composeUser = `Question: ${question}\n\nBullets:\n${extracted}\n\nWrite the final answer using [n] citations. Do not add new facts.`;
    let finalContent = '';
    try {
      const base = await getOllamaBase();
      const comp = await logFetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: chatModel, messages: [ { role: 'system', content: composeSys }, { role: 'user', content: composeUser } ], stream: false, options: { temperature: 0.2 } }) }, { kind: 'chat_ask_compose' });
      if (comp.ok) {
        const j = await comp.json();
        finalContent = (j && j.message && j.message.content) ? j.message.content.trim() : '';
      }
    } catch (err) {
      console.error('ASK compose failed:', err);
    }

    // Build sources list and return
    let content = finalContent || '';
    content = content.replace(/[\u3010](\d+)[\u3011]/g, '[$1]');
    const sourcesArr = topHits.map((hit, i) => {
      let domain = '';
      try { domain = new URL(hit.url).hostname; } catch (_) { domain = ''; }
      return { index: i+1, title: hit.title || hit.url, url: hit.url, domain };
    });
    try {
      const existing = new Set(sourcesArr.map(s => s.url));
      const extras = (usedToolUrls || []).filter(u => u && !existing.has(u));
      if (extras.length > 0) {
        const pages = await getAllPages();
        for (const u of extras) {
          const page = pages.find(p => p.url === u);
          let domain = '';
          try { domain = new URL(u).hostname; } catch (_) { domain = ''; }
          sourcesArr.push({ index: sourcesArr.length + 1, title: (page && page.title) ? page.title : u, url: u, domain });
        }
      }
    } catch (_) {}
    const explanations = topHits.map((hit, i) => ({ index: i+1, title: hit.title || hit.url, url: hit.url, score: hit.score, weightedScore: hit.weightedScore, crossScore: hit.crossScore, snippet: hit.snippet }));
    const hasSources = /\bSources\b/i.test(content);
    if (!hasSources) {
      const sourcesText = sourcesArr.map(s => `[${s.index}] ${s.title}${s.domain ? ` (${s.domain})` : ''} — ${s.url}`).join('\n');
      const answer = `${content}\n\nSources:\n${sourcesText}`;
      return { answer, sources: sourcesArr, explanations };
    }
    return { answer: content, sources: sourcesArr, explanations };
  }

  // Fallback: present top snippets (body uses [n] only; titles/URLs go in Sources below).
  const bullets = topHits.map((hit, i) => {
    return `[${i+1}] ${hit.snippet}`;
  });
  const sourcesArr = topHits.map((hit, i) => {
    let domain = '';
    try { domain = new URL(hit.url).hostname; } catch (_) { domain = ''; }
    return { index: i+1, title: hit.title || hit.url, url: hit.url, domain };
  });
  const explanations = topHits.map((hit, i) => ({
    index: i+1,
    title: hit.title || hit.url,
    url: hit.url,
    score: hit.score,
    weightedScore: hit.weightedScore,
    crossScore: hit.crossScore,
    snippet: hit.snippet
  }));
  const bulletsText = bullets.join('\n\n');
  const sourcesText = sourcesArr
    .map(s => `[${s.index}] ${s.title}${s.domain ? ` (${s.domain})` : ''} — ${s.url}`)
    .join('\n');
  const answer = sourcesArr.length ? `${bulletsText}\n\nSources:\n${sourcesText}` : bulletsText;
  return { answer, sources: sourcesArr, explanations };
}

/**
 * Aggregate summaries of pages visited on a given date and produce a
 * high‑level daily highlight by summarising their combined content.  If
 * individual page summaries are missing, they will be generated on demand.
 *
 * @param {string} dateStr A string in YYYY-MM-DD format representing the local date.
 * @returns {Promise<string>} A highlight summary, or a message if no pages.
 */
async function getHighlights(dateStr) {
  // Try cache first; trust only if count matches current pages for that date
  try {
    const cached = await getHighlightCache(dateStr);
    if (cached && typeof cached.text === 'string') {
      const pagesNow = await getAllPages();
      const cnt = pagesNow.filter(p => formatLocalYMD(p.timestamp) === dateStr).length;
      if (cnt === (cached.count || 0)) {
        return cached.text;
      }
    }
  } catch (_) {}
  const pages = await getAllPages();
  // Filter pages whose timestamp falls on the given date (local time).
  const summaries = [];
  for (const page of pages) {
    const localDate = formatLocalYMD(page.timestamp);
    if (localDate === dateStr) {
      if (page.summary && page.summary.length > 0) {
        summaries.push(page.summary);
      } else {
        // If no summary exists, summarise the combined text of all chunks.
        const combined = (page.items || []).map(item => item.text).join(' ');
        const sum = await computeSummary(combined);
        if (sum && sum.length > 0) {
          summaries.push(sum);
          // Optionally update the record with this summary for future reuse.
          page.summary = sum;
        }
      }
    }
  }
  if (summaries.length === 0) {
    await setHighlightCache(dateStr, { date: dateStr, text: 'No pages captured for this date.', generatedAt: Date.now(), count: 0, partial: false });
    return 'No pages captured for this date.';
  }
  // Sort pages by recency (latest first) and limit to the top few entries.  We will
  // produce one short paragraph per article instead of a single merged summary.
  summaries.sort((a, b) => {
    // Each summary currently stored alongside its timestamp on the page record.
    // However, we lose that association when we push into `summaries`.  To
    // generate per‑page highlights, we will re‑extract summaries in order of
    // recency when building the paragraphs below.  This placeholder sort keeps
    // the original order but could be enhanced if timestamps were included.
    return 0;
  });
  // Rebuild paragraphs from the filtered pages: fetch the pages again to get
  // titles, domains and summaries.  We limit to the most recent N pages.
  const MAX_HIGHLIGHTS = 5;
  const db = await openDB();
  const allPages = await getAllPages();
  const pagesForDate = allPages.filter(p => formatLocalYMD(p.timestamp) === dateStr);
  // Sort by timestamp descending.
  pagesForDate.sort((a, b) => b.timestamp - a.timestamp);
  const selected = pagesForDate.slice(0, MAX_HIGHLIGHTS);
  const paragraphs = [];
  for (const page of selected) {
    let sum = page.summary;
    if (!sum || sum.length === 0) {
      // Non-blocking: enqueue summary backfill
      try { enqueueSummaryBackfill({ id: page.id, date: dateStr }); } catch (_) {}
    }
    // Extract domain for better context.
    let domain = '';
    try {
      domain = new URL(page.url).hostname;
    } catch (_) {
      domain = '';
    }
    const titleLine = page.title ? page.title : page.url;
    paragraphs.push(`• ${titleLine}${domain ? ` (domain: ${domain})` : ''}: ${sum}`);
  }
  const text = paragraphs.join('\n\n');
  try { await setHighlightCache(dateStr, { date: dateStr, text, generatedAt: Date.now(), count: pagesForDate.length, partial: false }); } catch (_) {}
  return text;
}

// Listen for messages from content scripts and the side panel.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Debug log inbound messages (coarse), but skip logs-page chatter to avoid flooding
  try {
    const t = message?.type;
    if (t !== 'GET_LOGS' && t !== 'CLEAR_LOGS') {
      LOGGER.debug('onMessage', { type: t, payloadKeys: Object.keys(message || {}) });
    }
  } catch (_) {}
  if (message.type === 'SAVE_PAGE') {
    // Capture pages asynchronously; don't block the message sender.
    // Save payload for potential retry without reopening page
    (async () => {
      try {
        const { paused } = await getSettings();
        const forced = !!message.force || !!message.manual;
        if (paused && !forced) {
          await LOGGER.info('capture skipped (paused)', { url: message.url });
          sendResponse({ ok: true, skipped: 'paused' });
          return;
        }
        savePendingCapture(message.url, message).then(() => {}).catch(() => {});
        enqueueProcess(message);
        sendResponse({ ok: true });
      } catch (_) {
        // fallback behavior
        savePendingCapture(message.url, message).then(() => {}).catch(() => {});
        enqueueProcess(message);
        sendResponse({ ok: true });
      }
    })();
    return true;
  }
  if (message.type === 'SHOULD_CAPTURE') {
    shouldCapture(message.url).then(allow => sendResponse({ allow })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'SEARCH_QUERY') {
    try { LOGGER.debug('onMessage SEARCH_QUERY', { query: message.query, limit: message.limit }); } catch (_) {}
    searchMemory(message.query, message.limit || 5)
      .then(results => sendResponse({ results }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep the message channel open for async response.
  }
  if (message.type === 'GET_HIGHLIGHTS') {
    // Determine date: use provided date string or default to today in local time.
    let dateStr = message.date;
    if (!dateStr) {
      dateStr = formatLocalYMD(new Date());
    }
    getHighlights(dateStr)
      .then(highlight => sendResponse({ highlight }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'LIST_HIGHLIGHT_DATES') {
    (async () => {
      try {
        const from = message.from ? String(message.from) : null;
        const to = message.to ? String(message.to) : null;
        const offset = Math.max(0, (message.offset|0) || 0);
        const limit = Math.max(1, Math.min(1000, (message.limit|0) || 30));
        const pages = await getAllPages();
        const counts = new Map();
        for (const p of pages) {
          const d = formatLocalYMD(p.timestamp);
          counts.set(d, (counts.get(d) || 0) + 1);
        }
        let dates = Array.from(counts.entries()).map(([date, count]) => ({ date, count }));
        dates.sort((a, b) => b.date.localeCompare(a.date));
        if (from) dates = dates.filter(x => x.date >= from);
        if (to) dates = dates.filter(x => x.date <= to);
        const total = dates.length;
        const page = dates.slice(offset, offset + limit);
        sendResponse({ dates: page, total });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
    })();
    return true;
  }
  if (message.type === 'GET_SETTINGS') {
    getSettings().then(s => sendResponse(s)).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'SET_SETTINGS') {
    // Expect partial settings in message.payload
    setSettings(message.payload || {})
      .then(async () => {
        if (message.payload && typeof message.payload.paused === 'boolean') {
          await updateActionBadge(!!message.payload.paused);
          try { chrome.runtime.sendMessage({ type: 'PAUSE_STATE', paused: !!message.payload.paused }); } catch (_) {}
          try { chrome.contextMenus.update('wm_toggle_pause', { title: message.payload.paused ? 'Resume capture' : 'Pause capture' }); } catch (_) {}
        }
        if (message.payload && message.payload.logLevel) {
          LOGGER.setLevel(message.payload.logLevel);
          await LOGGER.info('log level updated', { level: message.payload.logLevel });
        }
        if (message.payload && typeof message.payload.logFullBodies === 'boolean') {
          LOG_FULL_BODIES = !!message.payload.logFullBodies;
          await LOGGER.info('log body detail updated', { full: LOG_FULL_BODIES });
        }
        if (message.payload && typeof message.payload.ollamaBase === 'string') {
          await LOGGER.info('ollama base updated', { base: message.payload.ollamaBase });
        }
        sendResponse({ ok: true });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_CALIBRATION') {
    getCalibration().then(c => sendResponse(c)).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'SET_CALIBRATION') {
    setCalibration(message).then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'LIST_MODELS') {
    listModels().then(models => sendResponse({ models })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'SET_MODEL') {
    // Expect { key: 'summaryModel' | 'chatModel', value: '<model name>' }
    setModel(message.key, message.value)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_MODEL_SETTINGS') {
    getModelSettings().then(settings => sendResponse(settings)).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_PROVIDERS') {
    (async () => {
      try {
        const st = await getOllamaStatus();
        const base = await getOllamaBase();
        sendResponse({ providers: [ { id: 'ollama', name: 'Ollama', status: st, settings: [ { key: 'ollamaBase', label: 'Base URL', type: 'text', value: base } ], actions: [ { id: 'test', label: 'Test' } ] } ] });
      } catch (err) {
        sendResponse({ error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (message.type === 'SET_PROVIDER_SETTING') {
    (async () => {
      try {
        const { providerId, key, value } = message;
        if (providerId !== 'ollama') throw new Error('unknown provider');
        if (key === 'ollamaBase') {
          await new Promise((resolve) => chrome.storage.local.set({ ollamaBase: String(value || '') }, resolve));
          // Optionally re-check after base change
          await checkModelsOnline();
          sendResponse({ ok: true });
          return;
        }
        throw new Error('unknown setting');
      } catch (err) {
        sendResponse({ error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (message.type === 'PROVIDER_ACTION') {
    (async () => {
      try {
        const { providerId, action } = message;
        if (providerId !== 'ollama') throw new Error('unknown provider');
        if (action === 'test') {
          // Support testing an override base URL without affecting global status
          const baseOverride = typeof message.baseOverride === 'string' && message.baseOverride ? String(message.baseOverride) : null;
          try {
            const base = baseOverride || await getOllamaBase();
            const url = `${base.replace(/\/$/, '')}/`;
            const controller = new AbortController();
            const timeoutMs = 5000;
            const t0 = Date.now();
            const to = setTimeout(() => controller.abort(), timeoutMs);
            let res;
            try {
              res = await fetch(url, { method: 'GET', signal: controller.signal });
            } finally {
              clearTimeout(to);
            }
            const ms = Date.now() - t0;
            const ok = !!res?.ok;
            sendResponse({ ok, status: { online: ok, checkedAt: Date.now(), lastError: ok ? null : `HTTP ${res?.status}` }, detail: { status: res?.status || 0, ms } });
          } catch (e) {
            const ms = 0;
            const msg = String(e && e.name === 'AbortError' ? 'timeout' : (e?.message || e));
            sendResponse({ ok: false, status: { online: false, checkedAt: Date.now(), lastError: msg }, detail: { status: 0, ms, error: msg } });
          }
          return;
        }
        throw new Error('unknown action');
      } catch (err) {
        sendResponse({ error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (message.type === 'ASK_QUESTION') {
    askQuestion(message.question)
      .then(res => {
        if (typeof res === 'string') {
          sendResponse({ answer: res });
        } else {
          sendResponse({ answer: res.answer, sources: res.sources, explanations: res.explanations });
        }
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'RETRY_PROCESSING') {
    (async () => {
      try {
        const url = message.url;
        const payload = await getPendingCapture(url);
        if (!payload) {
          sendResponse({ error: 'No pending payload for this URL. Try opening the page and using Capture Now.' });
          return;
        }
        // Remove current processing entry to avoid duplicates in the list
        try { await removeProcessingPage(url); } catch (_) {}
        await updateProcessingPage(url, { status: 'retrying', attempts: 0 });
        enqueueProcess(payload);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
    })();
    return true;
  }
  if (message.type === 'CANCEL_PROCESSING') {
    (async () => {
      try {
        const url = message.url;
        await removeProcessingPage(url);
        await removePendingCapture(url);
        await appendLog('info', 'processing canceled', { url });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
    })();
    return true;
  }
  if (message.type === 'GET_LOGS') {
    getLogs().then(logs => sendResponse({ logs })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'CLEAR_LOGS') {
    clearLogs().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_PROCESSING') {
    getProcessingPages().then(list => sendResponse({ processing: list })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_PAGE_LIST') {
    getPageList().then(list => sendResponse({ pages: list })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'DELETE_PAGE') {
    deletePageById(message.id)
      .then(() => { try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_INVALIDATE_INDEX' }); } catch (_) {}; sendResponse({ ok: true }); })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'DELETE_BY_URL') {
    (async () => {
      try {
        const pages = await getAllPages();
        const toDeletePages = pages.filter(p => p.url === message.url);
        const toDelete = toDeletePages.map(p => p.id);
        for (const id of toDelete) {
          await deletePageById(id);
        }
        try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_INVALIDATE_INDEX' }); } catch (_) {}
        try {
          const dates = new Set(toDeletePages.map(p => formatLocalYMD(p.timestamp)));
          for (const d of dates) { try { await removeHighlightCache(d); } catch (_) {} }
        } catch (_) {}
        sendResponse({ ok: true, count: toDelete.length });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
    })();
    return true;
  }
  if (message.type === 'GET_ALL_PAGES') {
    getAllPages().then(pages => sendResponse({ pages })).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'BACKFILL_RECORDS') {
    (async () => {
      try {
        const ids = Array.isArray(message.ids) ? message.ids : [];
        const db = await openDB();
        let done = 0;
        for (const id of ids) {
          try {
            const rec = await new Promise((resolve) => {
              const tx = db.transaction(STORE_NAME, 'readonly');
              const store = tx.objectStore(STORE_NAME);
              const req = store.get(id);
              req.onsuccess = () => resolve(req.result || null);
              req.onerror = () => resolve(null);
            });
            if (!rec) continue;
            // Determine versions to backfill
            if (Array.isArray(rec.versions) && rec.versions.length > 0) {
              const filled = [];
              for (const v of rec.versions) {
                filled.push(await ensureVersionData(v, { fillSummary: true }));
              }
              rec.versions = filled;
              // Sync to latest
              const idx = typeof rec.latestVersionIndex === 'number' ? rec.latestVersionIndex : (rec.versions.length - 1);
              const cur = rec.versions[idx];
              rec.timestamp = cur.timestamp;
              rec.items = cur.items;
              rec.centroid = cur.centroid;
              rec.summary = cur.summary || '';
            } else {
              // Legacy-like record
              const filled = await ensureVersionData({ timestamp: rec.timestamp, items: rec.items || [], summary: rec.summary || '' }, { fillSummary: true });
              rec.versions = [filled];
              rec.latestVersionIndex = 0;
              rec.timestamp = filled.timestamp;
              rec.items = filled.items;
              rec.centroid = filled.centroid;
              rec.summary = filled.summary || '';
            }
            // Persist
            await new Promise((resolve, reject) => {
              const tx = db.transaction(STORE_NAME, 'readwrite');
              tx.objectStore(STORE_NAME).put(rec);
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            done++;
          } catch (_) { /* continue next */ }
        }
        sendResponse({ ok: true, done });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
    })();
    return true;
  }
  if (message.type === 'IMPORT_PAGES') {
    (async () => {
      try {
        const pages = Array.isArray(message.pages) ? message.pages : [];
        const schemaVersion = Number.isFinite(message.schemaVersion) ? message.schemaVersion : 0;
        const incomingMeta = (message.embeddingMeta && typeof message.embeddingMeta === 'object') ? message.embeddingMeta : null;
        // Persist embedding meta once if provided and not already set
        try {
          const curMeta = await getEmbeddingMeta();
          if (!curMeta && incomingMeta && Number.isFinite(incomingMeta.dim) && incomingMeta.dim > 0) {
            await ensureEmbeddingMeta(incomingMeta.model || null, incomingMeta.dim);
          }
        } catch (_) {}
        // Read current embedding dimension for compatibility filtering
        const curMeta2 = await getEmbeddingMeta();
        const currentDim = curMeta2?.dim || null;
        const db = await openDB();
        const { versioningMaxVersions, versioningSimilarityThreshold } = await getSettings();
        // Determine total work units (versions)
        let total = 0;
        for (const src of pages) {
          if (Array.isArray(src.versions) && src.versions.length > 0) total += src.versions.length;
          else total += 1;
        }
        let done = 0;
        let skippedIncompatible = 0;
        chrome.runtime.sendMessage({ type: 'IMPORT_PROGRESS', done, total });
        for (const src of pages) {
          try {
            // Basic tolerant field mapping for future schemas
            const url = src.url || src.href || '';
            const title = src.title || src.name || url;
            const can = canonicalizeUrl(src.canonicalUrl || src.canonical || url);
            // Build version list: prefer known keys, then common alternates
            let versions = [];
            const asArray = (x) => Array.isArray(x) ? x : [];
            if (Array.isArray(src.versions) && src.versions.length > 0) {
              versions = src.versions.slice();
            } else if (Array.isArray(src.history) && src.history.length > 0) {
              versions = src.history.slice();
            } else if (Array.isArray(src.snapshots) && src.snapshots.length > 0) {
              versions = src.snapshots.slice();
            } else {
              // Single-version fallback from items/chunks/passages
              const items0 = asArray(src.items).length ? src.items
                         : asArray(src.chunks).length ? src.chunks
                         : asArray(src.passages);
              versions = [{ timestamp: typeof src.timestamp === 'number' ? src.timestamp : Date.now(), items: items0, summary: src.summary || '' }];
            }
            // Sort by timestamp ascending so we append in order
            versions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            for (const v of versions) {
              // Map possible item shapes to { text, embedding }
              const mapped = { ...v };
              const srcItems = Array.isArray(mapped.items) && mapped.items.length ? mapped.items
                              : Array.isArray(mapped.chunks) ? mapped.chunks
                              : Array.isArray(mapped.passages) ? mapped.passages
                              : [];
              mapped.items = srcItems.map(it => ({
                text: (it && (it.text || it.snippet || it.content || it.chunk || it.body || '')),
                embedding: (it && (it.embedding || it.vector || it.vec || null))
              }));
              let ready = await ensureVersionData(mapped, { fillSummary: true });
              // If we know the current embedding dimension, filter out items with mismatched dims
              if (Number.isFinite(currentDim) && currentDim > 0 && Array.isArray(ready.items)) {
                const filtered = ready.items.filter(it => !Array.isArray(it.embedding) || it.embedding.length === currentDim);
                if (filtered.length === 0 && Array.isArray(ready.items) && ready.items.length > 0) {
                  skippedIncompatible++;
                  continue; // skip this version entirely
                }
                ready.items = filtered;
                try { ready.centroid = computeCentroid(filtered) || undefined; } catch (_) {}
              } else if ((!currentDim || currentDim === null) && Array.isArray(ready.items) && ready.items.length > 0) {
                // No stored meta yet: infer from first embedding and persist once
                const first = ready.items.find(it => Array.isArray(it.embedding) && it.embedding.length > 0);
                if (first) {
                  try {
                    const dim = first.embedding.length;
                    // Prefer incoming file meta model; else fall back to current settings
                    let model = incomingMeta?.model || null;
                    if (!model) { const s = await getModelSettings(); model = s.embedModel || null; }
                    await ensureEmbeddingMeta(model, dim);
                  } catch (_) {}
                }
              }
              await upsertVersion(can, url, title, ready, versioningMaxVersions, versioningSimilarityThreshold);
              done++;
              // Emit coarse-grained progress update
              try { chrome.runtime.sendMessage({ type: 'IMPORT_PROGRESS', done, total, label: title }); } catch (_) {}
            }
          } catch (e) {
            // continue next
          }
        }
        try { chrome.runtime.sendMessage({ type: 'IMPORT_PROGRESS', done: total, total }); } catch (_) {}
        try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_INVALIDATE_INDEX' }); } catch (_) {}
        sendResponse({ ok: true, skippedIncompatible });
      } catch (err) {
        sendResponse({ error: String(err) });
      }
    })();
    return true;
  }
  if (message.type === 'GET_CAPTURE_RULES') {
    getCaptureRules().then(r => sendResponse(r)).catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'SET_CAPTURE_RULES') {
    setCaptureRules({ whitelistDomains: message.whitelistDomains || [], blacklistDomains: message.blacklistDomains || [] })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  // Unknown messages are ignored.
  return false;
});

// Initialize logger level from saved settings on service worker startup
(async () => {
  try {
    const s = await getSettings();
    LOGGER.setLevel(s.logLevel || 'info');
    await LOGGER.info('logger initialized', { level: s.logLevel || 'info' });
    await updateActionBadge(!!s.paused);
  } catch (_) {}
})();

/**
 * Ensure the offscreen document exists to handle background ranking/indexing.
 */
// Cross-context: required for heavy scoring/indexing; called by search paths
// before offscreen operations so it doesn't appear unused in static scans.
async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return; // Permission might be removed
  try {
    // @ts-ignore: hasDocument exists in MV3
    const has = await chrome.offscreen.hasDocument?.();
    if (has) return;
  } catch (_) {}
  try {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['CPU_HEAVY'],
        justification: 'Background compute (similarity scoring) and IndexedDB access'
      });
    } catch (e) {
      // Fallback for Chrome versions that don’t support CPU_HEAVY
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING'],
        justification: 'Background compute (similarity scoring) and IndexedDB access'
      });
    }
  } catch (err) {
    console.warn('Failed to create offscreen document:', err);
  }
}

// Helper: open side panel for a tab or fallback to a normal tab.
// Invoked by action clicks, commands, and context menus to surface the UI.
function openSidePanelForTab(tabId) {
  const target = (typeof tabId === 'number' && tabId >= 0) ? tabId : ACTIVE_TAB_ID;
  if (chrome.sidePanel && typeof target === 'number') {
    try {
      // Fire-and-forget; avoid async gaps before open to keep user gesture alive.
      chrome.sidePanel.setOptions({ tabId: target, path: 'sidepanel.html', enabled: true }).catch(() => {});
    } catch (_) {}
    try {
      chrome.sidePanel.open({ tabId: target }).catch(() => {
        try { chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') }); } catch (_) {}
      });
      return;
    } catch (_) {
      // fall through to tab open
    }
  }
  try { chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') }); } catch (_) {}
}

// Open side panel when the extension toolbar icon is clicked.
if (chrome.action) {
  chrome.action.onClicked.addListener((tab) => {
    const tabId = (tab && typeof tab.id === 'number') ? tab.id : ACTIVE_TAB_ID;
    openSidePanelForTab(tabId);
  });
}

// Keyboard shortcut handler
if (chrome.commands) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-side-panel') {
      if (chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs && tabs[0] && typeof tabs[0].id === 'number' ? tabs[0].id : ACTIVE_TAB_ID;
          openSidePanelForTab(tabId);
        });
      } else {
        openSidePanelForTab(ACTIVE_TAB_ID);
      }
    }
  });
}

// Context menu: Right-click to open panel or capture now
function createContextMenus() {
  if (!chrome.contextMenus) return;
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'wm_open_panel', title: 'Open Web Recall', contexts: ['page', 'action'] });
      chrome.contextMenus.create({ id: 'wm_capture_now', title: 'Capture This Page Now', contexts: ['page'] });
      chrome.contextMenus.create({ id: 'wm_search_selection', title: 'Search selection in Web Memory', contexts: ['selection'] });
      // Pause/Resume toggle on action (toolbar) and page context
      chrome.contextMenus.create({ id: 'wm_toggle_pause', title: 'Pause capture', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'wm_open_highlights', title: 'Open Highlights', contexts: ['action'] });
      // Initialize label based on current state
      getSettings().then(s => {
        try { chrome.contextMenus.update('wm_toggle_pause', { title: s.paused ? 'Resume capture' : 'Pause capture' }); } catch (_) {}
      }).catch(() => {});
    });
  } catch (_) {}
}

if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    createContextMenus();
  });
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'wm_open_panel') {
      openSidePanelForTab(tab?.id);
    } else if (info.menuItemId === 'wm_capture_now') {
      if (tab && tab.id) {
        try { chrome.tabs.sendMessage(tab.id, { type: 'FORCE_CAPTURE' }, () => {}); } catch (_) {}
      }
    } else if (info.menuItemId === 'wm_search_selection') {
      const text = (info.selectionText || '').trim();
      if (!text) return;
      // Stash in storage so the panel can pick it up on load, and also try live message
      chrome.storage.local.set({ prefillQuery: text, prefillDoSearch: true }, async () => {
        await openSidePanelForTab(tab?.id);
        try { chrome.runtime.sendMessage({ type: 'PREFILL_QUERY', query: text, autoSearch: true }); } catch (_) {}
      });
    } else if (info.menuItemId === 'wm_toggle_pause') {
      try {
        const { paused } = await getSettings();
        const next = !paused;
        await setSettings({ paused: next });
        await updateActionBadge(next);
        try { chrome.runtime.sendMessage({ type: 'PAUSE_STATE', paused: next }); } catch (_) {}
        try { chrome.contextMenus.update('wm_toggle_pause', { title: next ? 'Resume capture' : 'Pause capture' }); } catch (_) {}
      } catch (_) {}
    } else if (info.menuItemId === 'wm_open_highlights') {
      try { chrome.tabs.create({ url: chrome.runtime.getURL('highlights.html') }); } catch (_) {}
    }
  });
}
// -------- Fetch logging wrapper --------
async function logFetch(url, options, meta) {
  try {
    const method = (options && options.method) || 'GET';
    const kind = meta && meta.kind ? String(meta.kind) : '';
    const isEmbedKind = kind.includes('embed') || /\/api\/(embed|embeddings)\b/.test(url || '');
    const isChatKind = kind.includes('chat') || /\/api\/chat\b/.test(url || '');

    // Prepare request body only when logging full bodies is enabled
    let requestBody;
    if (LOG_FULL_BODIES && options && options.body) {
      const raw = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      // Trim long strings to avoid bloating logs
      requestBody = typeof raw === 'string' && raw.length > 2000 ? (raw.slice(0, 2000) + '…') : raw;
    }
    const start = Date.now();
    await LOGGER.debug('fetch start', { url, method, requestBody, meta });
    // Detect if this call targets the Ollama base and mark active
    let isOllama = false;
    try { const base = await getOllamaBase(); isOllama = String(url || '').startsWith(base); } catch (_) {}
    if (isOllama) OLLAMA_ACTIVE++;
    // Apply timeout unless caller provided a signal
    const timeout = (meta && Number.isFinite(meta.timeoutMs)) ? meta.timeoutMs : FETCH_TIMEOUT_MS;
    let controller;
    let to;
    let opts = options || {};
    if (!opts.signal && timeout > 0) {
      controller = new AbortController();
      opts = { ...opts, signal: controller.signal };
      to = setTimeout(() => controller.abort(), timeout);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } finally {
      if (to) clearTimeout(to);
    }
    const ms = Date.now() - start;
    let responseBody;
    // Only include response bodies when full logging is enabled. However, always
    // sanitize/summarize embeddings; and for chat, avoid leaking full prompts/answers
    // unless full logging is enabled.
    if (LOG_FULL_BODIES || isEmbedKind) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        try { responseBody = JSON.parse(text); } catch (_) { responseBody = text; }
      } catch (_) {
        responseBody = '<unreadable>';
      }
      // Sanitize embeddings to a compact summary
      if (isEmbedKind) {
        try {
          if (responseBody && typeof responseBody === 'object') {
            if (Array.isArray(responseBody.embeddings)) {
              const count = responseBody.embeddings.length;
              const dim = Array.isArray(responseBody.embeddings[0]) ? (responseBody.embeddings[0].length || 0) : 0;
              responseBody = { embeddings: `Array(count=${count}, dim=${dim})` };
            } else if (Array.isArray(responseBody.embedding)) {
              const dim = responseBody.embedding.length || 0;
              responseBody = { embedding: `Array(dim=${dim})` };
            } else {
              responseBody = '<embedding-json>';
            }
          } else if (typeof responseBody === 'string') {
            responseBody = '<embedding-text>';
          }
        } catch (_) { /* ignore sanitize errors */ }
      }
      // Sanitize chat unless full logging is enabled: only log sizes
      if (isChatKind && !LOG_FULL_BODIES) {
        try {
          if (typeof responseBody === 'string') {
            responseBody = `<chat-text length=${responseBody.length}>`;
          } else if (responseBody && typeof responseBody === 'object') {
            const msg = responseBody?.message?.content;
            const len = typeof msg === 'string' ? msg.length : 0;
            responseBody = { message: `<length=${len}>` };
          }
        } catch (_) { /* ignore sanitize errors */ }
      }
      // Trim long string bodies for non-embed/chat cases when full logging is on
      if (LOG_FULL_BODIES && typeof responseBody === 'string' && responseBody.length > 4000) {
        responseBody = responseBody.slice(0, 4000) + '…';
      }
    }
    await LOGGER.debug('fetch done', { url, status: res.status, ms, responseBody });
    try {
      const kind = meta && meta.kind ? String(meta.kind) : '';
      const suppress = meta && meta.suppressStatus;
      const STATUS_KINDS = new Set(['embed','embed_batch','chat_ask','chat_ask_tools','chat_ask_extract','chat_ask_extract_tools','chat_ask_compose','tags','health']);
      if (STATUS_KINDS.has(kind) && !suppress) {
        await setOllamaStatus(true, null);
      }
    } catch (_) {}
    return res;
  } catch (err) {
    try {
      const kind = meta && meta.kind ? String(meta.kind) : '';
      const WARN_KINDS = new Set(['chat_rewrite','chat_decompose','tags','embed_test','chat_test','health']);
      if (WARN_KINDS.has(kind)) {
        await LOGGER.warn('fetch error', { url, error: String(err), meta });
      } else {
        await LOGGER.error('fetch error', { url, error: String(err), meta });
      }
      const STATUS_ERR_KINDS = new Set(['embed','embed_batch','chat_ask','chat_ask_tools','chat_ask_extract','chat_ask_extract_tools','chat_ask_compose','tags','health']);
      const suppress = meta && meta.suppressStatus;
      if (STATUS_ERR_KINDS.has(kind) && !suppress) {
        await setOllamaStatus(false, String(err));
      }
    } catch (_) {
      await LOGGER.error('fetch error', { url, error: String(err), meta });
    }
    throw err;
  }
  finally {
    try {
      const base = await getOllamaBase();
      if (String(url || '').startsWith(base) && OLLAMA_ACTIVE > 0) OLLAMA_ACTIVE--;
    } catch (_) {}
  }
}
import { ToolsRuntime } from './tools.js';
