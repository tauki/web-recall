import { renderSettingsPanel } from './settings/index';
import { startPolling } from '../shared/polling';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';
import { DEFAULT_SETTINGS, type BetaSettings } from '../../shared/config/index';
import { getProviderOriginInfo } from '../../shared/providerOrigin';

type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  timestamp: number;
  score: number;
  hitsFromPage?: number;
  crossScore?: number;
};

type RecentPage = {
  url: string;
  title: string;
  timestamp: number;
};

type AskSource = {
  index: number;
  title: string;
  url: string;
  snippet: string;
  domain: string;
};

type ProviderView = {
  id: string;
  name: string;
  settings: Array<{ key: string; value: string }>;
};

function ensureStyles(): void {
  if (document.getElementById('beta-sidepanel-style')) return;
  const style = document.createElement('style');
  style.id = 'beta-sidepanel-style';
  style.textContent = `
    :root, body {
      margin: 0;
      padding: 0;
      overflow-x: hidden;
    }
    :root {
      --bg: #f5f5f7;
      --surface: #ffffff;
      --surface-muted: #f1f5f9;
      --border: #d1d5db;
      --text: #0f172a;
      --muted: #4b5563;
      --muted-strong: #6b7280;
      --accent: #4f46e5;
      --accent-contrast: #ffffff;
      --link: #2563eb;
      --shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }
    :root[data-theme="dark"] {
      --bg: #0a0f1a;
      --surface: #0f172a;
      --surface-muted: #0b1220;
      --border: #1e293b;
      --text: #e2e8f0;
      --muted: #cbd5e1;
      --muted-strong: #94a3b8;
      --accent: #8b5cf6;
      --accent-contrast: #0b1020;
      --link: #a5b4fc;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
    }
    body {
      background: var(--bg);
      color: var(--text);
    }
    .beta-sidepanel-shell {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg);
      overflow: hidden;
      max-width: 100%;
    }
    a {
      color: var(--link);
    }
    .beta-sidepanel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      overflow: hidden;
    }
    .beta-header-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .beta-header-actions button {
      border: 1px solid var(--border);
      background: var(--surface-muted);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-weight: 600;
      color: var(--text);
    }
    .beta-sidepanel-tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      overflow-x: auto;
    }
    .beta-remote-provider-banner {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #fef3c7;
      color: #7c2d12;
      font-size: 0.9rem;
    }
    :root[data-theme="dark"] .beta-remote-provider-banner {
      background: #3f2c00;
      color: #fde68a;
    }
    .beta-sidepanel-tabs button {
      flex: 1;
      padding: 10px 12px;
      border: none;
      background: transparent;
      cursor: pointer;
      font-weight: 600;
      color: var(--muted);
    }
    .beta-sidepanel-tabs button.active {
      color: var(--text);
      border-bottom: 3px solid var(--accent);
    }
    .beta-sidepanel-view {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      box-sizing: border-box;
      overflow-x: hidden;
      width: 100%;
    }
    .beta-search-form {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .beta-search-form input {
      flex: 1;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-size: 0.95rem;
      background: var(--surface);
      color: var(--text);
    }
    .beta-search-form button {
      padding: 8px 14px;
      border-radius: 6px;
      border: none;
      background: var(--accent);
      color: var(--accent-contrast);
      font-weight: 600;
      cursor: pointer;
    }
    .beta-search-results {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .beta-capture-status {
      background: var(--surface);
      border-radius: 8px;
      border: 1px solid var(--border);
      padding: 10px;
      margin-bottom: 12px;
    }
    .beta-capture-setup {
      background: var(--surface);
      border-radius: 8px;
      border: 1px solid var(--border);
      padding: 10px;
      margin-bottom: 12px;
      box-shadow: var(--shadow);
    }
    .beta-capture-setup h2 {
      margin: 0 0 6px 0;
      font-size: 1rem;
    }
    .beta-capture-setup p {
      margin: 0 0 8px 0;
      color: var(--muted);
      font-size: 0.9rem;
    }
    .beta-capture-setup-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .beta-capture-setup-actions button {
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface-muted);
      color: var(--text);
      cursor: pointer;
      font-weight: 600;
    }
    .beta-capture-status ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .beta-capture-status li {
      padding: 4px 0;
      border-bottom: 1px solid #f3f4f6;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .beta-capture-status li:last-child {
      border-bottom: none;
    }
    .beta-queue-actions {
      display: flex;
      gap: 4px;
    }
    .beta-queue-actions button {
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      cursor: pointer;
      font-size: 0.75rem;
      color: var(--text);
    }
    .beta-result-card {
      background: var(--surface);
      border-radius: 8px;
      border: 1px solid var(--border);
      padding: 10px;
      box-shadow: var(--shadow);
    }
    .beta-result-card h3 {
      margin: 0 0 4px 0;
      font-size: 1rem;
      color: var(--text);
    }
    .beta-result-card p {
      margin: 0 0 6px 0;
      color: var(--muted);
      font-size: 0.9rem;
      white-space: pre-wrap;
    }
    .beta-result-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.8rem;
      color: var(--muted-strong);
    }
    .beta-result-meta a {
      color: var(--accent);
    }
    .beta-status {
      font-size: 0.85rem;
      margin-bottom: 6px;
      min-height: 1em;
      color: var(--text);
    }
    .beta-status[data-variant="error"] {
      color: #ef4444;
    }
    .beta-ask-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 10px;
      width: 100%;
    }
    .beta-ask-form textarea {
      width: 100%;
      min-height: 120px;
      border-radius: 8px;
      border: 1px solid var(--border);
      padding: 8px;
      font-size: 0.95rem;
      box-sizing: border-box;
      background: var(--surface);
      color: var(--text);
    }
    .beta-ask-options {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 0.85rem;
      color: var(--muted);
    }
    .beta-ask-actions {
      display: flex;
      justify-content: flex-end;
    }
    .beta-ask-actions button {
      padding: 8px 14px;
      border-radius: 6px;
      border: none;
      background: var(--accent);
      color: var(--accent-contrast);
      font-weight: 600;
      cursor: pointer;
    }
    .beta-ask-log {
      font-size: 0.85rem;
      color: var(--muted-strong);
      min-height: 1.5em;
      max-height: 220px;
      overflow-y: auto;
      margin-bottom: 6px;
    }
    .beta-ask-log[data-variant="error"] {
      color: #ef4444;
    }
    .beta-ask-answer {
      background: var(--surface);
      border-radius: 8px;
      border: 1px solid var(--border);
      padding: 10px;
      margin-bottom: 10px;
      white-space: pre-wrap;
      color: var(--text);
    }
  `;
  document.head.appendChild(style);
}

