import { installSharedStyles, createToolNavigation, createBackLink, createStorageSettingsLink, isMissingLibraryError, iconMarkup, createPageEntry, navigateTo, appUrl } from '../shared/presentation';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';
import { createFileTransfers } from '../shared/fileTransfers';
import type { SavedVersionSelection, ForgetResult } from '../../shared/pageHistory';
import type { BackfillFailure, BackfillResult } from '../../background/embeddings/backfill';
import { captureStatusText } from '../../shared/captureStatus';
import { readCaptureDateRange, readSearchFilters, type SearchFilters } from '../../shared/searchFilters';
import { captureNotice } from '../shared/captureNotice';
import type { CaptureInfo } from '../../shared/capture';

const root = document.querySelector<HTMLElement>('#app-root');

type ManagePage = {
  url: string;
  title: string;
  timestamp: number;
  manual: boolean;
  hasEmbeddings?: boolean;
  hasSummary?: boolean;
  embeddingStatus?: string;
  chunkCount?: number;
  lastEmbeddedAt?: number;
  firstCapturedAt?: number;
  lastVisitedAt?: number;
  versionCount?: number;
  captureInfo?: CaptureInfo;
};

type QueueEntry = {
  url: string;
  title: string;
  status: string;
  attempts: number;
  updatedAt?: number;
  error?: string;
  textSaved?: boolean;
};

type ManageState = {
  pages: ManagePage[];
  filtered: ManagePage[];
  sortKey: 'title' | 'url' | 'date';
  sortAsc: boolean;
  selected: Set<string>;
  queue: QueueEntry[];
};

const state: ManageState = {
  pages: [],
  filtered: [],
  sortKey: 'date',
  sortAsc: false,
  selected: new Set(),
  queue: []
};

let backfillRequestId: string | null = null;
let regeneratingSummaryUrl: string | null = null;
let pageLoadGeneration = 0;
let pageListState: 'loading' | 'ready' | 'unavailable' = 'loading';
let queueLoadGeneration = 0;
const rowProgress = new Map<string, { text: string; error?: boolean; failures?: Partial<Record<BackfillFailure['phase'], string>> }>();

function recordBackfillFailure(failure: BackfillFailure): void {
  const previous = rowProgress.get(failure.url);
  rowProgress.set(failure.url, { text: '', ...previous, failures: { ...previous?.failures, [failure.phase]: failure.error } });
}

function ensureStyles(): void { installSharedStyles(); }

async function initTheme(): Promise<void> {
  try {
    const response = await sendRuntimeMessage<{ settings?: { theme?: ThemeChoice } }>({ type: 'GET_SETTINGS' });
    applyTheme(response.settings?.theme ?? 'light');
  } catch {
    applyTheme('light');
  }
  bindSystemThemeListener();
}

