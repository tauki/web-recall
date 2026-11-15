import { installSharedStyles, createToolNavigation, createBackLink, createPageEntry, iconMarkup, navigateTo, appUrl } from '../shared/presentation';
import { startPolling } from '../shared/polling';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';

type LogEntry = { id?: number; level: string; message: string; data?: Record<string, unknown>; createdAt?: number };
const state = { entries: [] as LogEntry[], level: 'all', text: '', autoRefresh: true };

function updateStatus(message: string, error = false): void {
  const status = document.querySelector<HTMLElement>('#logs-status');
  if (status) { status.textContent = message; status.dataset.variant = error ? 'error' : 'info'; }
}

function renderLogs(): void {
  const tokens = state.text.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = state.entries.filter(entry => (state.level === 'all' || entry.level === state.level) && tokens.every(token => JSON.stringify(entry).toLowerCase().includes(token)));
  const list = document.getElementById('logs-list')!;
  const open = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>('details[open]')).map(item => item.dataset.key));
  list.replaceChildren();
  for (const entry of filtered.slice().reverse()) {
    const row = createPageEntry({ url: '', title: entry.message });
    row.details.classList.add('log-entry'); row.details.name = 'log-entry';
    row.details.dataset.key = String(entry.id ?? `${entry.createdAt}:${entry.level}:${entry.message}`);
    row.details.open = open.has(row.details.dataset.key);
    const meta = document.createElement('span'); meta.className = 'source-meta';
    const level = document.createElement('span'); level.className = `log-level level-${entry.level}`; level.textContent = entry.level;
    const time = document.createElement('time'); time.textContent = entry.createdAt ? new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    meta.append(level, time); row.summary.firstElementChild!.replaceWith(meta);
    const heading = document.createElement('h2'); heading.textContent = 'Metadata';
    const code = document.createElement('pre'); code.textContent = entry.data ? JSON.stringify(entry.data, null, 2) : 'No metadata'; row.body.append(heading, code);
    list.append(row.article);
  }
  if (!filtered.length) { const p = document.createElement('p'); p.className = 'empty-tool-state'; p.textContent = state.entries.length ? 'No matching entries. Try another search or level.' : 'No logs yet. New runtime entries will appear here.'; list.append(p); }
  document.getElementById('logs-count')!.textContent = `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}${filtered.length !== state.entries.length ? ` of ${state.entries.length}` : ''}`;
  updateStatus(`Showing ${filtered.length} of ${state.entries.length} entries`);
}

async function refreshLogs(): Promise<void> {
  try {
    const response = await sendRuntimeMessage<{ logs: LogEntry[] }>({ type: 'GET_LOGS' });
    const entries = response.logs || [];
    if (JSON.stringify(entries) !== JSON.stringify(state.entries) || !document.querySelector('#logs-list')?.children.length) { state.entries = entries; renderLogs(); }
    else updateStatus('');
  } catch (error) { updateStatus(`Failed to load logs: ${error instanceof Error ? error.message : String(error)}`, true); }
}

export function mountLogs(target: HTMLElement): void {
  installSharedStyles();
  target.innerHTML = `<div class="wr-page">
    <h1>Structured Logs</h1>
    <div class="search-form">${iconMarkup('magnifying-glass')}<input type="search" id="logs-text" placeholder="Find in logs" aria-label="Filter logs by text" /><button id="logs-search-clear" type="button" class="icon-button" aria-label="Clear log search" hidden>${iconMarkup('x')}</button></div>
    <div class="view-toolbar"><span id="logs-count" role="status">Loading…</span><span id="logs-auto-label" class="toolbar-note">Auto-refresh on</span></div>
    <div class="view-controls">
      <details class="view-control" name="log-controls"><summary><span id="logs-level-label">All levels</span>${iconMarkup('caret-down')}</summary><div class="view-control-body"><label class="compact-setting"><span>Exact level</span><select id="logs-level"><option value="all">All</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option></select></label></div></details>
      <details class="view-control" name="log-controls"><summary>Tools${iconMarkup('caret-down')}</summary><div class="view-control-body">
        <label class="check-setting"><span>Auto-refresh</span><input id="logs-auto" type="checkbox" checked /></label>
        <div class="button-row log-tool-actions"><button id="logs-refresh" class="secondary-button">Refresh</button><button id="logs-clear" class="text-button danger-text">Clear Logs</button></div>
        <a id="logs-settings-link" class="text-button log-settings-link">Change which logs are captured in Settings${iconMarkup('arrow-up-right')}</a>
      </div></details>
    </div>
    <p id="logs-status" class="status-line wr-visually-hidden" role="status"></p>
    <div id="logs-list" class="content-list"></div>
  </div>`;
  target.querySelector('.wr-page')!.prepend(createBackLink());
  if (!document.querySelector('#beta-view-search')) target.prepend(createToolNavigation('logs'));
  target.dataset.view = 'logs';
  const settings = document.getElementById('logs-settings-link') as HTMLAnchorElement;
  settings.href = appUrl('settings') + '-logging';
  settings.addEventListener('click', event => { if (navigateTo('settings', 'logging')) event.preventDefault(); });
  document.getElementById('logs-refresh')!.addEventListener('click', () => { void refreshLogs(); });
  document.getElementById('logs-clear')!.addEventListener('click', () => {
    void sendRuntimeMessage({ type: 'CLEAR_LOGS' }).then(() => { state.entries = []; renderLogs(); updateStatus('Logs cleared'); }).catch(error => updateStatus(`Failed to clear logs: ${String(error.message || error)}`, true));
  });
  document.getElementById('logs-auto')!.addEventListener('change', event => { state.autoRefresh = (event.target as HTMLInputElement).checked; document.getElementById('logs-auto-label')!.textContent = `Auto-refresh ${state.autoRefresh ? 'on' : 'off'}`; });
  document.getElementById('logs-level')!.addEventListener('change', event => { state.level = (event.target as HTMLSelectElement).value; document.getElementById('logs-level-label')!.textContent = state.level === 'all' ? 'All levels' : `${state.level[0]!.toUpperCase() + state.level.slice(1)} only`; renderLogs(); });
  const input = document.getElementById('logs-text') as HTMLInputElement;
  const clear = document.getElementById('logs-search-clear')!;
  input.addEventListener('input', () => { state.text = input.value; clear.hidden = !state.text; renderLogs(); });
  clear.addEventListener('click', () => { state.text = ''; input.value = ''; clear.hidden = true; renderLogs(); input.focus(); });
  target.addEventListener('wr-refresh', () => { void refreshLogs(); });
  chrome.runtime.onMessage.addListener((message: Record<string, any>) => { if (message?.type === 'BETA_SETTINGS_UPDATED' && message.settings?.theme) applyTheme(message.settings.theme); });
  startPolling(() => { if (state.autoRefresh && !target.closest('[hidden]')) void refreshLogs(); }, 2000);
}

const root = document.querySelector<HTMLElement>('#app-root');
if (root?.dataset.view === 'logs') {
  void sendRuntimeMessage<{ settings?: { theme?: ThemeChoice } }>({ type: 'GET_SETTINGS' }).then(response => applyTheme(response.settings?.theme || 'light')).catch(() => applyTheme('light'));
  bindSystemThemeListener(); mountLogs(root);
}
