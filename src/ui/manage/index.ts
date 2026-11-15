import { installSharedStyles, createToolNavigation, createBackLink, iconMarkup, createPageEntry, navigateTo, appUrl } from '../shared/presentation';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';
import { BACKUP_HEADER, readBackupPages } from '../../shared/backup';

const root = document.querySelector<HTMLElement>('#app-root');

type ManagePage = {
  url: string;
  title: string;
  timestamp: number;
  manual: boolean;
  hasEmbeddings?: boolean;
  embeddingStatus?: string;
  chunkCount?: number;
  lastEmbeddedAt?: number;
};

type QueueEntry = {
  url: string;
  title: string;
  status: string;
  attempts: number;
  updatedAt?: number;
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
const rowProgress = new Map<string, { text: string; error?: boolean }>();

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
let transferInProgress = false;

function setTransferBusy(busy: boolean): void {
  transferInProgress = busy;
  for (const id of ['manage-export', 'manage-import']) {
    const control = document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
    if (control) control.disabled = busy;
  }
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
    for (const [name, value] of [['Captured', formatDate(page.timestamp)], ['Capture', page.manual ? 'Manual' : 'Automatic'], ['Embeddings', `${embedStatus} · ${page.chunkCount || 0} ${page.chunkCount === 1 ? 'chunk' : 'chunks'}`], ['Last embedded', page.lastEmbeddedAt ? formatDate(page.lastEmbeddedAt) : 'Not embedded'], ['URL', page.url]]) {
      const row = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = name || ''; const dd = document.createElement('dd'); dd.textContent = value || ''; row.append(dt, dd); facts.append(row);
    }
    body.append(facts);
    const progress = rowProgress.get(page.url);
    if (progress) { const line = document.createElement('span'); line.className = 'wr-row-progress'; line.textContent = progress.text; if (progress.error) line.dataset.variant = 'error'; body.append(line); }
    const actions = document.createElement('div'); actions.className = 'content-entry-actions';
    const preview = document.createElement('a'); preview.href = appUrl('sidepanel') + '#page=' + encodeURIComponent(page.url); preview.className = 'primary-button'; preview.textContent = 'Preview & ask';
    preview.addEventListener('click', event => { if (navigateTo('sidepanel', page.url)) event.preventDefault(); });
    const original = document.createElement('a'); original.href = page.url; original.target = '_blank'; original.rel = 'noreferrer'; original.className = 'text-button'; original.textContent = 'Open page';
    const reembed = document.createElement('button'); reembed.className = 'text-button'; reembed.textContent = 'Re-embed'; reembed.setAttribute('aria-label', `Re-embed ${page.title || page.url}`); reembed.disabled = Boolean(backfillRequestId); reembed.addEventListener('click', () => { void runBackfill(1, true, [page.url]); });
    const del = document.createElement('button'); del.className = 'text-button danger-text'; del.textContent = 'Delete'; del.disabled = Boolean(backfillRequestId); del.setAttribute('aria-label', `Delete ${page.title || page.url}`); del.addEventListener('click', () => { void deletePages([page.url]); });
    actions.append(preview, original, reembed, del); body.append(actions); list.append(article);
  }
  if (!rows.length) { const p = document.createElement('p'); p.className = 'empty-tool-state'; p.textContent = state.pages.length ? 'No pages match. Try another search or clear your filters.' : 'No saved pages yet. Capture a page or import a backup from Tools.'; list.append(p); }
  const count = document.querySelector('#manage-count'); if (count) count.textContent = `${rows.length} ${rows.length === 1 ? 'page' : 'pages'}`;
  updateDeleteButton();
  const queue = document.querySelector('#manage-queue');
  if (queue) {
    queue.replaceChildren();
    if (!state.queue.length) queue.textContent = 'No pending captures.';
    for (const entry of state.queue) {
      const row = document.createElement('div'); row.className = 'queue-entry';
      const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = entry.title || entry.url;
      const meta = document.createElement('small'); meta.textContent = `${entry.status} · ${entry.attempts} attempts${entry.updatedAt ? ` · ${formatDate(entry.updatedAt)}` : ''}`; copy.append(title, meta);
      const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.className = 'secondary-button'; retry.disabled = entry.status === 'queued'; retry.addEventListener('click', () => { void retryQueueEntry(entry.url); }); row.append(copy, retry); queue.append(row);
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

async function fetchPages(): Promise<void> {
  try {
    updateStatus('Loading pages…');
    const response = await sendRuntimeMessage<{ pages: ManagePage[] }>({ type: 'GET_PAGE_LIST' });
    state.pages = response.pages || [];
    state.selected = new Set([...state.selected].filter(url => state.pages.some(page => page.url === url)));
    applyFilters();
    updateStatus('');
  } catch (err) {
    updateStatus(`Failed to load pages: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function fetchQueue(): Promise<void> {
  try {
    const response = await sendRuntimeMessage<{ queue: QueueEntry[] }>({ type: 'GET_PROCESSING' });
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

async function handleExport(): Promise<void> {
  if (transferInProgress) return;
  setTransferBusy(true);
  let writer: FileSystemWritableFileStream | undefined;
  try {
    const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (!picker) throw new Error('This browser does not support streaming backup saves. Use Chrome on desktop.');
    const file = await picker.call(window, { suggestedName: 'web-recall-backup.jsonl', types: [{ description: 'Web Recall backup', accept: { 'application/x-ndjson': ['.jsonl'] } }] });
    writer = await file.createWritable();
    await writer.write(BACKUP_HEADER);
    let afterUrl: string | undefined;
    let count = 0;
    while (true) {
      const response = await sendRuntimeMessage<{ line?: string; url?: string }>({ type: 'GET_BACKUP_PAGE', afterUrl });
      if (!response.line) break;
      if (!response.url || (afterUrl !== undefined && response.url <= afterUrl)) throw new Error('Backup cursor did not advance.');
      await writer.write(response.line + '\n');
      afterUrl = response.url;
      updateStatus(`Exporting… ${++count} pages`);
    }
    await writer.write(JSON.stringify({ type: 'end', pages: count }) + '\n');
    await writer.close();
    writer = undefined;
    updateStatus(`Export complete: ${count} pages`);
  } catch (err) {
    await writer?.abort().catch(() => {});
    updateStatus(err instanceof Error && err.name === 'AbortError' ? 'Export cancelled' : `Export failed: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    setTransferBusy(false);
  }
}

async function handleImport(file: File): Promise<void> {
  if (transferInProgress) return;
  setTransferBusy(true);
  let imported = 0;
  try {
    if (/\.(jsonl|ndjson)$/i.test(file.name)) {
      let total = 0;
      updateStatus('Validating backup…');
      for await (const line of readBackupPages(file.stream())) {
        if (line) total++;
      }
      for await (const line of readBackupPages(file.stream())) {
        await sendRuntimeMessage({ type: 'IMPORT_BACKUP_PAGE', line });
        updateStatus(`Importing… ${++imported} of ${total} pages`);
      }
      await fetchPages();
      updateStatus(`Import complete: ${imported} pages`);
      return;
    }
    if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Legacy JSON file exceeds 10 MB. Use a streaming .jsonl backup for larger libraries.');
    const text = await file.text();
    const parsed = JSON.parse(text);
    let pages: unknown[] = [];
    let schemaVersion: number | undefined;
    if (Array.isArray(parsed)) {
      pages = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.pages)) {
      pages = parsed.pages;
      schemaVersion =
        typeof (parsed as { schemaVersion?: unknown }).schemaVersion === 'number'
          ? (parsed as { schemaVersion: number }).schemaVersion
          : undefined;
    } else {
      throw new Error('Invalid schema: expected array or { pages: [] }');
    }
    updateStatus('Importing…');
    await sendRuntimeMessage<{ imported: number }>({ type: 'IMPORT_PAGES', pages, schemaVersion });
    await fetchPages();
    updateStatus('Import complete');
  } catch (err) {
    updateStatus(`Import failed${imported ? ` after ${imported} pages` : ''}: ${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    setTransferBusy(false);
    window.dispatchEvent(new window.CustomEvent('wr-memory-changed'));
  }
}

async function runBackfill(limit: number, force: boolean, urls?: string[]): Promise<boolean> {
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
      result?: { processed: number; updated: number; failed?: number; updatedUrls?: string[] };
      error?: string;
    }>({
      type: 'BACKFILL_EMBEDDINGS',
      requestId,
      limit,
      force,
      urls
    });
    if ((response as { error?: string }).error) {
      throw new Error((response as { error?: string }).error || 'Backfill failed');
    }
    const result =
      (response as { result?: { processed: number; updated: number; failed?: number; updatedUrls?: string[] } }).result || {
        processed: 0,
        updated: 0,
        updatedUrls: []
      };
    const updatedUrls = Array.isArray(result.updatedUrls) ? result.updatedUrls : [];
    const suffix = updatedUrls.length ? ` (${updatedUrls.length} page(s))` : '';
    await fetchPages();
    showStatus(`Backfill complete: processed ${result.processed}, updated ${result.updated}, failed ${result.failed || 0}${suffix}`, Boolean(result.failed));
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
  run.textContent = backfillRequestId ? 'Working…' : `${force.checked ? 'Re-embed' : 'Fill missing'} (up to ${count} pages)`;
  run.disabled = force.disabled = limit.disabled = Boolean(backfillRequestId);
}

function renderApp(rootEl: HTMLElement): void {
  ensureStyles();
  rootEl.innerHTML = `
    <div class="manage-shell wr-page">
      <h1>Memory Manager</h1>
      <div class="search-form">${iconMarkup('magnifying-glass')}<input type="search" id="manage-search" placeholder="Find a saved page" aria-label="Search memory by title or domain" /></div>
      <div class="view-toolbar"><span id="manage-count" role="status">Loading…</span><div class="manage-actions"><button type="button" id="manage-delete" class="text-button danger-text" hidden disabled>Delete selected</button><button type="button" id="manage-select" class="text-button">Select</button></div></div>
      <div class="view-controls">
        <details class="view-control" name="manage-controls"><summary><span id="manage-sort-label">Recent first</span>${iconMarkup('caret-down')}</summary><div class="view-control-body">
          <label class="compact-setting">Sort pages<select id="manage-sort" aria-label="Sort memory"><option value="date-desc">Recent first</option><option value="date-asc">Oldest first</option><option value="title-asc">Title A–Z</option><option value="title-desc">Title Z–A</option><option value="url-asc">URL A–Z</option><option value="url-desc">URL Z–A</option></select></label>
          <label class="check-setting"><span>Manual captures only</span><input type="checkbox" id="manage-filter-manual" /></label>
        </div></details>
        <details class="view-control" name="manage-controls"><summary>Tools${iconMarkup('caret-down')}</summary><div class="view-control-body">
          <div class="maintenance-heading"><span>Memory tools</span><button id="manage-refresh" class="text-button">Refresh</button></div>
          <details class="tool-disclosure"><summary>Backup & restore${iconMarkup('caret-down')}</summary><div class="tool-disclosure-body button-row"><button id="manage-export" class="secondary-button">Export backup</button><label id="manage-import-label" class="secondary-button">Import backup or JSON<input type="file" id="manage-import" accept=".json,.jsonl,.ndjson,application/json,application/x-ndjson" /></label></div></details>
          <details class="tool-disclosure"><summary>Capture queue${iconMarkup('caret-down')}</summary><div id="manage-queue" class="wr-help">No pending captures.</div></details>
          <details class="tool-disclosure"><summary>Embeddings${iconMarkup('caret-down')}</summary><div class="embedding-tools">
            <label class="compact-setting"><span>Max pages</span><input id="manage-backfill-limit" type="number" min="1" max="500" value="50" /></label>
            <label class="check-setting"><span>Replace existing embeddings</span><input id="manage-backfill-force" type="checkbox" /></label>
            <p class="field-note">Applies to the whole library, up to the page limit. Fill missing preserves existing vectors. Re-embed replaces vectors only after a successful result.</p>
            <button type="button" id="manage-backfill-run" class="primary-button">Fill missing</button><button type="button" id="manage-backfill-stop" class="text-button" hidden>Stop</button>
            <p id="manage-backfill-status" class="status-line" role="status"></p>
          </div></details>
        </div></details>
      </div>
      <p class="status-line" role="status" id="manage-status"></p>
      <label id="manage-select-row" hidden><input type="checkbox" id="manage-select-all" aria-label="Select all visible pages" /> Select all visible</label>
      <div id="manage-rows" class="content-list"></div>
    </div>
  `;
  rootEl.querySelector('.wr-page')!.prepend(createBackLink());
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

  document.getElementById('manage-refresh')?.addEventListener('click', () => fetchPages());
  document.getElementById('manage-search')?.addEventListener('input', () => applyFilters());
  document.getElementById('manage-filter-manual')?.addEventListener('change', () => applyFilters());
  document.getElementById('manage-delete')?.addEventListener('click', () => deletePages(Array.from(state.selected)));
  document.getElementById('manage-export')?.addEventListener('click', () => void handleExport());
  document.getElementById('manage-import')?.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void handleImport(file);
      input.value = '';
    }
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
    void runBackfill(Number.isFinite(limit) && limit > 0 ? limit : 50, force);
  });
}

export function mountManage(target: HTMLElement): void {
  target.addEventListener('wr-refresh', () => {
    void fetchPages();
    void fetchQueue();
  });
  renderApp(target);
  void initTheme();
  void fetchPages();
  void fetchQueue();
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.type === 'BACKFILL_PROGRESS' && message.requestId === backfillRequestId) {
      const text = message.status === 'running' ? 'Embedding…' : message.status === 'complete' ? 'Updated' : `Failed: ${String(message.error || 'Try again')}`;
      rowProgress.set(String(message.url), { text, error: message.status === 'error' });
      const progress = document.querySelector<HTMLElement>('#manage-backfill-status');
      if (progress) progress.textContent = `${Number(message.completed)} of ${Number(message.total)} pages finished`;
      sortAndRender();
    }
    if (message?.type === 'CAPTURE_QUEUE_UPDATED') {
      state.queue = Array.isArray(message.queue) ? (message.queue as QueueEntry[]) : [];
      sortAndRender();
    }
    if (message?.type === 'BETA_SETTINGS_UPDATED') {
      const theme = (message as { settings?: { theme?: ThemeChoice } }).settings?.theme;
      if (theme) applyTheme(theme);
    }
  });
  console.info('[beta-ui:manage] memory manager loaded');
}

if (root?.dataset.view === 'manage') mountManage(root);