function formatDate(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function updateStatus(message: string, isError = false): void {
  const status = document.querySelector<HTMLParagraphElement>('#manage-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('danger', isError);
}

function applyFilters(): void {
  const searchInput = document.querySelector<HTMLInputElement>('#manage-search');
  const manualOnly = document.querySelector<HTMLInputElement>('#manage-filter-manual');
  const query = searchInput?.value.trim().toLowerCase() || '';
  state.filtered = state.pages.filter((page) => {
    if (manualOnly?.checked && !page.manual) return false;
    if (!query) return true;
    const domain = (() => {
      try {
        return new URL(page.url).hostname;
      } catch {
        return page.url;
      }
    })();
    return (
      page.title.toLowerCase().includes(query) ||
      page.url.toLowerCase().includes(query) ||
      domain.toLowerCase().includes(query)
    );
  });
  sortAndRender();
}

function sortAndRender(): void {
  const sorted = state.filtered.slice().sort((a, b) => {
    let va: string | number = 0;
    let vb: string | number = 0;
    if (state.sortKey === 'title') {
      va = a.title.toLowerCase();
      vb = b.title.toLowerCase();
    } else if (state.sortKey === 'url') {
      va = a.url.toLowerCase();
      vb = b.url.toLowerCase();
    } else {
      va = a.timestamp;
      vb = b.timestamp;
    }
    if (va < vb) return state.sortAsc ? -1 : 1;
    if (va > vb) return state.sortAsc ? 1 : -1;
    return 0;
  });
  renderRows(sorted);
}

function renderRows(rows: ManagePage[]): void {
  const list = document.querySelector<HTMLElement>('#manage-rows');
  if (!list) return;
  const open = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>('details[open]')).map(item => item.dataset.url));
  const jobs = new Map(state.queue.map(entry => [entry.url, entry]));
  list.replaceChildren();
  for (const page of rows) {
    const { article, details, body } = createPageEntry(page);
    details.name = 'memory-page'; details.open = open.has(page.url);
    if (page.manual) { const manual = document.createElement('span'); manual.className = 'manual-label'; manual.textContent = 'Manual'; details.querySelector('.source-meta')!.append(manual); }
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'memory-selection';
    checkbox.setAttribute('aria-label', `Select ${page.title || page.url}`); checkbox.dataset.url = page.url; checkbox.checked = state.selected.has(page.url);
    checkbox.addEventListener('change', () => { if (checkbox.checked) state.selected.add(page.url); else state.selected.delete(page.url); updateDeleteButton(); });
    article.prepend(checkbox);
    const facts = document.createElement('dl'); facts.className = 'memory-facts';
    const rawStatus = page.embeddingStatus || (page.hasEmbeddings ? 'Present' : 'Missing');
    const embedStatus = rawStatus.startsWith('Different or unknown') ? 'Needs re-embed' : rawStatus;
    const summaryStatus = page.hasSummary === true ? 'Ready' : page.hasSummary === false ? 'Not saved yet' : 'Unavailable — reload extension';
    const job = jobs.get(page.url);
    const savedStatus = job ? captureStatusText({ ...job, textSaved: true }) : page.hasEmbeddings ? 'Indexed' : 'Saved · text-searchable';
    for (const [name, value] of [['Status', savedStatus], ['Captured', formatDate(page.timestamp)], ['Version first saved', formatDate(page.firstCapturedAt ?? page.timestamp)], ['Last observed visit', page.lastVisitedAt !== undefined ? formatDate(page.lastVisitedAt) : 'Not recorded'], ['Saved versions', String(page.versionCount || 1)], ['Capture', page.manual ? 'Manual' : 'Automatic'], ['Embeddings', `${embedStatus} · ${page.chunkCount || 0} ${page.chunkCount === 1 ? 'chunk' : 'chunks'}`], ['Last embedded', page.lastEmbeddedAt ? formatDate(page.lastEmbeddedAt) : 'Not embedded'], ['Summary', summaryStatus], ['URL', page.url]]) {
      const row = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = name || ''; const dd = document.createElement('dd'); dd.textContent = value || ''; row.append(dt, dd); facts.append(row);
    }
    body.append(facts);
    const notice = captureNotice(page.captureInfo); if (notice) body.append(notice);
    const progress = rowProgress.get(page.url);
    if (progress?.text) { const line = document.createElement('span'); line.className = 'wr-row-progress'; line.textContent = progress.text; if (progress.error) line.dataset.variant = 'error'; body.append(line); }
    for (const [phase, error] of Object.entries(progress?.failures || {})) {
      const line = document.createElement('p'); line.className = 'wr-row-progress'; line.dataset.variant = 'error';
      line.textContent = `${phase === 'summaries' ? 'Summary' : 'Embeddings'} failed: ${error}`; body.append(line);
    }
    const actions = document.createElement('div'); actions.className = 'content-entry-actions';
    const preview = document.createElement('a'); preview.href = appUrl('sidepanel') + '#page=' + encodeURIComponent(page.url); preview.className = 'primary-button'; preview.textContent = 'Preview page';
    preview.addEventListener('click', event => { if (navigateTo('sidepanel', page.url)) event.preventDefault(); });
    const history = document.createElement('a'); history.href = appUrl('sidepanel') + '#history=' + encodeURIComponent(page.url); history.className = 'text-button'; history.textContent = 'Saved versions';
    history.addEventListener('click', event => { if (navigateTo('sidepanel', page.url, 'history')) event.preventDefault(); });
    const original = document.createElement('a'); original.href = page.url; original.target = '_blank'; original.rel = 'noreferrer'; original.className = 'text-button'; original.textContent = 'Open page';
    const reembed = document.createElement('button'); reembed.className = 'text-button'; reembed.textContent = 'Re-embed'; reembed.setAttribute('aria-label', `Re-embed ${page.title || page.url}`); reembed.disabled = Boolean(backfillRequestId); reembed.addEventListener('click', () => { void runBackfill(1, true, [page.url], true); });
    const del = document.createElement('button'); del.className = 'text-button danger-text'; del.textContent = 'Delete'; del.disabled = Boolean(backfillRequestId); del.setAttribute('aria-label', `Delete ${page.title || page.url}`); del.addEventListener('click', () => { void deletePages([page.url]); });
    const summarizing = Boolean(backfillRequestId && regeneratingSummaryUrl === page.url);
    const summary = document.createElement('button'); summary.className = 'text-button'; summary.textContent = summarizing ? 'Stop summary' : 'Regenerate summary'; summary.setAttribute('aria-label', `${summary.textContent} ${page.title || page.url}`); summary.disabled = Boolean(backfillRequestId) && !summarizing;
    summary.addEventListener('click', () => {
      if (summarizing && backfillRequestId) void sendRuntimeMessage({ type: 'CANCEL_BACKFILL', requestId: backfillRequestId }).catch(error => updateStatus(`Unable to stop summary: ${String(error)}`, true));
      else void regenerateSummary(page.url);
    });
    actions.append(preview, original, history, reembed, summary, del); body.append(actions); list.append(article);
  }
  if (!rows.length && pageListState === 'ready') { const p = document.createElement('p'); p.className = 'empty-tool-state'; p.textContent = state.pages.length ? 'No pages match. Try another search or clear your filters.' : 'No saved pages yet. Capture a page or import a backup from Tools.'; list.append(p); }
  const count = document.querySelector('#manage-count');
  if (count) count.textContent = pageListState === 'ready' ? `${rows.length} ${rows.length === 1 ? 'page' : 'pages'}` : pageListState === 'loading' ? 'Loading…' : '';
  updateDeleteButton();
  const queue = document.querySelector('#manage-queue');
  if (queue) {
    queue.replaceChildren();
    if (!state.queue.length) queue.textContent = 'No pending captures.';
    for (const entry of state.queue) {
      const row = document.createElement('div'); row.className = 'queue-entry';
      const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = entry.title || entry.url;
      const meta = document.createElement('small'); meta.textContent = captureStatusText(entry); copy.append(title, meta);
      const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.className = 'secondary-button'; retry.disabled = entry.status !== 'failed'; retry.addEventListener('click', () => { void retryQueueEntry(entry.url); }); row.append(copy, retry); queue.append(row);
    }
  }
}