function formatDate(timestamp: number): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString();
  } catch {
    return '';
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatScoreLabel(result: SearchResult): string {
  const simPct = Number.isFinite(result.score) ? Math.round(((result.score + 1) / 2) * 100) : undefined;
  const llmScore = Number.isFinite(result.crossScore) ? Number(result.crossScore).toFixed(1) : undefined;
  const parts: string[] = [];
  if (simPct !== undefined && simPct >= 0) parts.push(`sim ${simPct}%`);
  parts.push(`llm ${llmScore ?? 'n/a'}/10`);
  return parts.join(' · ');
}

async function initTheme(): Promise<void> {
  try {
    const response = await sendRuntimeMessage<{ settings?: { theme?: ThemeChoice } }>({ type: 'GET_SETTINGS' });
    const theme = response.settings?.theme ?? 'light';
    applyTheme(theme);
  } catch {
    applyTheme('light');
  }
  bindSystemThemeListener();
}

function openToolPage(path: string): void {
  try {
    const url = chrome.runtime.getURL(path);
    chrome.tabs.create({ url });
  } catch (err) {
    console.warn('[beta-ui:sidepanel] openToolPage failed', err);
  }
}

async function refreshRemoteProviderBanner(
  banner: HTMLElement | null,
  settingsOverride?: BetaSettings
): Promise<void> {
  if (!banner) return;
  try {
    const settings =
      settingsOverride ||
      (await sendRuntimeMessage<{ settings?: BetaSettings }>({ type: 'GET_SETTINGS' })).settings ||
      DEFAULT_SETTINGS;
    const response = await sendRuntimeMessage<{ providers?: ProviderView[] }>({ type: 'GET_PROVIDERS' });
    const providers = response.providers || [];
    const active = providers.find((provider) => provider.id === settings.activeProviderId) || providers[0];
    const baseUrl = active?.settings.find((setting) => setting.key === 'baseUrl')?.value || '';
    const info = getProviderOriginInfo(baseUrl);
    if (info.isValid && info.isRemote) {
      banner.hidden = false;
      banner.textContent = `Remote provider active (${info.origin}). Ask and retrieval context may leave this machine.`;
      return;
    }
  } catch {
    // best effort
  }
  banner.hidden = true;
  banner.textContent = '';
}

function replaceWithMessage(container: HTMLElement, message: string, tagName = 'p'): void {
  const node = document.createElement(tagName);
  node.textContent = message;
  container.replaceChildren(node);
}

function buildResultCard(params: {
  url: string;
  title: string;
  snippet?: string;
  meta: string[];
  headingPrefix?: string;
}): HTMLElement {
  const article = document.createElement('article');
  article.className = 'beta-result-card';

  const heading = document.createElement('h3');
  if (params.headingPrefix) {
    heading.append(document.createTextNode(params.headingPrefix));
  }
  const link = document.createElement('a');
  link.href = params.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = params.title;
  heading.appendChild(link);
  article.appendChild(heading);

  if (params.snippet) {
    const body = document.createElement('p');
    body.textContent = params.snippet;
    article.appendChild(body);
  }

  const meta = document.createElement('div');
  meta.className = 'beta-result-meta';
  params.meta
    .filter(Boolean)
    .forEach((item) => {
      const span = document.createElement('span');
      span.textContent = item;
      meta.appendChild(span);
    });
  article.appendChild(meta);

  return article;
}

function createSearchView(container: HTMLElement): void {
  container.innerHTML = `
    <form class="beta-search-form" id="beta-search-form">
      <input type="search" id="beta-search-input" placeholder="Search captured pages" aria-label="Search query" />
      <button type="submit">Search</button>
    </form>
    <div id="beta-search-status" role="status" aria-live="polite" class="beta-status"></div>
    <section id="beta-capture-setup" class="beta-capture-setup" hidden>
      <h2>Choose your capture policy</h2>
      <p>Web Recall now starts paused on first run. You can resume broad capture, or set an allowlist first and only capture approved domains.</p>
      <div class="beta-capture-setup-actions">
        <button type="button" id="beta-enable-broad-capture">Enable broad capture</button>
        <button type="button" id="beta-open-capture-settings">Set allowlist first</button>
      </div>
    </section>
    <section class="beta-capture-status" aria-live="polite">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <h2 style="margin:0;">Capture queue</h2>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" id="beta-capture-now">Capture current tab</button>
          <button type="button" id="beta-retry-failed">Retry failed</button>
        </div>
      </div>
      <div id="beta-capture-status">No pending captures.</div>
    </section>
    <section class="beta-capture-status" aria-live="polite">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <h2 style="margin:0;">Recent captures</h2>
        <button type="button" id="beta-refresh-recents">Refresh</button>
      </div>
      <div id="beta-recents-list"><p>Loading…</p></div>
    </section>
    <div class="beta-search-results" id="beta-search-results"></div>
  `;
  const form = container.querySelector<HTMLFormElement>('#beta-search-form');
  const input = container.querySelector<HTMLInputElement>('#beta-search-input');
  const status = container.querySelector<HTMLDivElement>('#beta-search-status');
  const captureSetupNotice = container.querySelector<HTMLElement>('#beta-capture-setup');
  const enableBroadCaptureBtn = container.querySelector<HTMLButtonElement>('#beta-enable-broad-capture');
  const openCaptureSettingsBtn = container.querySelector<HTMLButtonElement>('#beta-open-capture-settings');
  const remoteProviderBanner = document.querySelector<HTMLElement>('#beta-remote-provider-banner');
  const resultsWrap = container.querySelector<HTMLDivElement>('#beta-search-results');
  const captureStatusView = container.querySelector<HTMLDivElement>('#beta-capture-status');
  const captureNowBtn = container.querySelector<HTMLButtonElement>('#beta-capture-now');
  const retryFailedBtn = container.querySelector<HTMLButtonElement>('#beta-retry-failed');
  const recentsList = container.querySelector<HTMLDivElement>('#beta-recents-list');
  const recentsRefresh = container.querySelector<HTMLButtonElement>('#beta-refresh-recents');
  let currentSettings: BetaSettings = { ...DEFAULT_SETTINGS };
  let captureQueue: Array<{ url: string; title: string; status: string; attempts: number; updatedAt?: number }> = [];
  let recentPages: RecentPage[] = [];

  function setStatus(text: string, isError = false): void {
    if (!status) return;
    status.textContent = text;
    status.dataset.variant = isError ? 'error' : 'info';
  }

  function renderResults(results: SearchResult[]): void {
    if (!resultsWrap) return;
    if (!results.length) {
      replaceWithMessage(resultsWrap, 'No matching pages yet. Capture pages or adjust your query.');
      return;
    }
    resultsWrap.replaceChildren(
      ...results.map((result) =>
        buildResultCard({
          url: result.url,
          title: result.title,
          snippet: result.snippet.replace(/\s+/g, ' ').trim(),
          meta: [
            extractDomain(result.url),
            formatScoreLabel(result),
            result.hitsFromPage && result.hitsFromPage > 1 ? `${result.hitsFromPage} matches` : '',
            formatDate(result.timestamp)
          ]
        })
      )
    );
  }

  function renderCaptureSetupNotice(): void {
    if (!captureSetupNotice) return;
    captureSetupNotice.hidden = currentSettings.captureSetupComplete;
  }

  function applySettings(settings: BetaSettings): void {
    currentSettings = settings;
    renderCaptureSetupNotice();
  }

  function renderCaptureStatus(): void {
    if (!captureStatusView) return;
    if (!captureQueue.length) {
      replaceWithMessage(captureStatusView, 'No pending captures.');
      return;
    }
    const list = document.createElement('ul');
    captureQueue.slice(0, 5).forEach((entry) => {
      const item = document.createElement('li');
      const summary = document.createElement('div');
      const statusStrong = document.createElement('strong');
      statusStrong.textContent = entry.status;
      const time = entry.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString() : '';
      summary.appendChild(statusStrong);
      summary.append(
        document.createTextNode(
          ` · ${entry.title || entry.url} · attempts: ${entry.attempts}${time ? ` · ${time}` : ''}`
        )
      );

      const actions = document.createElement('div');
      actions.className = 'beta-queue-actions';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        void retryEntry(entry.url);
      });
      actions.appendChild(retryBtn);

      item.append(summary, actions);
      list.appendChild(item);
    });
    captureStatusView.replaceChildren(list);
  }

  async function retryEntry(url: string): Promise<void> {
    if (!url) return;
    setStatus('Retrying capture…');
    try {
      const response = await sendRuntimeMessage<{ retried: number }>({ type: 'RETRY_PROCESSING', url });
      setStatus(`Retry queued (${response.retried || 0} item)`);
      void refreshCaptureStatus();
    } catch (err) {
      setStatus(`Retry failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  function renderRecents(): void {
    if (!recentsList) return;
    if (!recentPages.length) {
      replaceWithMessage(recentsList, 'No recent captures yet.');
      return;
    }
    recentsList.replaceChildren(
      ...recentPages.slice(0, 6).map((page) =>
        buildResultCard({
          url: page.url,
          title: page.title,
          meta: [extractDomain(page.url), formatDate(page.timestamp)]
        })
      )
    );
  }

  async function refreshRecents(): Promise<void> {
    try {
      const response = await sendRuntimeMessage<{ pages: RecentPage[] }>({ type: 'GET_PAGE_LIST' });
      recentPages = Array.isArray(response.pages) ? response.pages.slice(0, 20) : [];
      renderRecents();
    } catch (err) {
      if (recentsList) {
        replaceWithMessage(
          recentsList,
          `Unable to load recents: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  async function refreshCaptureStatus(): Promise<void> {
    try {
      const response = await sendRuntimeMessage<{ queue: typeof captureQueue }>({ type: 'GET_PROCESSING' });
      captureQueue = response.queue || [];
      renderCaptureStatus();
    } catch (err) {
      if (captureStatusView) captureStatusView.textContent = `Status unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = input?.value.trim() || '';
    if (!query) {
      setStatus('Enter a query to search.');
      renderResults([]);
      return;
    }
    setStatus('Searching…');
    try {
      const response = await sendRuntimeMessage<{ results: SearchResult[] }>({
        type: 'SEARCH_QUERY',
        query,
        limit: 20
      });
      renderResults(response.results || []);
      setStatus(`Found ${response.results?.length || 0} result(s).`);
    } catch (err) {
      setStatus(`Search failed: ${err instanceof Error ? err.message : String(err)}`, true);
      renderResults([]);
    }
  });

  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.type === 'CAPTURE_QUEUE_UPDATED') {
      captureQueue = Array.isArray(message.queue) ? (message.queue as typeof captureQueue) : [];
      renderCaptureStatus();
    }
    if (message?.type === 'BETA_SETTINGS_UPDATED') {
      const settings = (message as { settings?: BetaSettings }).settings;
      const theme = settings?.theme;
      if (theme) applyTheme(theme);
      if (settings) {
        applySettings(settings);
        void refreshRemoteProviderBanner(remoteProviderBanner, settings);
      }
    }
  });

  void sendRuntimeMessage<{ settings?: BetaSettings }>({ type: 'GET_SETTINGS' })
    .then((response) => {
      if (response.settings) {
        applySettings(response.settings);
        void refreshRemoteProviderBanner(remoteProviderBanner, response.settings);
      }
    })
    .catch(() => {});

  startPolling(() => {
    void refreshCaptureStatus();
    void refreshRecents();
    void refreshRemoteProviderBanner(remoteProviderBanner);
  }, 5000);

  captureNowBtn?.addEventListener('click', async () => {
    try {
      await sendRuntimeMessage<{ ok: boolean }>({ type: 'CAPTURE_ACTIVE_TAB' });
      setStatus('Capture requested');
    } catch (err) {
      setStatus(`Capture request failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  retryFailedBtn?.addEventListener('click', async () => {
    try {
      const response = await sendRuntimeMessage<{ retried: number }>({ type: 'RETRY_FAILED_CAPTURES' });
      setStatus(`Retried ${response.retried || 0} capture(s)`);
      void refreshCaptureStatus();
    } catch (err) {
      setStatus(`Retry failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  recentsRefresh?.addEventListener('click', () => {
    void refreshRecents();
  });

  enableBroadCaptureBtn?.addEventListener('click', async () => {
    try {
      const response = await sendRuntimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { paused: false, captureSetupComplete: true }
      });
      applySettings(response.settings || { ...currentSettings, paused: false, captureSetupComplete: true });
      setStatus('Broad capture enabled');
    } catch (err) {
      setStatus(`Unable to enable capture: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  openCaptureSettingsBtn?.addEventListener('click', () => {
    const settingsTab = document.querySelector<HTMLButtonElement>('.beta-sidepanel-tabs button[data-tab="settings"]');
    settingsTab?.click();
  });
}

function createAskView(container: HTMLElement): void {
  container.innerHTML = `
    <form class="beta-ask-form" id="beta-ask-form">
      <textarea id="beta-ask-input" placeholder="Ask a question about your captured pages"></textarea>
      <div class="beta-ask-options">
        <label><input type="checkbox" id="beta-ask-use-search" checked /> Use memory search</label>
        <label>Max sources (optional) <input type="number" id="beta-ask-max-results" min="1" placeholder="auto" style="width:70px;margin-left:4px;" /></label>
      </div>
      <div class="beta-ask-actions">
        <button type="submit">Ask</button>
      </div>
    </form>
    <div id="beta-ask-log" class="beta-ask-log"></div>
    <div id="beta-ask-answer" class="beta-ask-answer" hidden></div>
    <div id="beta-ask-sources" class="beta-search-results"></div>
  `;

  const form = container.querySelector<HTMLFormElement>('#beta-ask-form');
  const input = container.querySelector<HTMLTextAreaElement>('#beta-ask-input');
  const useSearch = container.querySelector<HTMLInputElement>('#beta-ask-use-search');
  const maxResults = container.querySelector<HTMLInputElement>('#beta-ask-max-results');
  const logView = container.querySelector<HTMLDivElement>('#beta-ask-log');
  const answerView = container.querySelector<HTMLDivElement>('#beta-ask-answer');
  const sourcesView = container.querySelector<HTMLDivElement>('#beta-ask-sources');
  const logEntries: string[] = [];
  let activeRequestId: string | null = null;

  function appendLog(message: string, variant: 'info' | 'error' = 'info'): void {
    if (!logView || !message) return;
    if (logEntries[logEntries.length - 1] === message) return;
    logEntries.push(message);
    logView.replaceChildren(
      ...logEntries.map((entry) => {
        const row = document.createElement('div');
        row.textContent = entry;
        return row;
      })
    );
    logView.dataset.variant = variant;
    logView.scrollTop = logView.scrollHeight;
  }

  function resetLog(): void {
    logEntries.length = 0;
    if (!logView) return;
    logView.innerHTML = '';
    delete logView.dataset.variant;
  }

  function renderSources(
    sources: AskSource[] | undefined,
    state: 'pending' | 'ready' = 'ready'
  ): void {
    if (!sourcesView) return;
    if (state === 'pending') {
      replaceWithMessage(sourcesView, 'Gathering sources…');
      return;
    }
    if (!sources || !sources.length) {
      replaceWithMessage(
        sourcesView,
        'No sources found for this question. Try adjusting the query or capture more pages.'
      );
      return;
    }
    sourcesView.replaceChildren(
      ...sources.map((source) =>
        buildResultCard({
          url: source.url,
          title: source.title,
          snippet: (source.snippet || '').trim(),
          meta: [source.domain],
          headingPrefix: `[${source.index}] `
        })
      )
    );
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = input?.value.trim() || '';
    if (!question) {
      appendLog('Please enter a question.');
      return;
    }
    activeRequestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    resetLog();
    appendLog('Searching captured pages...');
    if (answerView) {
      answerView.hidden = true;
      answerView.textContent = '';
    }
    renderSources([], 'pending');
    try {
      const response = await sendRuntimeMessage<{ answer: string; sources: AskSource[] }>(
        {
          type: 'ASK_QUESTION',
          question,
          options: {
            useSearch: useSearch ? useSearch.checked : true,
            maxResults: (() => {
              const raw = maxResults?.value?.trim() || '';
              if (!raw) return undefined;
              const parsed = Number(raw);
              return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            })(),
            requestId: activeRequestId
          }
        }
      );
      if (answerView) {
        answerView.textContent = response.answer || 'No answer';
        answerView.hidden = false;
      }
      renderSources(response.sources, 'ready');
    } catch (err) {
      appendLog(`Ask failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      renderSources([], 'ready');
    }
  });

  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.requestId && activeRequestId && message.requestId !== activeRequestId) {
      return;
    }
    if (message?.type === 'ASK_PROGRESS') {
      appendLog(String(message.message || '')); 
    }
    if (message?.type === 'ASK_ANSWER_UPDATE' && answerView) {
      answerView.hidden = false;
      answerView.textContent = String(message.chunk || '');
    }
  });
}

function renderApp(root: HTMLElement): void {
  ensureStyles();
  root.dataset.view = 'sidepanel';
  root.innerHTML = `
    <div class="beta-sidepanel-shell">
      <div class="beta-sidepanel-header">
        <div style="font-weight:700;">Web Recall</div>
        <div class="beta-header-actions">
          <button type="button" data-action="open-logs">Logs</button>
          <button type="button" data-action="open-highlights">Highlights</button>
          <button type="button" data-action="open-settings">Manage</button>
        </div>
      </div>
      <div id="beta-remote-provider-banner" class="beta-remote-provider-banner" hidden></div>
      <div class="beta-sidepanel-tabs" role="tablist">
        <button type="button" data-tab="search" class="active" aria-selected="true" role="tab">Search</button>
        <button type="button" data-tab="ask" role="tab" aria-selected="false">Ask</button>
        <button type="button" data-tab="settings" role="tab" aria-selected="false">Settings</button>
      </div>
      <section id="beta-view-search" class="beta-sidepanel-view" role="tabpanel"></section>
      <section id="beta-view-ask" class="beta-sidepanel-view" role="tabpanel" hidden></section>
      <section id="beta-view-settings" class="beta-sidepanel-view" role="tabpanel" hidden></section>
    </div>
  `;
  const searchView = root.querySelector<HTMLElement>('#beta-view-search');
  const askView = root.querySelector<HTMLElement>('#beta-view-ask');
  const settingsView = root.querySelector<HTMLElement>('#beta-view-settings');
  const remoteProviderBanner = root.querySelector<HTMLElement>('#beta-remote-provider-banner');
  const tabButtons = root.querySelectorAll<HTMLButtonElement>('.beta-sidepanel-tabs button');
  const headerActions = root.querySelectorAll<HTMLButtonElement>('.beta-header-actions button');

  if (searchView) {
    createSearchView(searchView);
  }
  if (askView) {
    createAskView(askView);
  }
  if (settingsView) {
    renderSettingsPanel(settingsView);
  }

  void refreshRemoteProviderBanner(remoteProviderBanner);

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabButtons.forEach((button) => {
        button.classList.toggle('active', button === btn);
        button.setAttribute('aria-selected', button === btn ? 'true' : 'false');
      });
      searchView?.setAttribute('hidden', 'true');
      askView?.setAttribute('hidden', 'true');
      settingsView?.setAttribute('hidden', 'true');
      if (tab === 'search') {
        searchView?.removeAttribute('hidden');
      } else if (tab === 'ask') {
        askView?.removeAttribute('hidden');
      } else if (tab === 'settings') {
        settingsView?.removeAttribute('hidden');
      }
    });
  });

  headerActions.forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'open-logs') {
        openToolPage('dist/beta/ui/logs/index.html');
      } else if (action === 'open-highlights') {
        openToolPage('dist/beta/ui/highlights/index.html');
      } else if (action === 'open-settings') {
        openToolPage('dist/beta/ui/manage/index.html');
      }
    });
  });
}

const root = document.querySelector<HTMLElement>('#app-root');

if (root) {
  void initTheme().then(() => {
    renderApp(root);
    console.info('[beta-ui:sidepanel] search + settings rendered');
  });
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.type === 'BETA_SETTINGS_UPDATED') {
      const theme = (message as { settings?: { theme?: ThemeChoice } }).settings?.theme;
      if (theme) applyTheme(theme);
    }
  });
} else {
  console.error('[beta-ui:sidepanel] #app-root not found');
}
