import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';

const root = document.querySelector<HTMLElement>('#app-root');

type ManagePage = {
  url: string;
  title: string;
  timestamp: number;
  manual: boolean;
  hasEmbeddings?: boolean;
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

function ensureStyles(): void {
  if (document.getElementById('beta-manage-style')) return;
  const style = document.createElement('style');
  style.id = 'beta-manage-style';
  style.textContent = `
    :root {
      --bg: #f5f5f7;
      --surface: #ffffff;
      --surface-muted: #f1f5f9;
      --border: #d1d5db;
      --text: #0f172a;
      --muted: #4b5563;
      --accent: #4f46e5;
      --accent-contrast: #ffffff;
      --link: #2563eb;
    }
    :root[data-theme="dark"] {
      --bg: #0a0f1a;
      --surface: #0f172a;
      --surface-muted: #0b1220;
      --border: #1e293b;
      --text: #e2e8f0;
      --muted: #cbd5e1;
      --accent: #8b5cf6;
      --accent-contrast: #0b1020;
      --link: #a5b4fc;
    }
    body {
      background: var(--bg);
      color: var(--text);
    }
    .manage-shell {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .manage-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .manage-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .manage-actions button,
    .manage-actions label {
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      cursor: pointer;
      font-weight: 600;
      color: var(--text);
    }
    .manage-actions button.primary {
      background: var(--accent);
      color: var(--accent-contrast);
      border-color: var(--accent);
    }
    .manage-actions input[type='file'] {
      display: none;
    }
    .manage-toolbar {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .manage-toolbar input[type='search'] {
      flex: 1;
      min-width: 220px;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      color: var(--text);
    }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    th button {
      border: none;
      background: transparent;
      font-weight: 600;
      cursor: pointer;
      color: var(--text);
    }
    tr:hover {
      background: var(--surface-muted);
    }
    a {
      color: var(--link);
    }
    .status-line {
      min-height: 1.2em;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .danger {
      color: #b91c1c;
    }
  `;
  document.head.appendChild(style);
}

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
    return new Date(timestamp).toLocaleString();
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
  const tbody = document.querySelector<HTMLTableSectionElement>('#manage-rows');
  const deleteBtn = document.querySelector<HTMLButtonElement>('#manage-delete');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const page of rows) {
    const tr = document.createElement('tr');
    const tdCheckbox = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.url = page.url;
    checkbox.checked = state.selected.has(page.url);
    checkbox.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      const url = target.dataset.url;
      if (!url) return;
      if (target.checked) state.selected.add(url);
      else state.selected.delete(url);
      updateDeleteButton();
    });
    tdCheckbox.appendChild(checkbox);
    const tdTitle = document.createElement('td');
    const link = document.createElement('a');
    link.href = page.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = page.title;
    tdTitle.appendChild(link);
    const tdUrl = document.createElement('td');
    tdUrl.textContent = page.url;
    const tdDate = document.createElement('td');
    tdDate.textContent = formatDate(page.timestamp);
    const tdEmbeds = document.createElement('td');
    const embedStatus = page.hasEmbeddings ? 'Present' : 'Missing';
    const embedDetails = [];
    if (typeof page.chunkCount === 'number') embedDetails.push(`${page.chunkCount} chunks`);
    if (typeof page.lastEmbeddedAt === 'number') embedDetails.push(`at ${formatDate(page.lastEmbeddedAt)}`);
    tdEmbeds.textContent = `${embedStatus}${embedDetails.length ? ` (${embedDetails.join(', ')})` : ''}`;
    const tdActions = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deletePages([page.url]));
    const reembedBtn = document.createElement('button');
    reembedBtn.textContent = 'Re-embed';
    reembedBtn.style.marginLeft = '6px';
    reembedBtn.addEventListener('click', () => {
      void runBackfill(1, true, [page.url]);
    });
    tdActions.appendChild(delBtn);
    tdActions.appendChild(reembedBtn);
    tr.appendChild(tdCheckbox);
    tr.appendChild(tdTitle);
    tr.appendChild(tdUrl);
    tr.appendChild(tdDate);
    tr.appendChild(tdEmbeds);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
  if (deleteBtn) {
    deleteBtn.disabled = state.selected.size === 0;
  }

  const queueView = document.querySelector<HTMLDivElement>('#manage-queue');
  if (queueView) {
    if (!state.queue.length) {
      queueView.innerHTML = '<p>No pending captures.</p>';
    } else {
      queueView.textContent = '';
      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      ['Status', 'Title', 'Attempts', 'Updated', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.setAttribute('align', 'left');
        th.textContent = label;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      const body = document.createElement('tbody');
      state.queue.slice(0, 10).forEach((entry) => {
        const tr = document.createElement('tr');
        const statusCell = document.createElement('td');
        statusCell.textContent = entry.status;
        const titleCell = document.createElement('td');
        titleCell.textContent = entry.title || entry.url;
        const attemptsCell = document.createElement('td');
        attemptsCell.textContent = String(entry.attempts);
        const updatedCell = document.createElement('td');
        updatedCell.textContent = entry.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString() : '';
        const actionsCell = document.createElement('td');
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => {
          void retryQueueEntry(entry.url);
        });
        actionsCell.appendChild(retryBtn);
        tr.append(statusCell, titleCell, attemptsCell, updatedCell, actionsCell);
        body.appendChild(tr);
      });
      table.append(thead, body);
      queueView.appendChild(table);
    }
  }
}