function updateDeleteButton(): void {
  const deleteBtn = document.querySelector<HTMLButtonElement>('#manage-delete');
  if (deleteBtn) {
    deleteBtn.disabled = state.selected.size === 0 || Boolean(backfillRequestId);
    const all = document.querySelector<HTMLInputElement>('#manage-select-all');
    if (all) { const count = state.filtered.filter(page => state.selected.has(page.url)).length; all.checked = state.filtered.length > 0 && count === state.filtered.length; all.indeterminate = count > 0 && count < state.filtered.length; }
  }
}

function isReadablePage(page: ManagePage): boolean {
  return Boolean(page && typeof page.url === 'string' && page.url && typeof page.title === 'string' && Number.isFinite(page.timestamp)
    && (page.embeddingStatus == null || typeof page.embeddingStatus === 'string')
    && [page.chunkCount, page.lastEmbeddedAt, page.firstCapturedAt, page.lastVisitedAt, page.versionCount].every(value => value == null || Number.isFinite(value))
    && (page.captureInfo == null || (Array.isArray(page.captureInfo.warnings) && page.captureInfo.warnings.every(warning => typeof warning === 'string'))));
}

async function fetchPages(): Promise<string | undefined> {
  const generation = ++pageLoadGeneration;
  try {
    updateStatus('Loading pages…');
    const response = await sendRuntimeMessage<{ pages: ManagePage[] }>({ type: 'GET_PAGE_LIST' });
    if (generation !== pageLoadGeneration) return;
    if (!Array.isArray(response.pages) || !response.pages.every(isReadablePage)) throw new Error('Web Recall could not read the saved page list.');
    pageListState = 'ready';
    state.pages = response.pages;
    state.selected = new Set([...state.selected].filter(url => state.pages.some(page => page.url === url)));
    applyFilters();
    updateStatus('');
    document.getElementById('manage-library-recovery')!.hidden = true;
  } catch (err) {
    if (generation !== pageLoadGeneration) return;
    const error = err instanceof Error ? err.message : String(err);
    pageListState = 'unavailable';
    sortAndRender();
    updateStatus(`Failed to load pages: ${error}`, true);
    document.getElementById('manage-library-recovery')!.hidden = !isMissingLibraryError(error);
    return error;
  }
}

