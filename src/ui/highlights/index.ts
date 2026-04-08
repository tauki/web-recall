import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';

const root = document.querySelector<HTMLElement>('#app-root');

type HighlightDate = {
  date: string;
  count: number;
};

type HighlightsState = {
  from?: string | null;
  to?: string | null;
  pageSize: number;
  offset: number;
  dates: HighlightDate[];
  total: number;
};

const state: HighlightsState = {
  from: null,
  to: null,
  pageSize: 14,
  offset: 0,
  dates: [],
  total: 0
};

function ensureStyles(): void {
  if (document.getElementById('beta-highlights-style')) return;
  const style = document.createElement('style');
  style.id = 'beta-highlights-style';
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
    .hl-shell {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .hl-toolbar {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .hl-toolbar input {
      padding: 6px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
    }
    .hl-cards {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .hl-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      background: var(--surface);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }
    .hl-card h3 {
      margin: 0 0 4px 0;
      font-size: 1rem;
      color: var(--text);
    }
    .hl-card p {
      margin: 0;
      color: var(--muted);
      white-space: pre-wrap;
    }
    .hl-pagination {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .hl-pagination button {
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      cursor: pointer;
      color: var(--text);
    }
    .status-line {
      min-height: 1.2em;
      font-size: 0.9rem;
      color: var(--muted);
    }
    a {
      color: var(--link);
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

function formatPretty(date: string): string {
  try {
    const dt = new Date(`${date}T00:00:00`);
    return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
  } catch {
    return date;
  }
}

function getInputValue(selector: string): string | null {
  const input = document.querySelector<HTMLInputElement>(selector);
  return input?.value || null;
}

function updateStatus(message: string): void {
  const status = document.querySelector<HTMLParagraphElement>('#highlight-status');
  if (status) status.textContent = message;
}

async function loadHighlights(): Promise<void> {
  try {
    updateStatus('Loading…');
    const response = await sendRuntimeMessage<{ dates: HighlightDate[]; total: number }>({
      type: 'LIST_HIGHLIGHT_DATES',
      from: state.from,
      to: state.to,
      offset: state.offset,
      limit: state.pageSize
    });
    state.dates = response.dates || [];
    state.total = response.total || 0;
    renderDates();
    updateStatus(state.total ? `Showing ${Math.min(state.total, state.offset + 1)}-${Math.min(state.total, state.offset + state.dates.length)} of ${state.total} days` : 'No highlights yet');
  } catch (err) {
    updateStatus(`Failed to load highlights: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchHighlight(date: string, target: HTMLElement): Promise<void> {
  try {
    target.textContent = 'Loading…';
    const response = await sendRuntimeMessage<{ highlight: { text: string; entries?: Array<{ title: string; url: string }> } }>({ type: 'GET_HIGHLIGHTS', date });
    const summary = response.highlight?.text || '(No highlight)';
    const entries = response.highlight?.entries || [];
    target.textContent = '';
    const summaryNode = document.createElement('p');
    summaryNode.style.margin = '0 0 6px 0';
    summaryNode.textContent = summary;
    target.appendChild(summaryNode);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No detailed entries yet.';
      target.appendChild(empty);
      return;
    }
    entries.forEach((entry, index) => {
      const row = document.createElement('div');
      const prefix = document.createTextNode(`${index + 1}. `);
      const link = document.createElement('a');
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = entry.title;
      row.append(prefix, link);
      target.appendChild(row);
    });
  } catch (err) {
    target.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function renderDates(): void {
  const list = document.querySelector<HTMLDivElement>('#highlight-list');
  const prevBtn = document.querySelector<HTMLButtonElement>('#highlight-prev');
  const nextBtn = document.querySelector<HTMLButtonElement>('#highlight-next');
  if (!list) return;
  list.innerHTML = '';
  state.dates.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'hl-card';
    const title = document.createElement('h3');
    title.textContent = `${formatPretty(item.date)} — ${item.count} capture${item.count === 1 ? '' : 's'}`;
    const body = document.createElement('div');
    body.textContent = 'Loading…';
    card.appendChild(title);
    card.appendChild(body);
    list.appendChild(card);
    void fetchHighlight(item.date, body);
  });
  if (prevBtn) prevBtn.disabled = state.offset <= 0;
  if (nextBtn) nextBtn.disabled = state.offset + state.dates.length >= state.total;
}

function renderApp(rootEl: HTMLElement): void {
  ensureStyles();
  rootEl.innerHTML = `
    <div class="hl-shell">
      <div>
        <h1>Daily Highlights</h1>
        <p class="status-line" id="highlight-status"></p>
      </div>
      <div class="hl-toolbar">
        <label>From <input type="date" id="highlight-from" /></label>
        <label>To <input type="date" id="highlight-to" /></label>
        <label>Page size <input type="number" id="highlight-size" value="14" min="1" max="50" /></label>
        <button id="highlight-apply">Apply</button>
      </div>
      <div class="hl-cards" id="highlight-list"></div>
      <div class="hl-pagination">
        <div>
          <button id="highlight-prev">Previous</button>
          <button id="highlight-next">Next</button>
        </div>
        <button id="highlight-refresh">Refresh</button>
      </div>
    </div>
  `;
  rootEl.dataset.view = 'highlights';

  document.getElementById('highlight-apply')?.addEventListener('click', () => {
    state.from = getInputValue('#highlight-from');
    state.to = getInputValue('#highlight-to');
    const size = Number(getInputValue('#highlight-size'));
    state.pageSize = Number.isFinite(size) ? Math.max(1, Math.min(50, size)) : 14;
    state.offset = 0;
    void loadHighlights();
  });
  document.getElementById('highlight-prev')?.addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.pageSize);
    void loadHighlights();
  });
  document.getElementById('highlight-next')?.addEventListener('click', () => {
    state.offset = state.offset + state.pageSize;
    void loadHighlights();
  });
  document.getElementById('highlight-refresh')?.addEventListener('click', () => {
    void loadHighlights();
  });
}

if (root) {
  void initTheme().then(() => {
    renderApp(root);
    void loadHighlights();
  });
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.type === 'BETA_SETTINGS_UPDATED') {
      const theme = (message as { settings?: { theme?: ThemeChoice } }).settings?.theme;
      if (theme) applyTheme(theme);
    }
  });
  console.info('[beta-ui:highlights] highlights dashboard ready');
} else {
  console.error('[beta-ui:highlights] #app-root not found');
}
