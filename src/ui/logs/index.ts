import { startPolling } from '../shared/polling';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';

const root = document.querySelector<HTMLElement>('#app-root');

type LogEntry = {
  level: 'info' | 'warn' | 'error' | string;
  message: string;
  data?: Record<string, unknown>;
  createdAt?: number;
};

type LogsState = {
  entries: LogEntry[];
  filters: {
    level: string;
    text: string;
  };
  autoRefresh: boolean;
};

const state: LogsState = {
  entries: [],
  filters: { level: 'all', text: '' },
  autoRefresh: true
};

const LEVEL_ORDER: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function ensureStyles(): void {
  if (document.getElementById('beta-logs-style')) return;
  const style = document.createElement('style');
  style.id = 'beta-logs-style';
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
    .logs-shell {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .logs-toolbar, .logs-filters {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .logs-filters input[type='search'] {
      min-width: 240px;
      padding: 6px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
    }
    .logs-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 70vh;
      overflow-y: auto;
    }
    .log-entry {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      background: var(--surface);
    }
    .log-entry h3 {
      margin: 0 0 4px 0;
      font-size: 0.95rem;
      color: var(--text);
    }
    .log-entry pre {
      margin: 6px 0 0 0;
      background: var(--surface-muted);
      border-radius: 6px;
      padding: 6px;
      font-size: 0.85rem;
      overflow-x: auto;
      color: var(--text);
    }
    .status-line {
      min-height: 1em;
      font-size: 0.85rem;
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

function formatTimestamp(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function applyFilters(entries: LogEntry[]): LogEntry[] {
  const levelThreshold = state.filters.level === 'all' ? 0 : LEVEL_ORDER[state.filters.level] ?? 0;
  const tokens = state.filters.text
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return entries.filter((entry) => {
    const lvl = LEVEL_ORDER[entry.level] ?? 0;
    if (lvl < levelThreshold) return false;
    const blob = JSON.stringify(entry).toLowerCase();
    if (tokens.length && !tokens.every((token) => blob.includes(token))) {
      return false;
    }
    return true;
  });
}

function renderLogs(): void {
  const list = document.querySelector<HTMLDivElement>('#logs-list');
  if (!list) return;
  const filtered = applyFilters(state.entries);
  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = '<p>No logs.</p>';
    return;
  }
  filtered
    .slice()
    .reverse()
    .forEach((entry) => {
      const card = document.createElement('article');
      card.className = 'log-entry';
      const header = document.createElement('h3');
      header.textContent = `[${entry.level}] ${formatTimestamp(entry.createdAt)} — ${entry.message}`;
      const meta = document.createElement('pre');
      meta.textContent = entry.data ? JSON.stringify(entry.data, null, 2) : 'No metadata';
      card.appendChild(header);
      card.appendChild(meta);
      list.appendChild(card);
    });
}

async function refreshLogs(): Promise<void> {
  try {
    const response = await sendRuntimeMessage<{ logs: LogEntry[] }>({ type: 'GET_LOGS' });
    state.entries = response.logs || [];
    renderLogs();
    updateStatus(`Loaded ${state.entries.length} entries`);
  } catch (err) {
    updateStatus(`Failed to load logs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function clearLogs(): Promise<void> {
  try {
    await sendRuntimeMessage<{ ok: boolean }>({ type: 'CLEAR_LOGS' });
    state.entries = [];
    renderLogs();
    updateStatus('Logs cleared');
  } catch (err) {
    updateStatus(`Failed to clear logs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function updateStatus(message: string): void {
  const status = document.querySelector<HTMLParagraphElement>('#logs-status');
  if (status) status.textContent = message;
}

function renderApp(rootEl: HTMLElement): void {
  ensureStyles();
  rootEl.innerHTML = `
    <div class="logs-shell">
      <div>
        <h1>Structured Logs</h1>
        <p class="status-line" id="logs-status"></p>
      </div>
      <div class="logs-toolbar">
        <button id="logs-refresh">Refresh</button>
        <button id="logs-clear">Clear Logs</button>
        <label><input type="checkbox" id="logs-auto" checked /> Auto-refresh</label>
      </div>
      <div class="logs-filters">
        <label>Level
          <select id="logs-level">
            <option value="all">All</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </label>
        <input type="search" id="logs-text" placeholder="Filter text" />
      </div>
      <div class="logs-list" id="logs-list"></div>
    </div>
  `;
  rootEl.dataset.view = 'logs';

  document.getElementById('logs-refresh')?.addEventListener('click', () => void refreshLogs());
  document.getElementById('logs-clear')?.addEventListener('click', () => void clearLogs());
  document.getElementById('logs-auto')?.addEventListener('change', (event) => {
    state.autoRefresh = (event.target as HTMLInputElement).checked;
  });
  document.getElementById('logs-level')?.addEventListener('change', (event) => {
    state.filters.level = (event.target as HTMLSelectElement).value;
    renderLogs();
  });
  document.getElementById('logs-text')?.addEventListener('input', (event) => {
    state.filters.text = (event.target as HTMLInputElement).value;
    renderLogs();
  });
}

if (root) {
  void initTheme().then(() => {
    renderApp(root);
    startPolling(() => {
      if (state.autoRefresh) void refreshLogs();
    }, 2000);
  });
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.type === 'BETA_SETTINGS_UPDATED') {
      const theme = (message as { settings?: { theme?: ThemeChoice } }).settings?.theme;
      if (theme) applyTheme(theme);
    }
  });
  console.info('[beta-ui:logs] logs viewer ready');
} else {
  console.error('[beta-ui:logs] #app-root not found');
}