async function fetchQueue(): Promise<void> {
  const generation = ++queueLoadGeneration;
  try {
    const response = await sendRuntimeMessage<{ queue: QueueEntry[] }>({ type: 'GET_PROCESSING' });
    if (generation !== queueLoadGeneration) return;
    state.queue = response.queue || [];
    sortAndRender();
  } catch {
    // ignore
  }
}

async function deletePages(urls: string[]): Promise<void> {
  if (!urls.length) return;
  try {
    updateStatus('Deleting…');
    await sendRuntimeMessage<{ deleted: number }>({ type: 'DELETE_PAGE', urls });
    urls.forEach((url) => state.selected.delete(url));
    await fetchPages();
    window.dispatchEvent(new window.CustomEvent('wr-memory-changed'));
  } catch (err) {
    updateStatus(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function retryQueueEntry(url: string): Promise<void> {
  if (!url) return;
  try {
    updateStatus('Retrying capture…');
    await sendRuntimeMessage<{ retried: number }>({ type: 'RETRY_PROCESSING', url });
    await fetchQueue();
    updateStatus('Retry queued');
  } catch (err) {
    updateStatus(`Retry failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function regenerateSummary(url: string): Promise<void> {
  if (backfillRequestId) return;
  const requestId = crypto.randomUUID(); backfillRequestId = requestId; regeneratingSummaryUrl = url;
  rowProgress.clear(); rowProgress.set(url, { text: 'Summarizing…' });
  syncBackfillControls(); sortAndRender(); updateStatus('Regenerating summary… Existing summary stays until a replacement succeeds.');
  let resultText = '', resultError = false;
  try {
    const response = await sendRuntimeMessage<{ updated: boolean }>({ type: 'REGENERATE_PAGE_SUMMARY', requestId, url });
    const text = response.updated ? 'Summary regenerated.' : 'Page changed or has no saved text; no summary replaced.';
    resultText = text; rowProgress.set(url, { text });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stopped = message === 'Stopped by user';
    const text = stopped ? 'Stopped. Saved summaries are preserved.' : `Summary regeneration failed: ${message}. Existing summary is kept.`;
    resultText = text; resultError = !stopped; rowProgress.set(url, { text, error: !stopped });
  } finally {
    backfillRequestId = null; regeneratingSummaryUrl = null;
    syncBackfillControls();
    const refreshError = await fetchPages();
    if (refreshError) { resultText += ` Unable to refresh Memory: ${refreshError}`; resultError = true; }
    sortAndRender(); updateStatus(resultText, resultError);
  }
}

async function runBackfill(limit: number, force: boolean, urls?: string[], createSummaries = false, regenerateSummaries = false): Promise<boolean> {
  if (backfillRequestId) return false;
  const requestId = crypto.randomUUID(); backfillRequestId = requestId;
  rowProgress.clear();
  syncBackfillControls(); sortAndRender();
  const showStatus = (text: string, error = false): void => {
    updateStatus(text, error);
    const status = document.querySelector<HTMLElement>('#manage-backfill-status');
    if (status) { status.textContent = text; status.dataset.variant = error ? 'error' : 'info'; }
  };
  try {
    showStatus(force ? 'Re-embedding… Existing vectors stay until a replacement succeeds.' : 'Filling missing embeddings…');
    const response = await sendRuntimeMessage<{
      result?: Partial<BackfillResult>;
      error?: string;
    }>({
      type: 'BACKFILL_EMBEDDINGS',
      requestId,
      limit,
      force,
      urls,
      createSummaries,
      regenerateSummaries
    });
    if ((response as { error?: string }).error) {
      throw new Error((response as { error?: string }).error || 'Backfill failed');
    }
    const result = response.result || {
        processed: 0,
        updated: 0,
        updatedUrls: []
      };
    for (const failure of result.failures || []) recordBackfillFailure(failure);
    const updatedUrls = Array.isArray(result.updatedUrls) ? result.updatedUrls : [];
    const suffix = updatedUrls.length ? ` (${updatedUrls.length} page(s))` : '';
    await Promise.all([fetchPages(), fetchQueue()]);
    const summaries = createSummaries ? ` · Summaries: ${result.summariesUpdated || 0} ${regenerateSummaries ? 'updated' : 'created'}, ${result.summariesFailed || 0} failed` : '';
    showStatus(`Embeddings: processed ${result.processed}, updated ${result.updated}, failed ${result.failed || 0}${suffix}${summaries}`, Boolean(result.failed || result.summariesFailed));
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showStatus(message === 'Stopped by user' ? 'Stopped. Completed pages are saved; unfinished pages keep their existing vectors.' : `Backfill failed: ${message}`, message !== 'Stopped by user');
    rowProgress.clear();
    await fetchPages().catch(() => {});
    return false;
  } finally { backfillRequestId = null; syncBackfillControls(); sortAndRender(); }
}

function syncBackfillControls(): void {
  const stop = document.querySelector<HTMLButtonElement>('#manage-backfill-stop');
  if (stop) stop.hidden = !backfillRequestId;
  const run = document.querySelector<HTMLButtonElement>('#manage-backfill-run');
  const force = document.querySelector<HTMLInputElement>('#manage-backfill-force');
  const limit = document.querySelector<HTMLInputElement>('#manage-backfill-limit');
  if (!run || !force || !limit) return;
  const count = Math.max(1, Math.min(500, Number(limit.value) || 50));
  const regenerate = document.querySelector<HTMLInputElement>('#manage-backfill-regenerate-summaries');
  run.textContent = backfillRequestId ? 'Working…' : `${regenerate?.checked ? 'Backfill' : force.checked ? 'Re-embed' : 'Fill missing'} (up to ${count} pages)`;
  run.disabled = force.disabled = limit.disabled = Boolean(backfillRequestId);
  const summaries = document.querySelector<HTMLInputElement>('#manage-backfill-summaries');
  if (summaries) summaries.disabled = Boolean(backfillRequestId);
  if (regenerate) regenerate.disabled = Boolean(backfillRequestId);
}

function renderApp(rootEl: HTMLElement): void {
  ensureStyles();
  rootEl.innerHTML = `
    <div class="manage-shell wr-page">
      <div class="manage-title"><h1>Memory Manager</h1></div>
      <div class="search-form">${iconMarkup('magnifying-glass')}<input type="search" id="manage-search" placeholder="Find a saved page" aria-label="Search memory by title or domain" /></div>
      <div class="view-toolbar"><span id="manage-count" role="status">Loading…</span><div class="manage-actions"><button type="button" id="manage-delete" class="text-button danger-text" hidden disabled>Delete selected</button><button type="button" id="manage-select" class="text-button">Select</button></div></div>
      <div class="view-controls">
        <details class="view-control" name="manage-controls"><summary><span id="manage-sort-label">Recent first</span>${iconMarkup('caret-down')}</summary><div class="view-control-body">
          <label class="compact-setting">Sort pages<select id="manage-sort" aria-label="Sort memory"><option value="date-desc">Recent first</option><option value="date-asc">Oldest first</option><option value="title-asc">Title A–Z</option><option value="title-desc">Title Z–A</option><option value="url-asc">URL A–Z</option><option value="url-desc">URL Z–A</option></select></label>
          <label class="check-setting"><span>Manual captures only</span><input type="checkbox" id="manage-filter-manual" /></label>
        </div></details>
        <details class="view-control" name="manage-controls"><summary>Page actions${iconMarkup('caret-down')}</summary><div class="view-control-body">
          <button id="manage-refresh" class="text-button">Refresh pages</button>
          <details class="tool-disclosure"><summary>Export pages${iconMarkup('caret-down')}</summary><form id="manage-export-pages" class="tool-disclosure-body">
            <p class="field-note">Export readable text from the latest saved version of each page, without embedding vectors. To restore the full library, use a backup instead.</p>
            <label class="compact-setting">Pages <select id="manage-export-scope"><option value="all">All pages</option><option value="filtered">Current filter</option><option value="selected">Selected pages</option></select></label>
            <label class="compact-setting">Format <select id="manage-export-format"><option value="markdown">Markdown</option><option value="json">JSON</option></select></label>
            <button id="manage-portable-export" class="secondary-button">Export</button>
          </form></details>
          <button id="manage-transfer-stop" class="secondary-button" hidden>Stop transfer</button>
          <details class="tool-disclosure"><summary>Capture queue${iconMarkup('caret-down')}</summary><div id="manage-queue" class="wr-help">No pending captures.</div></details>
          <details id="manage-forget" class="tool-disclosure"><summary>Forget saved pages${iconMarkup('caret-down')}</summary>
            <form id="manage-forget-form" class="forget-scope-form">
              <label class="compact-setting">Site <input id="manage-forget-site" type="text" placeholder="example.com" /></label>
              <label class="compact-setting">Captured from <input id="manage-forget-from" type="date" /></label>
              <label class="compact-setting">Through <input id="manage-forget-through" type="date" /></label>
              <p class="field-note">Choose a site, dates, or both. Site includes subdomains. Removes only reviewed matching versions, including kept versions. Other versions remain; the newest remaining version becomes current if needed. Backups and future captures are unchanged.</p>
              <button id="manage-forget-preview" type="submit" class="secondary-button">Review versions</button>
            </form>
            <div id="manage-forget-confirmation" hidden><p id="manage-forget-review"></p><div class="button-row"><button id="manage-forget-confirm" class="secondary-button danger-text">Forget reviewed pages</button><button id="manage-forget-cancel" class="text-button">Cancel</button></div></div>
            <p id="manage-forget-status" class="status-line" role="status"></p>
          </details>
        </div></details>
        <details class="view-control" name="manage-controls"><summary>Maintenance${iconMarkup('caret-down')}</summary><div class="view-control-body">
          <label class="compact-setting"><span>Max pages</span><input id="manage-backfill-limit" type="number" min="1" max="500" value="50" /></label>
          <label class="check-setting"><span>Replace existing embeddings</span><input id="manage-backfill-force" type="checkbox" /></label>
          <label class="check-setting"><span>Create missing summaries after embeddings</span><input id="manage-backfill-summaries" type="checkbox" /></label>
          <label class="check-setting"><span>Regenerate existing summaries too</span><input id="manage-backfill-regenerate-summaries" type="checkbox" /></label>
          <p class="field-note">Applies to the whole library, up to the page limit. Fill missing preserves existing vectors. Re-embed replaces vectors only after a successful result.</p>
          <button type="button" id="manage-backfill-run" class="primary-button">Fill missing</button><button type="button" id="manage-backfill-stop" class="text-button" hidden>Stop</button>
          <p id="manage-backfill-status" class="status-line" role="status"></p>
        </div></details>
      </div>
      <p class="status-line" role="status" id="manage-status"></p>
      <div id="manage-library-recovery" hidden></div>
      <label id="manage-select-row" hidden><input type="checkbox" id="manage-select-all" aria-label="Select all visible pages" /> Select all visible</label>
      <div id="manage-rows" class="content-list"></div>
    </div>
  `;
  rootEl.querySelector('.wr-page')!.prepend(createBackLink());
  rootEl.querySelector('.manage-title')!.append(createStorageSettingsLink('storage', 'Backups'));
  rootEl.querySelector('#manage-library-recovery')!.append(createStorageSettingsLink('restore', 'Restore from backup'));
  const forgetForm = rootEl.querySelector<HTMLFormElement>('#manage-forget-form')!;
  const forgetStatus = rootEl.querySelector<HTMLElement>('#manage-forget-status')!;
  const confirmation = rootEl.querySelector<HTMLElement>('#manage-forget-confirmation')!;
  const previewButton = rootEl.querySelector<HTMLButtonElement>('#manage-forget-preview')!;
  const confirmButton = rootEl.querySelector<HTMLButtonElement>('#manage-forget-confirm')!;
  const cancelButton = rootEl.querySelector<HTMLButtonElement>('#manage-forget-cancel')!;
  let forgetRevision = 0, forgetting = false;
  let reviewed: { selection: SavedVersionSelection[]; filters: SearchFilters } | undefined;
  const resetReview = (): void => { if (forgetting) return; forgetRevision++; reviewed = undefined; confirmation.hidden = true; previewButton.disabled = false; forgetStatus.textContent = ''; };
  forgetForm.addEventListener('input', resetReview); forgetForm.addEventListener('change', resetReview);
  cancelButton.addEventListener('click', resetReview);
  forgetForm.addEventListener('submit', event => {
    event.preventDefault(); if (forgetting) return; resetReview();
    const revision = forgetRevision;
    const site = rootEl.querySelector<HTMLInputElement>('#manage-forget-site')!.value.trim();
    const from = rootEl.querySelector<HTMLInputElement>('#manage-forget-from')!.value;
    const through = rootEl.querySelector<HTMLInputElement>('#manage-forget-through')!.value;
    void (async () => {
      try {
        const filters = readSearchFilters({ domain: site, ...readCaptureDateRange(from, through) });
        if (!Object.keys(filters).length) throw new Error('Choose a site or capture date.');
        previewButton.disabled = true; forgetStatus.textContent = 'Reviewing saved versions…';
        const response = await sendRuntimeMessage<{ selection: SavedVersionSelection[]; versionCount: number }>({ type: 'PREVIEW_FORGET_PAGES', filters });
        if (revision !== forgetRevision) return;
        const selection = (response.selection || []).map(page => ({ url: page.url, versionIds: [...page.versionIds] }));
        const count = selection.reduce((total, page) => total + page.versionIds.length, 0);
        forgetStatus.textContent = count ? '' : 'No saved versions match this scope.';
        if (count) {
          reviewed = { selection, filters }; confirmation.hidden = false;
          rootEl.querySelector('#manage-forget-review')!.textContent = `${count} saved ${count === 1 ? 'version' : 'versions'} across ${selection.length} ${selection.length === 1 ? 'page' : 'pages'}${site ? ` on ${site} and its subdomains` : ''}${from ? ` captured from ${from}` : ''}${through ? ` through ${through}` : ''}. Only these matching versions will be removed, including kept versions. Others stay. This cannot be undone.`;
          confirmButton.textContent = `Forget ${count} ${count === 1 ? 'version' : 'versions'}`;
        }
      } catch (error) { if (revision === forgetRevision) forgetStatus.textContent = `Unable to review pages: ${error instanceof Error ? error.message : String(error)}`; }
      finally { if (revision === forgetRevision) previewButton.disabled = false; }
    })();
  });
  confirmButton.addEventListener('click', () => {
    if (!reviewed || forgetting) return;
    const selection = reviewed; forgetting = true; confirmButton.disabled = true; previewButton.disabled = true; cancelButton.disabled = true;
    for (const control of forgetForm.querySelectorAll('input')) control.disabled = true;
    void (async () => {
      try {
        forgetStatus.textContent = 'Forgetting reviewed versions…';
        const response = await sendRuntimeMessage<ForgetResult>({ type: 'FORGET_PAGES', ...selection });
        reviewed = undefined; confirmation.hidden = true;
        await Promise.all([fetchPages(), fetchQueue()]); window.dispatchEvent(new window.CustomEvent('wr-memory-changed'));
        forgetStatus.textContent = response.versions ? `Forgot ${response.versions} saved ${response.versions === 1 ? 'version' : 'versions'} across ${response.pages} ${response.pages === 1 ? 'page' : 'pages'}. Other versions were kept.` : 'No reviewed versions still match this scope.';
      } catch (error) { forgetStatus.textContent = `Forget failed: ${error instanceof Error ? error.message : String(error)}`; }
      finally { forgetting = false; confirmButton.disabled = false; previewButton.disabled = false; cancelButton.disabled = false; for (const control of forgetForm.querySelectorAll('input')) control.disabled = false; }
    })();
  });
  if (!document.querySelector('#beta-view-search')) rootEl.prepend(createToolNavigation('manage'));
  installSharedStyles(); rootEl.dataset.view = 'manage';
  document.getElementById('manage-select')?.addEventListener('click', () => {
    const rows = document.getElementById('manage-rows')!; const selecting = rows.classList.toggle('is-selecting');
    document.getElementById('manage-select-row')!.hidden = !selecting;
    document.getElementById('manage-delete')!.hidden = !selecting;
    document.getElementById('manage-select')!.textContent = selecting ? 'Done' : 'Select';
    if (!selecting) state.selected.clear(); sortAndRender();
  });
  document.getElementById('manage-sort')?.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement; const [key, order] = select.value.split('-'); state.sortKey = key as ManageState['sortKey']; state.sortAsc = order === 'asc';
    document.getElementById('manage-sort-label')!.textContent = select.selectedOptions[0]!.textContent;
    sortAndRender();
  });
  syncBackfillControls();
  rootEl.querySelector('#manage-backfill-stop')?.addEventListener('click', () => {
    if (!backfillRequestId) return;
    void sendRuntimeMessage({ type: 'CANCEL_BACKFILL', requestId: backfillRequestId })
      .catch((err) => updateStatus(`Unable to stop backfill: ${String(err)}`, true));
  });
  rootEl.querySelector('#manage-backfill-limit')?.addEventListener('input', syncBackfillControls);
  rootEl.querySelector('#manage-backfill-force')?.addEventListener('change', syncBackfillControls);
  rootEl.querySelector('#manage-backfill-regenerate-summaries')?.addEventListener('change', syncBackfillControls);

  document.getElementById('manage-refresh')?.addEventListener('click', () => fetchPages());
  document.getElementById('manage-search')?.addEventListener('input', () => applyFilters());
  document.getElementById('manage-filter-manual')?.addEventListener('change', () => applyFilters());
  document.getElementById('manage-delete')?.addEventListener('click', () => deletePages(Array.from(state.selected)));
  const transfers = createFileTransfers(updateStatus, rootEl.querySelector<HTMLButtonElement>('#manage-transfer-stop')!, [rootEl.querySelector<HTMLButtonElement>('#manage-portable-export')!]);
  rootEl.querySelector('#manage-export-pages')?.addEventListener('submit', event => {
    event.preventDefault();
    const scope = rootEl.querySelector<HTMLSelectElement>('#manage-export-scope')!.value;
    const format = rootEl.querySelector<HTMLSelectElement>('#manage-export-format')!.value === 'json' ? 'json' : 'markdown';
    const urls = scope === 'selected' ? [...state.selected] : scope === 'filtered' ? state.filtered.map(page => page.url) : undefined;
    if (urls?.length === 0) { updateStatus('No pages in the selected export scope.', true); return; }
    void transfers.save({ format, urls });
  });
  document.getElementById('manage-select-all')?.addEventListener('change', (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    const urls = state.filtered.map((page) => page.url);
    if (checked) {
      urls.forEach((url) => state.selected.add(url));
    } else {
      urls.forEach((url) => state.selected.delete(url));
    }
    sortAndRender();
  });
  document.getElementById('manage-backfill-run')?.addEventListener('click', () => {
    const limitInput = document.getElementById('manage-backfill-limit') as HTMLInputElement | null;
    const forceToggle = document.getElementById('manage-backfill-force') as HTMLInputElement | null;
    const status = document.getElementById('manage-backfill-status') as HTMLParagraphElement | null;
    const limit = limitInput ? Number(limitInput.value) : 50;
    const force = Boolean(forceToggle?.checked);
    if (status) status.textContent = 'Backfill running…';
    const summaries = rootEl.querySelector<HTMLInputElement>('#manage-backfill-summaries')?.checked === true;
    const regenerate = rootEl.querySelector<HTMLInputElement>('#manage-backfill-regenerate-summaries')?.checked === true;
    void runBackfill(Number.isFinite(limit) && limit > 0 ? limit : 50, force, undefined, summaries || regenerate, regenerate);
  });
}

export function mountManage(target: HTMLElement): void {
  window.addEventListener('wr-memory-changed', event => {
    if ((event as CustomEvent).detail === 'restore' && !target.hidden) void fetchPages();
  });
  target.addEventListener('wr-refresh', () => {
    void fetchPages();
    void fetchQueue();
  });
  renderApp(target);
  void initTheme();
  void fetchPages();
  void fetchQueue();
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.type === 'SUMMARY_UPDATED' && state.pages.some(page => page.url === message.url)) {
      void fetchPages();
    }
    if (message?.type === 'BACKFILL_PROGRESS' && message.requestId === backfillRequestId) {
      const url = String(message.url);
      const phase = message.phase === 'summaries' ? 'summaries' : 'embeddings';
      if (message.status === 'error') recordBackfillFailure({ url, phase, error: String(message.error || 'Try again') });
      const text = message.status === 'running' ? (phase === 'summaries' ? 'Summarizing…' : 'Embedding…') : message.status === 'complete' ? (phase === 'summaries' ? 'Summary ready' : 'Embeddings updated') : '';
      rowProgress.set(url, { ...rowProgress.get(url), text });
      const progress = document.querySelector<HTMLElement>('#manage-backfill-status');
      if (progress) progress.textContent = `${Number(message.completed)} of ${Number(message.total)} ${message.phase === 'summaries' ? 'summaries' : 'pages'} finished`;
      sortAndRender();
    }
    if (message?.type === 'CAPTURE_QUEUE_UPDATED' && !target.hidden) {
      void fetchPages();
      void fetchQueue();
    }
    if (message?.type === 'BETA_SETTINGS_UPDATED') {
      const theme = (message as { settings?: { theme?: ThemeChoice } }).settings?.theme;
      if (theme) applyTheme(theme);
    }
  });
  console.info('[beta-ui:manage] memory manager loaded');
}

if (root?.dataset.view === 'manage') mountManage(root);