function updateDeleteButton(): void {
  const deleteBtn = document.querySelector<HTMLButtonElement>('#manage-delete');
  if (deleteBtn) {
    deleteBtn.disabled = state.selected.size === 0;
  }
}

async function fetchPages(): Promise<void> {
  try {
    updateStatus('Loading pages…');
    const response = await sendRuntimeMessage<{ pages: ManagePage[] }>({ type: 'GET_PAGE_LIST' });
    state.pages = response.pages || [];
    state.selected.clear();
    applyFilters();
    updateStatus(`Loaded ${state.pages.length} page(s)`);
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
  try {
    updateStatus('Preparing export…');
    const response = await sendRuntimeMessage<{ pages: unknown[] }>({ type: 'GET_ALL_PAGES' });
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      pages: response.pages || []
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'web-recall-export.json';
    link.click();
    URL.revokeObjectURL(url);
    updateStatus('Export ready');
  } catch (err) {
    updateStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function handleImport(file: File): Promise<void> {
  const text = await file.text();
  try {
    const parsed = JSON.parse(text);
    let pages: unknown[] = [];
    if (Array.isArray(parsed)) {
      pages = parsed;
    } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.pages)) {
      pages = parsed.pages;
    } else {
      throw new Error('Invalid schema: expected array or { pages: [] }');
    }
    updateStatus('Importing…');
    await sendRuntimeMessage<{ imported: number }>({ type: 'IMPORT_PAGES', pages });
    updateStatus('Import complete');
    await fetchPages();
  } catch (err) {
    updateStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

async function runBackfill(limit: number, force: boolean, urls?: string[]): Promise<boolean> {
  try {
    updateStatus('Backfill running…');
    const response = await sendRuntimeMessage<{
      result?: { processed: number; updated: number; updatedUrls?: string[] };
      error?: string;
    }>({
      type: 'BACKFILL_EMBEDDINGS',
      limit,
      force,
      urls
    });
    if ((response as { error?: string }).error) {
      throw new Error((response as { error?: string }).error || 'Backfill failed');
    }
    const result =
      (response as { result?: { processed: number; updated: number; updatedUrls?: string[] } }).result || {
        processed: 0,
        updated: 0,
        updatedUrls: []
      };
    const updatedUrls = Array.isArray(result.updatedUrls) ? result.updatedUrls : [];
    const suffix = updatedUrls.length ? ` (${updatedUrls.length} page(s))` : '';
    updateStatus(`Backfill complete: processed ${result.processed}, updated ${result.updated}${suffix}`);
    await fetchPages();
    return true;
  } catch (err) {
    updateStatus(`Backfill failed: ${err instanceof Error ? err.message : String(err)}`, true);
    return false;
  }
}

function renderApp(rootEl: HTMLElement): void {
  ensureStyles();
  rootEl.innerHTML = `
    <div class="manage-shell">
      <div class="manage-header">
        <div>
          <h1>Memory Manager</h1>
          <p class="status-line" id="manage-status"></p>
        </div>
        <div class="manage-actions">
          <button id="manage-refresh" class="primary">Refresh</button>
          <button id="manage-delete" disabled>Delete Selected</button>
          <button id="manage-export">Export JSON</button>
          <label id="manage-import-label">Import JSON<input type="file" id="manage-import" accept="application/json" /></label>
        </div>
      </div>
      <div class="manage-toolbar">
        <input type="search" id="manage-search" placeholder="Search title or domain" />
        <label><input type="checkbox" id="manage-filter-manual" /> Manual captures only</label>
      </div>
      <section class="manage-queue" aria-live="polite">
        <h2>Capture queue</h2>
        <div id="manage-queue"><p>No pending captures.</p></div>
      </section>
      <section class="manage-queue" aria-live="polite">
        <h2>Embeddings</h2>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
          <label for="manage-backfill-limit">Max pages</label>
          <input id="manage-backfill-limit" type="number" min="1" max="500" value="50" style="width:100px;" />
          <label style="display:flex; gap:4px; align-items:center;">
            <input id="manage-backfill-force" type="checkbox" /> Force re-embed all
          </label>
          <button type="button" id="manage-backfill-run">Backfill missing</button>
        </div>
        <p id="manage-backfill-status" class="status-line"></p>
      </section>
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" id="manage-select-all" /></th>
            <th><button type="button" data-sort="title">Title</button></th>
            <th><button type="button" data-sort="url">URL</button></th>
            <th><button type="button" data-sort="date">Captured</button></th>
            <th>Embeddings</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="manage-rows"></tbody>
      </table>
    </div>
  `;

  rootEl.dataset.view = 'manage';

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
  document.querySelectorAll<HTMLButtonElement>('th button[data-sort]')?.forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort as 'title' | 'url' | 'date';
      if (state.sortKey === key) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortKey = key;
        state.sortAsc = key !== 'date';
      }
      sortAndRender();
    });
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

if (root) {
  void initTheme().then(() => {
    renderApp(root);
    void fetchPages();
    void fetchQueue();
  });
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
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
} else {
  console.error('[beta-ui:manage] #app-root not found');
}
