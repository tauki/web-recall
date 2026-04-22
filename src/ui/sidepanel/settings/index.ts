import {
  DEFAULT_EMBEDDING_CONFIG as DEFAULT_EMBEDDING,
  DEFAULT_SETTINGS,
  type BetaSettings,
  type EmbeddingConfig
} from '../../../shared/config/index';
import { getProviderOriginInfo } from '../../../shared/providerOrigin';
import { sendRuntimeMessage as runtimeMessage } from '../../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../../shared/theme';

type BrowserEmbedStatus = {
  ready: boolean;
  runtimeAvailable: boolean;
  model: string;
  revision: string;
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  code?: string;
  lastError?: string;
  checkedAt?: string;
};

function formatDomainList(list: string[]): string {
  return list.join('\n');
}

function parseDomainInput(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function ensureStyles(): void {
  if (document.getElementById('beta-settings-style')) return;
  const style = document.createElement('style');
  style.id = 'beta-settings-style';
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
    }
    body {
      background: var(--bg);
      color: var(--text);
    }
    .beta-settings-root {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 12px;
      color: var(--text);
      background: var(--bg);
      min-height: 100%;
      box-sizing: border-box;
    }
    .beta-card {
      background: var(--surface);
      border-radius: 8px;
      border: 1px solid var(--border);
      padding: 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
    }
    .beta-settings-title {
      font-size: 1.25rem;
      margin: 0;
    }
    .beta-card h2 {
      font-size: 1rem;
      margin: 0 0 8px 0;
    }
    .beta-toggle {
      display: flex;
      gap: 8px;
      align-items: center;
      font-weight: 600;
    }
    .beta-field {
      display: flex;
      flex-direction: column;
      margin-bottom: 8px;
    }
    .beta-field label {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .beta-field input,
    .beta-field textarea {
      border: 1px solid var(--border);
      padding: 6px 8px;
      border-radius: 6px;
      font: inherit;
      background: var(--surface);
      color: var(--text);
    }
    .beta-card button {
      align-self: flex-start;
      padding: 6px 12px;
      border-radius: 6px;
      border: none;
      background: var(--accent);
      color: var(--accent-contrast);
      font-weight: 600;
      cursor: pointer;
    }
    .beta-card button:focus {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .beta-help {
      font-size: 0.875rem;
      color: var(--muted);
    }
    .beta-status {
      font-size: 0.9rem;
      margin: 0;
      min-height: 1.2em;
    }
    .beta-status[data-variant="error"] {
      color: #b42318;
    }
  `;
  document.head.appendChild(style);
}

export function renderSettingsPanel(target: HTMLElement): void {
  bindSystemThemeListener();
  ensureStyles();
  target.innerHTML = `
    <div class="beta-settings-root">
      <h1 class="beta-settings-title">Web Recall Settings</h1>

      <section class="beta-card" aria-labelledby="capture-heading">
        <h2 id="capture-heading">Capture controls</h2>
        <label class="beta-toggle">
          <input type="checkbox" id="beta-pause-toggle" />
          <span>Pause automatic capture</span>
        </label>
        <p class="beta-help">When paused, Web Recall ignores automatic capture requests until you resume.</p>
      </section>

      <section class="beta-card" id="beta-capture-setup-card" aria-labelledby="capture-setup-heading" hidden>
        <h2 id="capture-setup-heading">First-run capture setup</h2>
        <p class="beta-help">
          Web Recall starts paused by default. Choose broad capture, or save an allowlist first and resume capture only for approved domains.
        </p>
        <div class="beta-field" style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="beta-enable-broad-capture" type="button">Enable broad capture</button>
          <button id="beta-save-allowlist-and-resume" type="button">Save allowlist and enable capture</button>
        </div>
      </section>

      <section class="beta-card" aria-labelledby="theme-heading">
        <h2 id="theme-heading">Appearance</h2>
        <div class="beta-field">
          <label for="beta-theme-select">Theme</label>
          <select id="beta-theme-select">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>
      </section>

      <section class="beta-card" aria-labelledby="domain-heading">
        <h2 id="domain-heading">Domain allowlist / denylist</h2>
        <p id="domain-help" class="beta-help">
          List one domain per line. Wildcards like <code>*.example.com</code> are supported. Empty allowlist captures every domain not on the denylist.
        </p>
        <div class="beta-field">
          <label for="beta-allowlist-input">Allowlist</label>
          <textarea id="beta-allowlist-input" rows="4" aria-describedby="domain-help"></textarea>
        </div>
        <div class="beta-field">
          <label for="beta-denylist-input">Denylist</label>
          <textarea id="beta-denylist-input" rows="4" aria-describedby="domain-help"></textarea>
        </div>
        <button id="beta-save-rules" type="button">Save capture rules</button>
      </section>

      <section class="beta-card" aria-labelledby="embed-heading">
        <h2 id="embed-heading">Embedding provider</h2>
        <div class="beta-field">
          <label for="beta-embedding-provider">Provider</label>
          <select id="beta-embedding-provider">
            <option value="ollama">Ollama (local server)</option>
            <option value="browser">In-browser (experimental, model download required)</option>
          </select>
        </div>
        <div class="beta-field">
          <label for="beta-embedding-base">Base URL</label>
          <input id="beta-embedding-base" type="url" placeholder="http://localhost:11434" />
        </div>
        <div class="beta-field">
          <label for="beta-embedding-model">Model name</label>
          <input id="beta-embedding-model" type="text" placeholder="embeddinggemma" />
        </div>
        <div class="beta-field">
          <label for="beta-embedding-browser-model">Browser model (Hugging Face)</label>
          <input id="beta-embedding-browser-model" type="text" placeholder="onnx-community/embeddinggemma-300m-ONNX" />
        </div>
        <div class="beta-field">
          <label for="beta-embedding-browser-rev">Browser model revision</label>
          <input id="beta-embedding-browser-rev" type="text" placeholder="commit hash" />
        </div>
        <button id="beta-download-browser-model" type="button">Download browser model</button>
        <p id="beta-embedding-browser-status" class="beta-help">Browser embeddings download a pinned Hugging Face model (~80MB). Expect higher memory use.</p>
        <button id="beta-save-embedding" type="button">Save embedding settings</button>
      </section>

      <section class="beta-card" aria-labelledby="provider-heading">
        <h2 id="provider-heading">Chat provider</h2>
        <div class="beta-field">
          <label for="beta-provider-select">Provider</label>
          <select id="beta-provider-select"></select>
        </div>
        <div class="beta-field">
          <label for="beta-provider-base">Base URL</label>
          <input id="beta-provider-base" type="url" placeholder="http://localhost:11434" />
        </div>
        <div class="beta-field">
          <label for="beta-chat-model">Chat model</label>
          <select id="beta-chat-model"></select>
        </div>
        <div class="beta-provider-actions" style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="beta-provider-save" type="button">Save provider</button>
          <button id="beta-provider-test" type="button">Test connection</button>
          <button id="beta-provider-refresh" type="button">Refresh models</button>
        </div>
        <p id="beta-provider-status" class="beta-help"></p>
        <p id="beta-provider-security" class="beta-help"></p>
        <p id="beta-provider-notes" class="beta-help"></p>
      </section>

      <section class="beta-card" aria-labelledby="ask-heading">
        <h2 id="ask-heading">Retrieval and Ask preferences</h2>
        <div class="beta-field">
          <label for="beta-context-window">Context window (characters)</label>
          <input id="beta-context-window" type="number" min="400" max="6000" step="100" />
        </div>
        <div class="beta-field">
          <label for="beta-ask-sources">Max sources per answer</label>
          <input id="beta-ask-sources" type="number" min="1" max="10" />
        </div>
        <div class="beta-field">
          <label for="beta-answer-mode">Answer mode</label>
          <select id="beta-answer-mode">
            <option value="concise">Concise (2–4 sentences)</option>
            <option value="detailed">Detailed (thorough explanations)</option>
          </select>
        </div>
        <div class="beta-field">
          <label for="beta-log-level">Log level</label>
          <select id="beta-log-level">
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="off">Off</option>
          </select>
        </div>
        <label class="beta-toggle"><input type="checkbox" id="beta-query-rewrite" /> Enable query rewrite</label>
        <label class="beta-toggle"><input type="checkbox" id="beta-search-rerank" /> Enable LLM reranking for Search</label>
        <label class="beta-toggle"><input type="checkbox" id="beta-ask-rerank" /> Enable reranking for Ask retrieval</label>
        <label class="beta-toggle"><input type="checkbox" id="beta-enable-tools" /> Allow Ask to call tools</label>
        <div class="beta-field">
          <label for="beta-max-tool-steps">Max tool steps</label>
          <input id="beta-max-tool-steps" type="number" min="0" />
        </div>
        <div class="beta-field">
          <label for="beta-tool-timeout">Tool timeout (ms)</label>
          <input id="beta-tool-timeout" type="number" min="1000" step="500" />
        </div>
        <label class="beta-toggle"><input type="checkbox" id="beta-log-full" /> Log full capture payloads</label>
        <p class="beta-help">These settings control query rewriting, Search reranking, and how Ask builds answers from captured pages. Max tool steps uses 0 as no user limit.</p>
      </section>

      <section class="beta-card" aria-labelledby="calibration-heading">
        <h2 id="calibration-heading">Calibration</h2>
        <div class="beta-field">
          <label for="beta-calib-sim">Similarity weight</label>
          <input id="beta-calib-sim" type="number" min="0" max="1" step="0.05" />
        </div>
        <div class="beta-field">
          <label for="beta-calib-llm">LLM weight</label>
          <input id="beta-calib-llm" type="number" min="0" max="1" step="0.05" />
        </div>
        <p class="beta-help">Adjust how much traditional similarity vs. LLM synthesis influence results.</p>
      </section>

      <section class="beta-card" aria-labelledby="tools-heading">
        <h2 id="tools-heading">Advanced tools</h2>
        <p class="beta-help">Open the full-page applications for managing captures, reviewing logs, or browsing highlights.</p>
        <div class="beta-field" style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" id="beta-open-manage">Open Manage</button>
          <button type="button" id="beta-open-logs">Open Logs</button>
          <button type="button" id="beta-open-highlights">Open Highlights</button>
        </div>
      </section>

      <p id="beta-settings-status" role="status" aria-live="polite" class="beta-status"></p>
    </div>
  `;

  attachBehavior(target);
}

function attachBehavior(root: HTMLElement): void {
  const pauseToggle = root.querySelector<HTMLInputElement>('#beta-pause-toggle');
  const captureSetupCard = root.querySelector<HTMLElement>('#beta-capture-setup-card');
  const enableBroadCaptureBtn = root.querySelector<HTMLButtonElement>('#beta-enable-broad-capture');
  const saveAllowlistAndResumeBtn = root.querySelector<HTMLButtonElement>('#beta-save-allowlist-and-resume');
  const allowInput = root.querySelector<HTMLTextAreaElement>('#beta-allowlist-input');
  const denyInput = root.querySelector<HTMLTextAreaElement>('#beta-denylist-input');
  const saveRulesBtn = root.querySelector<HTMLButtonElement>('#beta-save-rules');
  const baseInput = root.querySelector<HTMLInputElement>('#beta-embedding-base');
  const modelInput = root.querySelector<HTMLInputElement>('#beta-embedding-model');
  const embeddingProviderSelect = root.querySelector<HTMLSelectElement>('#beta-embedding-provider');
  const browserModelInput = root.querySelector<HTMLInputElement>('#beta-embedding-browser-model');
  const browserRevisionInput = root.querySelector<HTMLInputElement>('#beta-embedding-browser-rev');
  const downloadBrowserBtn = root.querySelector<HTMLButtonElement>('#beta-download-browser-model');
  const browserStatusLine = root.querySelector<HTMLParagraphElement>('#beta-embedding-browser-status');
  const saveEmbeddingBtn = root.querySelector<HTMLButtonElement>('#beta-save-embedding');
  const providerSelect = root.querySelector<HTMLSelectElement>('#beta-provider-select');
  const contextWindowInput = root.querySelector<HTMLInputElement>('#beta-context-window');
  const askSourcesInput = root.querySelector<HTMLInputElement>('#beta-ask-sources');
  const themeSelect = root.querySelector<HTMLSelectElement>('#beta-theme-select');
  const answerModeSelect = root.querySelector<HTMLSelectElement>('#beta-answer-mode');
  const logLevelSelect = root.querySelector<HTMLSelectElement>('#beta-log-level');
  const queryRewriteToggle = root.querySelector<HTMLInputElement>('#beta-query-rewrite');
  const searchRerankToggle = root.querySelector<HTMLInputElement>('#beta-search-rerank');
  const askRerankToggle = root.querySelector<HTMLInputElement>('#beta-ask-rerank');
  const enableToolsToggle = root.querySelector<HTMLInputElement>('#beta-enable-tools');
  const maxToolStepsInput = root.querySelector<HTMLInputElement>('#beta-max-tool-steps');
  const toolTimeoutInput = root.querySelector<HTMLInputElement>('#beta-tool-timeout');
  const logFullBodiesToggle = root.querySelector<HTMLInputElement>('#beta-log-full');
  const providerBaseInput = root.querySelector<HTMLInputElement>('#beta-provider-base');
  const chatModelSelect = root.querySelector<HTMLSelectElement>('#beta-chat-model');
  const providerSaveBtn = root.querySelector<HTMLButtonElement>('#beta-provider-save');
  const providerTestBtn = root.querySelector<HTMLButtonElement>('#beta-provider-test');
  const providerRefreshBtn = root.querySelector<HTMLButtonElement>('#beta-provider-refresh');
  const providerStatus = root.querySelector<HTMLParagraphElement>('#beta-provider-status');
  const providerSecurity = root.querySelector<HTMLParagraphElement>('#beta-provider-security');
  const providerNotes = root.querySelector<HTMLParagraphElement>('#beta-provider-notes');
  const openManageBtn = root.querySelector<HTMLButtonElement>('#beta-open-manage');
  const openLogsBtn = root.querySelector<HTMLButtonElement>('#beta-open-logs');
  const openHighlightsBtn = root.querySelector<HTMLButtonElement>('#beta-open-highlights');
  const calibSimInput = root.querySelector<HTMLInputElement>('#beta-calib-sim');
  const calibLLMInput = root.querySelector<HTMLInputElement>('#beta-calib-llm');
  const statusLine = root.querySelector<HTMLParagraphElement>('#beta-settings-status');

  let currentSettings: BetaSettings = { ...DEFAULT_SETTINGS };

  function setStatus(text: string, isError = false): void {
    if (!statusLine) return;
    statusLine.textContent = text;
    statusLine.dataset.variant = isError ? 'error' : 'info';
  }

  type ProviderView = {
    id: string;
    name: string;
    status?: { online: boolean; lastError?: string };
    settings: Array<{ key: string; value: string }>;
    models: string[];
    selectedModel: string;
    notes?: string;
  };

  let providerCache: ProviderView[] = [];

  function getAcknowledgedRemoteOrigins(): string[] {
    return Array.isArray(currentSettings.acknowledgedRemoteProviderOrigins)
      ? currentSettings.acknowledgedRemoteProviderOrigins
      : [];
  }

  function renderProviderSecurityNotice(baseUrl: string): void {
    if (!providerSecurity) return;
    const info = getProviderOriginInfo(baseUrl);
    if (!info.isValid) {
      providerSecurity.textContent = '';
      return;
    }
    if (!info.isRemote) {
      providerSecurity.textContent = 'Local provider detected. Captured context stays on the local provider you configured.';
      providerSecurity.style.color = '';
      return;
    }
    const acknowledged = info.origin ? getAcknowledgedRemoteOrigins().includes(info.origin) : false;
    providerSecurity.textContent = acknowledged
      ? `Remote provider enabled (${info.origin}). Captured text and Ask context may leave this machine.`
      : `Remote provider detected (${info.origin}). Captured text and Ask context may leave this machine until you explicitly acknowledge this trust boundary.`;
    providerSecurity.style.color = acknowledged ? '#92400e' : '#b91c1c';
  }

  function replaceSelectOptions(
    select: HTMLSelectElement,
    options: Array<{ value: string; label: string }>
  ): void {
    select.replaceChildren(
      ...options.map((item) => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        return option;
      })
    );
  }

  function applyProvider(provider: ProviderView): void {
    if (providerSelect) {
      providerSelect.value = provider.id;
    }
    const baseSetting = provider.settings.find((setting) => setting.key === 'baseUrl');
    if (providerBaseInput) {
      providerBaseInput.value = baseSetting?.value || '';
      renderProviderSecurityNotice(providerBaseInput.value);
    }
    if (providerNotes) {
      providerNotes.textContent = provider.notes || '';
    }
    if (chatModelSelect) {
      const models = provider.models || [];
      const current = chatModelSelect.value;
      replaceSelectOptions(
        chatModelSelect,
        models.length
          ? models.map((model) => ({ value: model, label: model }))
          : [{ value: '', label: 'No models detected' }]
      );
      const toSelect = models.includes(provider.selectedModel) ? provider.selectedModel : models[0] || '';
      chatModelSelect.value = toSelect || current;
      chatModelSelect.disabled = models.length === 0;
    }
  }

  async function refreshProvider(): Promise<void> {
    try {
      const response = await runtimeMessage<{ providers: ProviderView[] }>({ type: 'GET_PROVIDERS' });
      const providers = response.providers || [];
      providerCache = providers;
      if (providerSelect) {
        replaceSelectOptions(
          providerSelect,
          providers.map((provider) => ({ value: provider.id, label: provider.name }))
        );
      }
      const activeId = currentSettings.activeProviderId || 'ollama';
      const active = providers.find((provider) => provider.id === activeId) || providers[0];
      if (active) {
        applyProvider(active);
    if (providerStatus) {
          providerStatus.textContent = active.status?.online ? `${active.name} online` : `Offline: ${active.status?.lastError || 'unknown error'}`;
          providerStatus.style.color = active.status?.online ? '#10b981' : '#b91c1c';
        }
      }
    } catch (err) {
      if (providerStatus) {
        providerStatus.textContent = `Unable to load provider: ${err instanceof Error ? err.message : String(err)}`;
        providerStatus.style.color = '#b91c1c';
      }
    }
  }

  function applySettings(settings: BetaSettings): void {
    currentSettings = settings;
    if (captureSetupCard) {
      captureSetupCard.hidden = settings.captureSetupComplete;
    }
    if (pauseToggle) {
      pauseToggle.checked = !!settings.paused;
    }
    if (allowInput) {
      allowInput.value = formatDomainList(settings.allowlist);
    }
    if (denyInput) {
      denyInput.value = formatDomainList(settings.denylist);
    }
    if (contextWindowInput) {
      contextWindowInput.value = String(settings.contextWindowChars ?? DEFAULT_SETTINGS.contextWindowChars);
    }
    if (askSourcesInput) {
      askSourcesInput.value = String(settings.askMaxSources ?? DEFAULT_SETTINGS.askMaxSources);
    }
    if (themeSelect) {
      themeSelect.value = settings.theme || DEFAULT_SETTINGS.theme;
    }
    if (providerSelect) {
      providerSelect.value = settings.activeProviderId || DEFAULT_SETTINGS.activeProviderId;
    }
    if (answerModeSelect) {
      answerModeSelect.value = settings.answerMode || DEFAULT_SETTINGS.answerMode;
    }
    if (logLevelSelect) {
      logLevelSelect.value = settings.logLevel || DEFAULT_SETTINGS.logLevel;
    }
    if (queryRewriteToggle) queryRewriteToggle.checked = !!settings.queryRewrite;
    if (searchRerankToggle) searchRerankToggle.checked = settings.searchRerank ?? true;
    if (askRerankToggle) askRerankToggle.checked = settings.askRerank ?? true;
    if (enableToolsToggle) enableToolsToggle.checked = !!settings.enableTools;
    if (maxToolStepsInput) maxToolStepsInput.value = String(settings.maxToolSteps ?? DEFAULT_SETTINGS.maxToolSteps);
    if (toolTimeoutInput) toolTimeoutInput.value = String(settings.toolTimeoutMs ?? DEFAULT_SETTINGS.toolTimeoutMs);
    if (logFullBodiesToggle) logFullBodiesToggle.checked = !!settings.logFullBodies;
    applyTheme(settings.theme || 'light');
    const allowlistCount = settings.allowlist.length;
    if (saveAllowlistAndResumeBtn) {
      saveAllowlistAndResumeBtn.disabled = allowlistCount === 0;
    }
    if (providerBaseInput) {
      renderProviderSecurityNotice(providerBaseInput.value);
    }
  }

  function applyEmbedding(config: EmbeddingConfig): void {
    if (baseInput) baseInput.value = config.baseUrl || '';
    if (modelInput) modelInput.value = config.model || '';
    if (browserModelInput) browserModelInput.value = config.browserModel || DEFAULT_EMBEDDING.browserModel || '';
    if (browserRevisionInput) browserRevisionInput.value = config.browserRevision || DEFAULT_EMBEDDING.browserRevision || '';
    if (embeddingProviderSelect) {
      embeddingProviderSelect.value = config.provider === 'browser' ? 'browser' : 'ollama';
      const isBrowser = embeddingProviderSelect.value === 'browser';
      if (baseInput) baseInput.disabled = isBrowser;
      if (modelInput) modelInput.disabled = isBrowser;
      if (downloadBrowserBtn) downloadBrowserBtn.style.display = isBrowser ? 'inline-flex' : 'none';
      if (browserStatusLine) browserStatusLine.style.display = isBrowser ? 'block' : 'none';
    }
    if (config.provider === 'browser') {
      void refreshBrowserEmbedStatus();
    }
  }

  function updateBrowserStatus(text: string, isError = false): void {
    if (!browserStatusLine) return;
    browserStatusLine.textContent = text;
    browserStatusLine.style.color = isError ? '#b91c1c' : '#6b7280';
  }

  function renderBrowserEmbedStatus(status?: BrowserEmbedStatus): void {
    if (!status) {
      updateBrowserStatus('Unable to determine browser embedding status', true);
      return;
    }
    if (!status.runtimeAvailable) {
      updateBrowserStatus(status.lastError || 'Browser embedding runtime is unavailable on this machine.', true);
      return;
    }
    if (status.state === 'checking') {
      updateBrowserStatus('Checking browser embedding runtime…');
      return;
    }
    if (status.state === 'downloading') {
      updateBrowserStatus(`Downloading browser model (${status.model}@${status.revision})…`);
      return;
    }
    if (status.ready) {
      updateBrowserStatus(`Browser model ready (${status.model}@${status.revision})`);
      return;
    }
    if (status.state === 'error') {
      updateBrowserStatus(status.lastError || 'Browser embeddings are unavailable.', true);
      return;
    }
    updateBrowserStatus(`Browser runtime available. Download model ${status.model}@${status.revision} before using browser embeddings.`);
  }

  async function refreshBrowserEmbedStatus(): Promise<void> {
    try {
      const response = await runtimeMessage<{ status?: BrowserEmbedStatus }>({
        type: 'GET_BROWSER_EMBED_STATUS',
        probe: true
      });
      renderBrowserEmbedStatus(response.status);
    } catch (err) {
      updateBrowserStatus(err instanceof Error ? err.message : 'Unable to determine browser model status', true);
    }
  }

  async function refreshData(): Promise<void> {
    try {
      const [settingsResp, embeddingResp] = await Promise.all([
        runtimeMessage<{ settings: BetaSettings }>({ type: 'GET_SETTINGS' }),
        runtimeMessage<{ config: EmbeddingConfig }>({ type: 'GET_EMBEDDING_CONFIG' })
      ]);
      applySettings(settingsResp.settings || DEFAULT_SETTINGS);
      applyEmbedding(embeddingResp.config || DEFAULT_EMBEDDING);
      setStatus('Settings loaded');
    } catch (err) {
      setStatus(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  pauseToggle?.addEventListener('change', async (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { paused: checked }
      });
      applySettings(response.settings || { ...currentSettings, paused: checked });
      setStatus(checked ? 'Capture paused' : 'Capture resumed');
    } catch (err) {
      setStatus(`Unable to update pause state: ${err instanceof Error ? err.message : String(err)}`, true);
      if (pauseToggle) pauseToggle.checked = currentSettings.paused;
    }
  });

  saveRulesBtn?.addEventListener('click', async () => {
    if (!allowInput || !denyInput) return;
    const allowlist = parseDomainInput(allowInput.value);
    const denylist = parseDomainInput(denyInput.value);
    const wasOnboarding = !currentSettings.captureSetupComplete;
    const payload: Partial<BetaSettings> = { allowlist, denylist };
    if (wasOnboarding && allowlist.length > 0) {
      payload.captureSetupComplete = true;
      payload.paused = false;
    }
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload
      });
      applySettings(response.settings || { ...currentSettings, allowlist, denylist });
      setStatus(
        wasOnboarding && allowlist.length > 0
          ? 'Allowlist saved and capture enabled'
          : 'Capture rules saved'
      );
    } catch (err) {
      setStatus(`Unable to save rules: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  enableBroadCaptureBtn?.addEventListener('click', async () => {
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { paused: false, captureSetupComplete: true }
      });
      applySettings(response.settings || { ...currentSettings, paused: false, captureSetupComplete: true });
      setStatus('Broad capture enabled');
    } catch (err) {
      setStatus(`Unable to enable broad capture: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  saveAllowlistAndResumeBtn?.addEventListener('click', async () => {
    if (!allowInput || !denyInput) return;
    const allowlist = parseDomainInput(allowInput.value);
    const denylist = parseDomainInput(denyInput.value);
    if (allowlist.length === 0) {
      setStatus('Add at least one allowlist domain before enabling capture.', true);
      return;
    }
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: {
          allowlist,
          denylist,
          paused: false,
          captureSetupComplete: true
        }
      });
      applySettings(
        response.settings || {
          ...currentSettings,
          allowlist,
          denylist,
          paused: false,
          captureSetupComplete: true
        }
      );
      setStatus('Allowlist saved and capture enabled');
    } catch (err) {
      setStatus(`Unable to save allowlist: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  const syncAllowlistSetupButton = (): void => {
    if (!saveAllowlistAndResumeBtn || !allowInput) return;
    saveAllowlistAndResumeBtn.disabled = parseDomainInput(allowInput.value).length === 0;
  };

  allowInput?.addEventListener('input', syncAllowlistSetupButton);

  saveEmbeddingBtn?.addEventListener('click', async () => {
    if (!baseInput || !modelInput) return;
    const baseUrl = baseInput.value.trim();
    const model = modelInput.value.trim();
    const provider = embeddingProviderSelect?.value === 'browser' ? 'browser' : 'ollama';
    const browserModel = browserModelInput?.value.trim();
    const browserRevision = browserRevisionInput?.value.trim();
    try {
      const response = await runtimeMessage<{ config: EmbeddingConfig }>({
        type: 'SET_EMBEDDING_CONFIG',
        payload: { baseUrl, model, provider, browserModel, browserRevision }
      });
      applyEmbedding(response.config || { baseUrl, model });
      if (provider === 'browser') {
        await refreshBrowserEmbedStatus();
      }
      setStatus('Embedding settings saved');
    } catch (err) {
      setStatus(`Unable to save embedding settings: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  embeddingProviderSelect?.addEventListener('change', () => {
    const provider: EmbeddingConfig['provider'] = embeddingProviderSelect.value === 'browser' ? 'browser' : 'ollama';
    const config = {
      ...DEFAULT_EMBEDDING,
      baseUrl: baseInput?.value || '',
      model: modelInput?.value || '',
      browserModel: browserModelInput?.value || DEFAULT_EMBEDDING.browserModel || '',
      browserRevision: browserRevisionInput?.value || DEFAULT_EMBEDDING.browserRevision || '',
      provider
    };
    applyEmbedding(config);
  });

  downloadBrowserBtn?.addEventListener('click', async () => {
    updateBrowserStatus('Starting browser model download…');
    try {
      await runtimeMessage<{ ok?: boolean }>({ type: 'DOWNLOAD_BROWSER_EMBED' });
      setStatus('Browser model download requested');
    } catch (err) {
      updateBrowserStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  providerSaveBtn?.addEventListener('click', async () => {
    if (!providerBaseInput) return;
    const baseUrl = providerBaseInput.value.trim();
    const providerInfo = getProviderOriginInfo(baseUrl);
    let acknowledgedOrigins = getAcknowledgedRemoteOrigins();
    if (providerInfo.isValid && providerInfo.isRemote && providerInfo.origin && !acknowledgedOrigins.includes(providerInfo.origin)) {
      const confirmed = window.confirm(
        `This provider is remote (${providerInfo.origin}). Captured text, Ask context, and prompts may leave this machine. Save this provider anyway?`
      );
      if (!confirmed) {
        setStatus('Remote provider change cancelled');
        return;
      }
      acknowledgedOrigins = [...acknowledgedOrigins, providerInfo.origin];
    }
    try {
      await runtimeMessage<{ providers: unknown }>({
        type: 'SET_PROVIDER_SETTING',
        providerId: providerSelect?.value || 'ollama',
        key: 'baseUrl',
        value: baseUrl
      });
      if (acknowledgedOrigins !== getAcknowledgedRemoteOrigins()) {
        const response = await runtimeMessage<{ settings: BetaSettings }>({
          type: 'SET_SETTINGS',
          payload: { acknowledgedRemoteProviderOrigins: acknowledgedOrigins }
        });
        applySettings(response.settings || { ...currentSettings, acknowledgedRemoteProviderOrigins: acknowledgedOrigins });
      }
      await refreshProvider();
      setStatus('Provider settings saved');
    } catch (err) {
      setStatus(`Unable to save provider settings: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  providerTestBtn?.addEventListener('click', async () => {
    if (!providerBaseInput || !providerStatus) return;
    providerStatus.textContent = 'Testing connection...';
    providerStatus.style.color = '#374151';
    try {
      const response = await runtimeMessage<{ status?: { online?: boolean; lastError?: string } }>({
        type: 'PROVIDER_ACTION',
        providerId: providerSelect?.value || 'ollama',
        action: 'test',
        baseOverride: providerBaseInput.value.trim()
      });
      const status = response.status;
      if (status?.online) {
        providerStatus.textContent = 'Ollama online';
        providerStatus.style.color = '#10b981';
      } else {
        providerStatus.textContent = `Offline: ${status?.lastError || 'unknown error'}`;
        providerStatus.style.color = '#b91c1c';
      }
    } catch (err) {
      providerStatus.textContent = `Test failed: ${err instanceof Error ? err.message : String(err)}`;
      providerStatus.style.color = '#b91c1c';
    }
  });

  providerRefreshBtn?.addEventListener('click', () => {
    void refreshProvider();
  });

  providerSelect?.addEventListener('change', async () => {
    const selectedId = providerSelect.value || 'ollama';
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { activeProviderId: selectedId }
      });
      applySettings(response.settings || { ...currentSettings, activeProviderId: selectedId });
    } catch {
      applySettings({ ...currentSettings, activeProviderId: selectedId });
    }
    const selected = providerCache.find((provider) => provider.id === selectedId);
    if (selected) applyProvider(selected);
  });

  providerBaseInput?.addEventListener('input', () => {
    renderProviderSecurityNotice(providerBaseInput.value.trim());
  });

  chatModelSelect?.addEventListener('change', async () => {
    if (!chatModelSelect) return;
    const model = chatModelSelect.value;
    if (!model) return;
    try {
      await runtimeMessage<{ settings: unknown }>({
        type: 'SET_MODEL',
        key: 'chatModel',
        value: model
      });
      setStatus(`Chat model set to ${model}`);
    } catch (err) {
      setStatus(`Unable to set chat model: ${err instanceof Error ? err.message : String(err)}`, true);
      void refreshProvider();
    }
  });

  function openExtensionPage(path: string): void {
    const url = chrome.runtime.getURL(path);
    chrome.tabs.create({ url });
  }

  openManageBtn?.addEventListener('click', () => openExtensionPage('dist/beta/ui/manage/index.html'));
  openLogsBtn?.addEventListener('click', () => openExtensionPage('dist/beta/ui/logs/index.html'));
  openHighlightsBtn?.addEventListener('click', () => openExtensionPage('dist/beta/ui/highlights/index.html'));

  contextWindowInput?.addEventListener('change', async () => {
    if (!contextWindowInput) return;
    const value = Number(contextWindowInput.value);
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { contextWindowChars: value }
      });
      applySettings(response.settings || { ...currentSettings, contextWindowChars: value });
      setStatus('Context window updated');
    } catch (err) {
      setStatus(`Unable to update context window: ${err instanceof Error ? err.message : String(err)}`, true);
      contextWindowInput.value = String(currentSettings.contextWindowChars);
    }
  });

  askSourcesInput?.addEventListener('change', async () => {
    if (!askSourcesInput) return;
    const value = Number(askSourcesInput.value);
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { askMaxSources: value }
      });
      applySettings(response.settings || { ...currentSettings, askMaxSources: value });
      setStatus('Max sources updated');
    } catch (err) {
      setStatus(`Unable to update Ask sources: ${err instanceof Error ? err.message : String(err)}`, true);
      askSourcesInput.value = String(currentSettings.askMaxSources);
    }
  });

  themeSelect?.addEventListener('change', async () => {
    if (!themeSelect) return;
    const value = themeSelect.value as ThemeChoice;
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { theme: value }
      });
      applySettings(response.settings || { ...currentSettings, theme: value });
      setStatus('Theme updated');
    } catch (err) {
      setStatus(`Unable to update theme: ${err instanceof Error ? err.message : String(err)}`, true);
      themeSelect.value = currentSettings.theme;
    }
  });

  queryRewriteToggle?.addEventListener('change', async (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    try {
      await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { queryRewrite: checked } });
      setStatus('Query rewrite preference saved');
    } catch (err) {
      setStatus(`Unable to update query rewrite: ${err instanceof Error ? err.message : String(err)}`, true);
      queryRewriteToggle.checked = currentSettings.queryRewrite;
    }
  });

  searchRerankToggle?.addEventListener('change', async (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    try {
      await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { searchRerank: checked } });
      setStatus('Search reranking preference saved');
    } catch (err) {
      setStatus(`Unable to update search rerank: ${err instanceof Error ? err.message : String(err)}`, true);
      if (searchRerankToggle) searchRerankToggle.checked = currentSettings.searchRerank;
    }
  });

  askRerankToggle?.addEventListener('change', async (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    try {
      await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { askRerank: checked } });
      setStatus('Ask reranking preference saved');
    } catch (err) {
      setStatus(`Unable to update Ask rerank: ${err instanceof Error ? err.message : String(err)}`, true);
      if (askRerankToggle) askRerankToggle.checked = currentSettings.askRerank;
    }
  });

  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message?.type === 'BROWSER_EMBED_STATUS' && embeddingProviderSelect?.value === 'browser') {
      renderBrowserEmbedStatus((message as { status?: BrowserEmbedStatus }).status);
    }
  });

  enableToolsToggle?.addEventListener('change', async (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    try {
      await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { enableTools: checked } });
      setStatus('Tool usage updated');
    } catch (err) {
      setStatus(`Unable to update tools: ${err instanceof Error ? err.message : String(err)}`, true);
      enableToolsToggle.checked = currentSettings.enableTools;
    }
  });

  maxToolStepsInput?.addEventListener('change', async () => {
    const value = Number(maxToolStepsInput.value);
    try {
      await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { maxToolSteps: value } });
      setStatus('Max tool steps saved');
    } catch (err) {
      setStatus(`Unable to update tool steps: ${err instanceof Error ? err.message : String(err)}`, true);
      maxToolStepsInput.value = String(currentSettings.maxToolSteps);
    }
  });

  toolTimeoutInput?.addEventListener('change', async () => {
    const value = Number(toolTimeoutInput.value);
    try {
      await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { toolTimeoutMs: value } });
      setStatus('Tool timeout saved');
    } catch (err) {
      setStatus(`Unable to update tool timeout: ${err instanceof Error ? err.message : String(err)}`, true);
      toolTimeoutInput.value = String(currentSettings.toolTimeoutMs);
    }
  });

  logFullBodiesToggle?.addEventListener('change', async (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    try {
      await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { logFullBodies: checked } });
      setStatus('Log detail setting saved');
    } catch (err) {
      setStatus(`Unable to update log detail: ${err instanceof Error ? err.message : String(err)}`, true);
      logFullBodiesToggle.checked = currentSettings.logFullBodies;
    }
  });

  calibSimInput?.addEventListener('change', async () => {
    const value = Number(calibSimInput.value);
    try {
      await runtimeMessage<{ calibration: { wSim: number; wLLM: number } }>({
        type: 'SET_CALIBRATION',
        payload: { wSim: value }
      });
      setStatus('Similarity weight saved');
    } catch (err) {
      setStatus(`Unable to update similarity weight: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  calibLLMInput?.addEventListener('change', async () => {
    const value = Number(calibLLMInput.value);
    try {
      await runtimeMessage<{ calibration: { wSim: number; wLLM: number } }>({
        type: 'SET_CALIBRATION',
        payload: { wLLM: value }
      });
      setStatus('LLM weight saved');
    } catch (err) {
      setStatus(`Unable to update LLM weight: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });

  answerModeSelect?.addEventListener('change', async () => {
    const value = answerModeSelect.value === 'detailed' ? 'detailed' : 'concise';
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { answerMode: value }
      });
      applySettings(response.settings || { ...currentSettings, answerMode: value });
      setStatus('Answer mode updated');
    } catch (err) {
      setStatus(`Unable to update answer mode: ${err instanceof Error ? err.message : String(err)}`, true);
      answerModeSelect.value = currentSettings.answerMode;
    }
  });

  logLevelSelect?.addEventListener('change', async () => {
    const value = logLevelSelect.value as BetaSettings['logLevel'];
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { logLevel: value }
      });
      applySettings(response.settings || { ...currentSettings, logLevel: value });
      setStatus('Log level updated');
    } catch (err) {
      setStatus(`Unable to update log level: ${err instanceof Error ? err.message : String(err)}`, true);
      logLevelSelect.value = currentSettings.logLevel;
    }
  });

  try {
    chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
      if (message?.type === 'BETA_SETTINGS_UPDATED') {
        const next = message.settings as BetaSettings | undefined;
        if (next) applySettings(next);
      }
      if (message?.type === 'EMBEDDING_CONFIG_UPDATED') {
        const config = message.config as EmbeddingConfig | undefined;
        if (config) applyEmbedding(config);
      }
      if (message?.type === 'MODEL_SETTINGS_UPDATED') {
        const settings = message.settings as { chatModel?: string } | undefined;
        if (settings?.chatModel && chatModelSelect) {
          chatModelSelect.value = settings.chatModel;
        }
      }
    });
  } catch {
    // ignored
  }

  void refreshData();
  void refreshProvider();
  async function refreshCalibration(): Promise<void> {
    try {
      const response = await runtimeMessage<{ calibration: { wSim: number; wLLM: number } }>({ type: 'GET_CALIBRATION' });
      if (calibSimInput) calibSimInput.value = String(response.calibration?.wSim ?? 0.6);
      if (calibLLMInput) calibLLMInput.value = String(response.calibration?.wLLM ?? 0.4);
    } catch {
      if (calibSimInput) calibSimInput.value = '0.6';
      if (calibLLMInput) calibLLMInput.value = '0.4';
    }
  }

  void refreshCalibration();
}
