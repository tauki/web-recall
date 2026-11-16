import { installSharedStyles, createBackLink, icon, navigateTo } from '../../shared/presentation';
import {
  DEFAULT_EMBEDDING_CONFIG as DEFAULT_EMBEDDING,
  BROWSER_EMBEDDING_MODELS,
  DEFAULT_SETTINGS,
  type BetaSettings,
  type EmbeddingConfig
} from '../../../shared/config/index';
import { getProviderOriginInfo } from '../../../shared/providerOrigin';
import { sendRuntimeMessage as runtimeMessage } from '../../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../../shared/theme';
import type { BrowserModelDownload } from '../../../shared/browserModels';
import { bindBrowserDownload, createBrowserDownloadControls } from './browserDownload';

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

function ensureStyles(): void { installSharedStyles(); }

export function renderSettingsPanel(target: HTMLElement): void {
  bindSystemThemeListener();
  ensureStyles();
  target.innerHTML = `
    <div class="beta-settings-root">
      <h1 class="beta-settings-title">Settings</h1>

      <section class="beta-card" aria-labelledby="capture-heading">
        <h2 id="capture-heading">Capture controls</h2>
        <label class="beta-toggle">
          <input type="checkbox" id="beta-pause-toggle" />
          <span>Pause automatic capture</span>
        </label>
        <p id="beta-capture-policy-note" class="beta-help"></p>
      </section>

      <section class="beta-card" id="beta-capture-setup-card" aria-labelledby="capture-setup-heading" hidden>
        <h2 id="capture-setup-heading">First-run capture setup</h2>
        <p class="beta-help">
          Web Recall starts paused by default. Choose broad capture, or save an allowlist first and resume capture only for approved domains.
        </p>
        <div class="beta-field" style="display:flex; gap:8px; flex-wrap:wrap;">
          <button id="settings-enable-broad-capture" type="button">Enable broad capture</button>
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
              <option value="browser">In-browser (experimental)</option>
          </select>
        </div>
        <div id="embedding-ollama-fields">
        <div class="beta-field">
          <label for="beta-embedding-base">Base URL</label>
          <input id="beta-embedding-base" type="url" placeholder="http://localhost:11434" />
        </div>
        <div class="beta-field">
          <label for="beta-embedding-model">Model name</label>
          <input id="beta-embedding-model" type="text" placeholder="embeddinggemma" />
        </div>
        </div>
        <div id="embedding-browser-fields" hidden>
        <p class="beta-help">Download EmbeddingGemma once from Hugging Face. It stays cached on this device; page text is processed locally. The initial download may take several minutes.</p>
        <div class="beta-field">
          <label for="beta-browser-model-select">Browser model</label>
          <select id="beta-browser-model-select" aria-describedby="beta-browser-model-help">
            ${BROWSER_EMBEDDING_MODELS.map((model) => `<option value="${model.id}">${model.label}</option>`).join('')}
            <option value="custom">Custom model or revision</option>
          </select>
        </div>
        <p id="beta-browser-model-help" class="beta-help">EmbeddingGemma 2 requires WebGPU and downloads only its text model (about 175 MB of weights, plus tokenizer files). The original model works without WebGPU. Existing pages keep their embeddings when you switch. Use Re-embed in Memory Manager to update them explicitly; Fill missing does not replace existing vectors.</p>
        <details id="beta-browser-model-advanced"><summary>Model configuration</summary>
        <div class="beta-field">
          <label for="beta-embedding-browser-model">Browser model (Hugging Face)</label>
          <input id="beta-embedding-browser-model" type="text" placeholder="onnx-community/embeddinggemma-300m-ONNX" />
        </div>
        <div class="beta-field">
          <label for="beta-embedding-browser-rev">Browser model revision</label>
          <input id="beta-embedding-browser-rev" type="text" placeholder="commit hash" />
        </div>
        </details>
        <button id="beta-download-browser-model" type="button">Save &amp; download model</button>
        <button id="beta-manage-browser-models" type="button">Manage downloads</button>
        <p id="beta-embedding-browser-status" class="beta-help">Download EmbeddingGemma once from Hugging Face; it is cached on this device. The download is large and may take several minutes. Captured text is processed locally.</p>
        </div>
        <button id="beta-save-embedding" type="button">Save embedding settings</button>
      </section>

      <section class="beta-card" aria-labelledby="downloaded-models-heading">
        <h2 id="downloaded-models-heading">Downloaded models</h2>
        <p class="beta-help">Browser model files cached by Web Recall. Removing a download keeps your saved pages and embeddings. Download it again before using that model.</p>
        <button id="beta-refresh-browser-models" type="button">Refresh downloads</button>
        <p id="beta-browser-models-status" class="beta-help" role="status"></p>
        <div id="beta-browser-models-list"></div>
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
        <div id="beta-apple-options" hidden>
          <p class="beta-help">Open the Web Recall companion from Applications. Its menu bar shows status and controls native work. Inference stays on this Mac unless you enable Private Cloud Compute below. Model context size is detected at runtime; embeddings are unchanged.</p>
          <label class="beta-toggle"><span>Use Apple Private Cloud Compute (optional)</span><input type="checkbox" id="beta-apple-cloud" /></label>
          <p class="beta-help">PCC sends prompts and selected saved passages to Apple's servers. Requires macOS 27, network access, eligibility and a companion signed with Apple's managed PCC entitlement. It never activates automatically.</p>
        </div>
      </section>

      <section class="beta-card" aria-labelledby="ask-heading">
        <h2 id="ask-heading">Retrieval, Ask and logging</h2>
        <div class="beta-field">
          <label for="beta-context-window">Context window (characters)</label>
          <input id="beta-context-window" type="number" min="400" max="6000" step="100" />
        </div>
        <div class="beta-field">
          <label for="settings-ask-sources">Initial sources for Auto</label>
          <input id="settings-ask-sources" type="number" min="1" max="10" aria-describedby="settings-source-help" /><p id="settings-source-help" class="beta-help">Starting point for Ask’s Auto mode. An explicit number in Ask overrides this; tools can retrieve more.</p>
        </div>
        <div class="beta-field">
          <label for="beta-answer-mode">Answer mode</label>
          <select id="beta-answer-mode">
            <option value="concise">Concise (2–4 sentences)</option>
            <option value="detailed">Detailed (thorough explanations)</option>
          </select>
        </div>
        <div class="beta-field">
          <label for="beta-log-level">Capture log level</label>
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
          <label for="beta-max-tool-steps">Max tool calls</label>
          <input id="beta-max-tool-steps" type="number" min="0" />
        </div>
        <label class="beta-toggle"><input type="checkbox" id="beta-log-full" /> Log full capture payloads</label>
        <p class="beta-help">These settings control query rewriting, Search reranking, and how Ask builds answers from captured pages. Max tool calls uses 0 as no user limit; a 100-call safety allowance still applies. Model inference has no automatic timeout; use Stop in Ask, Search or embedding backfill to cancel.</p>
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

  const shell = target.querySelector<HTMLElement>('.beta-settings-root')!;
  shell.prepend(createBackLink());
  target.classList.add('wr-page');
  const status = target.querySelector<HTMLElement>('#beta-settings-status')!;
  function wrap(card: HTMLElement, label: string, id?: string): HTMLDetailsElement {
    const details = document.createElement('details'); details.className = 'setting-detail';
    if (id) details.id = id;
    const summary = document.createElement('summary'); summary.append(document.createTextNode(label), icon('caret-down'));
    const body = document.createElement('div'); body.className = 'setting-detail-body'; body.append(card);
    details.append(summary, body); return details;
  }
  const askCard = target.querySelector<HTMLElement>('#ask-heading')!.closest('section')!;
  const split = (label: string, ids: string[], help: string): HTMLElement => {
    const card = document.createElement('section'); card.className = 'beta-card';
    for (const id of ids) { const field = target.querySelector('#' + id)?.closest('.beta-field, .beta-toggle'); if (field) card.append(field); }
    if (help) { const p = document.createElement('p'); p.className = 'beta-help'; p.textContent = help; card.append(p); }
    return wrap(card, label, label === 'Logging' ? 'settings-logging' : undefined);
  };
  const retrieval = split('Retrieval & answers', ['beta-context-window', 'settings-ask-sources', 'beta-answer-mode', 'beta-query-rewrite', 'beta-search-rerank', 'beta-ask-rerank'], 'Auto is an initial retrieval count, not a hard citation limit.');
  const tools = split('Ask tools', ['beta-enable-tools', 'beta-max-tool-steps'], '0 means no user limit. Model inference has no automatic timeout; use Stop to cancel.');
  const logging = split('Logging', ['beta-log-level', 'beta-log-full'], 'Choose which capture events and payloads are stored in Logs.');
  const groups = [
    ['capture', 'Capture', ['capture-heading', 'domain-heading', 'capture-setup-heading']],
    ['models', 'Models', ['embed-heading', 'provider-heading', 'downloaded-models-heading']],
    ['appearance', 'Appearance', ['theme-heading']],
    ['advanced', 'Advanced', ['tools-heading']]
  ] as const;
  for (const [id, label, headings] of groups) {
    const details = document.createElement('details'); details.id = `settings-${id}`; details.className = 'settings-group'; details.name = 'settings-groups';
    const summary = document.createElement('summary');
    const labelWrap = document.createElement('span'); labelWrap.append(document.createTextNode(label));
    const description = document.createElement('small'); description.className = 'wr-setting-summary'; description.id = `settings-${id}-summary`; labelWrap.append(description);
    summary.append(labelWrap, icon('caret-down')); details.append(summary);
    const content = document.createElement('div'); content.className = 'wr-settings-group'; details.append(content);
    if (id === 'advanced') content.append(retrieval, tools, logging);
    for (const heading of headings) {
      const card = target.querySelector<HTMLElement>(`#${heading}`)?.closest<HTMLElement>('section');
      if (!card) continue;
      if (heading === 'capture-heading' || id === 'appearance') content.append(card);
      else { const nested = wrap(card, heading === 'domain-heading' ? 'Domain rules' : card.querySelector('h2')!.textContent!, heading === 'downloaded-models-heading' ? 'settings-downloads' : undefined); if (card.hidden) nested.hidden = true; content.append(nested); }
      if (heading === 'embed-heading') content.append(createBrowserDownloadControls());
    }
    shell.append(details);
  }
  askCard.remove();
  shell.append(status);
  target.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.classList.add(['beta-save-rules', 'beta-save-embedding', 'beta-provider-save'].includes(button.id) ? 'primary-button' : 'secondary-button'));
  installSharedStyles();
  attachBehavior(target);
}

function attachBehavior(root: HTMLElement): void {
  const pauseToggle = root.querySelector<HTMLInputElement>('#beta-pause-toggle');
  const captureSetupCard = root.querySelector<HTMLElement>('#beta-capture-setup-card');
  const enableBroadCaptureBtn = root.querySelector<HTMLButtonElement>('#settings-enable-broad-capture');
  const saveAllowlistAndResumeBtn = root.querySelector<HTMLButtonElement>('#beta-save-allowlist-and-resume');
  const allowInput = root.querySelector<HTMLTextAreaElement>('#beta-allowlist-input');
  const denyInput = root.querySelector<HTMLTextAreaElement>('#beta-denylist-input');
  const saveRulesBtn = root.querySelector<HTMLButtonElement>('#beta-save-rules');
  const baseInput = root.querySelector<HTMLInputElement>('#beta-embedding-base');
  const modelInput = root.querySelector<HTMLInputElement>('#beta-embedding-model');
  const embeddingProviderSelect = root.querySelector<HTMLSelectElement>('#beta-embedding-provider');
  const browserModelSelect = root.querySelector<HTMLSelectElement>('#beta-browser-model-select');
  const browserModelInput = root.querySelector<HTMLInputElement>('#beta-embedding-browser-model');
  const browserRevisionInput = root.querySelector<HTMLInputElement>('#beta-embedding-browser-rev');
  const downloadBrowserBtn = root.querySelector<HTMLButtonElement>('#beta-download-browser-model');
  const browserStatusLine = root.querySelector<HTMLParagraphElement>('#beta-embedding-browser-status');
  const saveEmbeddingBtn = root.querySelector<HTMLButtonElement>('#beta-save-embedding');
  const providerSelect = root.querySelector<HTMLSelectElement>('#beta-provider-select');
  const contextWindowInput = root.querySelector<HTMLInputElement>('#beta-context-window');
  const askSourcesInput = root.querySelector<HTMLInputElement>('#settings-ask-sources');
  const themeSelect = root.querySelector<HTMLSelectElement>('#beta-theme-select');
  const answerModeSelect = root.querySelector<HTMLSelectElement>('#beta-answer-mode');
  const logLevelSelect = root.querySelector<HTMLSelectElement>('#beta-log-level');
  const queryRewriteToggle = root.querySelector<HTMLInputElement>('#beta-query-rewrite');
  const searchRerankToggle = root.querySelector<HTMLInputElement>('#beta-search-rerank');
  const askRerankToggle = root.querySelector<HTMLInputElement>('#beta-ask-rerank');
  const enableToolsToggle = root.querySelector<HTMLInputElement>('#beta-enable-tools');
  const maxToolStepsInput = root.querySelector<HTMLInputElement>('#beta-max-tool-steps');
  const logFullBodiesToggle = root.querySelector<HTMLInputElement>('#beta-log-full');
  const providerBaseInput = root.querySelector<HTMLInputElement>('#beta-provider-base');
  const chatModelSelect = root.querySelector<HTMLSelectElement>('#beta-chat-model');
  const providerSaveBtn = root.querySelector<HTMLButtonElement>('#beta-provider-save');
  const providerTestBtn = root.querySelector<HTMLButtonElement>('#beta-provider-test');
  const providerRefreshBtn = root.querySelector<HTMLButtonElement>('#beta-provider-refresh');
  const providerStatus = root.querySelector<HTMLParagraphElement>('#beta-provider-status');
  const providerSecurity = root.querySelector<HTMLParagraphElement>('#beta-provider-security');
  const appleCloud = root.querySelector<HTMLInputElement>('#beta-apple-cloud')!;
  const providerNotes = root.querySelector<HTMLParagraphElement>('#beta-provider-notes');
  const openManageBtn = root.querySelector<HTMLButtonElement>('#beta-open-manage');
  const openLogsBtn = root.querySelector<HTMLButtonElement>('#beta-open-logs');
  const openHighlightsBtn = root.querySelector<HTMLButtonElement>('#beta-open-highlights');
  const statusLine = root.querySelector<HTMLParagraphElement>('#beta-settings-status');
  const downloads = root.querySelector<HTMLDetailsElement>('#settings-downloads')!;
  const downloadsList = root.querySelector<HTMLElement>('#beta-browser-models-list')!;
  const downloadsStatus = root.querySelector<HTMLElement>('#beta-browser-models-status')!;
  const refreshDownloadsButton = root.querySelector<HTMLButtonElement>('#beta-refresh-browser-models')!;
  let downloadsBusy = false, downloadsGeneration = 0;

  let currentSettings: BetaSettings = { ...DEFAULT_SETTINGS };

  function setDownloadsStatus(text: string, error = false): void {
    downloadsStatus.textContent = text;
    downloadsStatus.dataset.variant = error ? 'error' : 'info';
  }

  function setDownloadsBusy(busy: boolean): void {
    downloadsBusy = busy;
    refreshDownloadsButton.disabled = busy;
    downloadsList.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy; });
  }

  async function refreshDownloads(): Promise<boolean> {
    const generation = ++downloadsGeneration;
    setDownloadsStatus('Reading downloaded files…');
    try {
      const [response, saved] = await Promise.all([
        runtimeMessage<{ models: BrowserModelDownload[] }>({ type: 'LIST_BROWSER_MODELS' }),
        runtimeMessage<{ config: EmbeddingConfig }>({ type: 'GET_EMBEDDING_CONFIG' })
      ]);
      if (generation !== downloadsGeneration) return false;
      const open = new Set([...downloadsList.querySelectorAll<HTMLDetailsElement>('details[open]')].map(row => row.dataset.key));
      downloadsList.replaceChildren();
      for (const model of response.models || []) {
        const selected = saved.config?.provider === 'browser' && model.model === saved.config.browserModel && model.revision === saved.config.browserRevision;
        const preset = BROWSER_EMBEDDING_MODELS.find(entry => entry.id === model.model && entry.revision === model.revision);
        const row = document.createElement('details'); row.className = 'wr-model-download'; row.dataset.key = JSON.stringify([model.model, model.revision]); row.open = open.has(row.dataset.key);
        const summary = document.createElement('summary');
        const title = document.createElement('span'); title.textContent = preset?.label || model.model;
        const meta = document.createElement('small'); meta.className = 'wr-help';
        const size = model.sizeBytes === null ? 'Size unavailable' : `~${(model.sizeBytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
        meta.textContent = [selected ? 'Selected' : '', model.hasWeights ? '' : 'Partial download', size, `${model.fileCount} ${model.fileCount === 1 ? 'file' : 'files'}`].filter(Boolean).join(' · ');
        const label = document.createElement('span'); label.append(title, meta); summary.append(label, icon('caret-down'));
        const body = document.createElement('div'); body.className = 'wr-model-download-body';
        const identity = document.createElement('p'); identity.className = 'wr-help'; identity.textContent = `${model.model}\nRevision ${model.revision}`; body.append(identity);
        const actions = document.createElement('div'); actions.className = 'button-row';
        if (!selected && model.hasWeights) {
          const use = document.createElement('button'); use.className = 'secondary-button'; use.textContent = 'Use model'; use.setAttribute('aria-label', `Use ${preset?.label || model.model}`);
          use.addEventListener('click', () => { void manageDownload(async () => {
            const response = await runtimeMessage<{ config: EmbeddingConfig; settings?: BetaSettings }>({ type: 'SET_EMBEDDING_CONFIG', payload: { provider: 'browser', browserModel: model.model, browserRevision: model.revision } });
            if (response.settings) applySettings(response.settings);
            applyEmbedding(response.config);
          }, 'Selecting model…', 'Model selected. Existing pages keep their embeddings.'); }); actions.append(use);
        }
        const remove = document.createElement('button'); remove.className = 'text-button danger-text'; remove.textContent = 'Remove download'; remove.setAttribute('aria-label', `Remove ${preset?.label || model.model}`);
        const cancel = document.createElement('button'); cancel.className = 'text-button'; cancel.textContent = 'Cancel'; cancel.hidden = true;
        const confirm = document.createElement('p'); confirm.className = 'wr-help'; confirm.textContent = 'Remove these cached files?'; confirm.hidden = true; body.append(confirm);
        let confirming = false;
        cancel.addEventListener('click', () => {
          confirming = false; cancel.hidden = confirm.hidden = true;
          remove.textContent = 'Remove download'; remove.setAttribute('aria-label', `Remove ${preset?.label || model.model}`); remove.focus();
        });
        remove.addEventListener('click', () => {
          if (downloadsBusy) return;
          if (!confirming) {
            confirming = true; cancel.hidden = confirm.hidden = false;
            remove.textContent = 'Confirm removal'; remove.setAttribute('aria-label', `Confirm removal of ${preset?.label || model.model}`); remove.focus(); return;
          }
          void manageDownload(() => runtimeMessage({ type: 'DELETE_BROWSER_MODEL', model: model.model, revision: model.revision }), 'Removing download. Waiting for current model work to finish…', 'Download removed. Saved pages and embeddings are kept.');
        });
        actions.append(remove, cancel); body.append(actions); row.append(summary, body); downloadsList.append(row);
      }
      if (!downloadsList.children.length) { const empty = document.createElement('p'); empty.className = 'wr-help'; empty.textContent = 'No browser models downloaded. Choose a model in Embedding provider to download it.'; downloadsList.append(empty); }
      setDownloadsStatus(''); setDownloadsBusy(downloadsBusy);
      return true;
    } catch (error) { if (generation === downloadsGeneration) setDownloadsStatus(`Unable to read downloads: ${error instanceof Error ? error.message : String(error)}`, true); return false; }
  }

  async function manageDownload(action: () => Promise<unknown>, pending: string, success: string): Promise<void> {
    if (downloadsBusy) return;
    const focusedKey = (document.activeElement as HTMLElement | null)?.closest<HTMLDetailsElement>('.wr-model-download')?.dataset.key;
    let focusTarget: HTMLElement | null = null;
    setDownloadsBusy(true); downloadsGeneration++; setStatus(''); setDownloadsStatus(pending);
    try {
      await action();
      if (await refreshDownloads()) {
        setDownloadsStatus(success);
        const row = [...downloadsList.querySelectorAll<HTMLDetailsElement>('.wr-model-download')].find(row => row.dataset.key === focusedKey);
        focusTarget = row?.querySelector<HTMLElement>('summary') || refreshDownloadsButton;
      }
    }
    catch (error) { setDownloadsStatus(`Unable to update download: ${error instanceof Error ? error.message : String(error)}`, true); }
    finally { setDownloadsBusy(false); focusTarget?.focus({ preventScroll: true }); }
  }

  downloads.addEventListener('toggle', () => { if (downloads.open && !downloadsBusy) void refreshDownloads(); });
  refreshDownloadsButton.addEventListener('click', () => { if (!downloadsBusy) void refreshDownloads(); });
  root.querySelector('#beta-manage-browser-models')?.addEventListener('click', () => {
    root.querySelector<HTMLDetailsElement>('#settings-models')!.open = true; downloads.open = true;
    downloads.querySelector<HTMLElement>('summary')!.focus(); downloads.scrollIntoView({ block: 'nearest' });
  });

  function setStatus(text: string, isError = false): void {
    if (!statusLine) return;
    statusLine.textContent = text;
    statusLine.dataset.variant = isError ? 'error' : 'info';
    const card = document.activeElement?.closest<HTMLElement>('.beta-card');
    if (card && root.contains(card)) {
      let feedback = card.querySelector<HTMLElement>('.wr-setting-feedback');
      if (!feedback) { feedback = document.createElement('p'); feedback.className = 'wr-setting-feedback'; card.append(feedback); }
      feedback.textContent = text; feedback.dataset.variant = isError ? 'error' : 'info';
    }
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
    providerSecurity.style.color = acknowledged ? '#92400e' : 'var(--error)';
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
    const apple = provider.id === 'apple';
    root.querySelector<HTMLElement>('#beta-apple-options')!.hidden = !apple;
    providerBaseInput!.closest<HTMLElement>('.beta-field')!.hidden = apple;
    if (providerSaveBtn) providerSaveBtn.hidden = apple;
    if (providerRefreshBtn) providerRefreshBtn.hidden = apple;
    if (providerSecurity) providerSecurity.hidden = apple;
    appleCloud.checked = currentSettings.applePrivateCloud === true;
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
      chatModelSelect.disabled = apple || models.length === 0;
    }
    if (providerStatus) {
      providerStatus.textContent = provider.status?.online ? `${provider.name} online` : `Offline: ${provider.status?.lastError || 'unknown error'}`;
      providerStatus.style.color = provider.status?.online ? 'var(--text)' : 'var(--error)';
    }
    syncSummaries();
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
      }
    } catch (err) {
      if (providerStatus) {
        providerStatus.textContent = `Unable to load provider: ${err instanceof Error ? err.message : String(err)}`;
        providerStatus.style.color = 'var(--error)';
      }
    }
  }

  function syncSummaries(): void {
    const chatProvider = providerCache.find((provider) => provider.id === currentSettings.activeProviderId);
    const descriptions: Record<string, string> = {
      capture: `${currentSettings.paused ? 'Paused' : 'Automatic'} · ${currentSettings.allowlist.length ? `${currentSettings.allowlist.length} allowed domains` : 'All sites'}`,
      models: `${embeddingProviderSelect?.value === 'browser' ? 'In-browser' : 'Ollama'} embeddings · ${chatProvider ? `${chatProvider.name} chat` : 'Chat provider not loaded'}`,
      appearance: themeSelect?.selectedOptions[0]?.textContent || 'Light', advanced: 'Retrieval, answers & tools'
    };
    for (const [id, text] of Object.entries(descriptions)) { const line = root.querySelector('#settings-' + id + '-summary'); if (line) line.textContent = text; }
  }

  function applySettings(settings: BetaSettings): void {
    const previousProviderId = currentSettings.activeProviderId;
    currentSettings = settings;
    appleCloud.checked = settings.applePrivateCloud === true;
    const captureNote = root.querySelector('#beta-capture-policy-note');
    if (captureNote) captureNote.textContent = settings.paused ? 'Automatic capture is paused. Manual capture still follows your domain rules.' : 'Automatic capture is on and follows your domain rules.';
    if (captureSetupCard) {
      captureSetupCard.hidden = settings.captureSetupComplete;
      const wrapper = captureSetupCard.closest('details'); if (wrapper) wrapper.hidden = settings.captureSetupComplete;
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
    if (logFullBodiesToggle) logFullBodiesToggle.checked = !!settings.logFullBodies;
    applyTheme(settings.theme || 'light');
    syncSummaries();
    const allowlistCount = settings.allowlist.length;
    if (saveAllowlistAndResumeBtn) {
      saveAllowlistAndResumeBtn.disabled = allowlistCount === 0;
    }
    if (providerBaseInput) {
      renderProviderSecurityNotice(providerBaseInput.value);
    }
    if (previousProviderId !== settings.activeProviderId) {
      const provider = providerCache.find((entry) => entry.id === settings.activeProviderId);
      if (provider) applyProvider(provider);
    }
  }

  function applyEmbedding(config: EmbeddingConfig): void {
    void Promise.resolve().then(syncSummaries);
    if (baseInput) baseInput.value = config.baseUrl || '';
    if (modelInput) modelInput.value = config.model || '';
    if (browserModelInput) browserModelInput.value = config.browserModel || DEFAULT_EMBEDDING.browserModel || '';
    if (browserRevisionInput) browserRevisionInput.value = config.browserRevision || DEFAULT_EMBEDDING.browserRevision || '';
    syncBrowserModelSelection();
    if (embeddingProviderSelect) {
      embeddingProviderSelect.value = config.provider === 'browser' ? 'browser' : 'ollama';
      const isBrowser = embeddingProviderSelect.value === 'browser';
      root.querySelector<HTMLElement>('#embedding-ollama-fields')!.hidden = isBrowser;
      root.querySelector<HTMLElement>('#embedding-browser-fields')!.hidden = !isBrowser;
      if (baseInput) baseInput.disabled = isBrowser;
      if (modelInput) modelInput.disabled = isBrowser;
      if (downloadBrowserBtn) downloadBrowserBtn.style.display = isBrowser ? 'inline-flex' : 'none';
      if (browserStatusLine) browserStatusLine.style.display = isBrowser ? 'block' : 'none';
    }
    if (config.provider === 'browser') {
      void refreshBrowserEmbedStatus();
    }
  }

  function syncBrowserModelSelection(): void {
    const preset = BROWSER_EMBEDDING_MODELS.find((model) =>
      model.id === browserModelInput?.value && model.revision === browserRevisionInput?.value);
    if (browserModelSelect) browserModelSelect.value = preset?.id || 'custom';
    if (browserModelInput) browserModelInput.readOnly = Boolean(preset);
    if (browserRevisionInput) browserRevisionInput.readOnly = Boolean(preset);
    const details = root.querySelector<HTMLDetailsElement>('#beta-browser-model-advanced');
    if (details) details.open = !preset;
  }

  browserModelSelect?.addEventListener('change', () => {
    const preset = BROWSER_EMBEDDING_MODELS.find((model) => model.id === browserModelSelect.value);
    if (preset && browserModelInput && browserRevisionInput) {
      browserModelInput.value = preset.id;
      browserRevisionInput.value = preset.revision;
      syncBrowserModelSelection();
    } else {
      if (browserModelInput) browserModelInput.readOnly = false;
      if (browserRevisionInput) browserRevisionInput.readOnly = false;
      const details = root.querySelector<HTMLDetailsElement>('#beta-browser-model-advanced');
      if (details) details.open = true;
    }
    updateBrowserStatus('Selection changed. Save settings to use this model, or Save & download to prepare it. Existing pages will not be re-embedded.');
  });

  function updateBrowserStatus(text: string, isError = false): void {
    if (!browserStatusLine) return;
    browserStatusLine.textContent = text;
    browserStatusLine.style.color = isError ? 'var(--error)' : 'var(--muted)';
    browserStatusLine.setAttribute('role', 'status');
  }

  function renderBrowserEmbedStatus(status?: BrowserEmbedStatus): void {
    if (!status) {
      updateBrowserStatus('Unable to determine browser embedding status', true);
      return;
    }
    if (status.model !== browserModelInput?.value.trim() || status.revision !== browserRevisionInput?.value.trim()) {
      updateBrowserStatus('Save settings to use the selected model. Existing pages will not be re-embedded.');
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
      updateBrowserStatus('Downloading EmbeddingGemma… Keep this browser open. This may take several minutes.');
      return;
    }
    if (status.ready) {
      updateBrowserStatus('Model ready — embeddings run on this device.');
      return;
    }
    if (status.state === 'error') {
      updateBrowserStatus(status.lastError || 'Browser embeddings are unavailable.', true);
      return;
    }
    updateBrowserStatus('Ready to download. Save & download model to prepare browser embeddings.');
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
      setStatus('');
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

  function confirmRemoteProvider(baseUrl: string): boolean {
    const info = getProviderOriginInfo(baseUrl);
    if (!info.isValid || !info.isRemote || !info.origin || getAcknowledgedRemoteOrigins().includes(info.origin)) return true;
    const confirmed = window.confirm(
      `This provider is remote (${info.origin}). Captured text, Ask context, and prompts may leave this machine. Save this provider anyway?`
    );
    if (!confirmed) setStatus('Remote provider change cancelled');
    return confirmed;
  }

  saveEmbeddingBtn?.addEventListener('click', async () => {
    if (!baseInput || !modelInput) return;
    const baseUrl = baseInput.value.trim();
    const model = modelInput.value.trim();
    const provider = embeddingProviderSelect?.value === 'browser' ? 'browser' : 'ollama';
    if (provider === 'ollama' && !confirmRemoteProvider(baseUrl)) return;
    const browserModel = browserModelInput?.value.trim();
    const browserRevision = browserRevisionInput?.value.trim();
    try {
      const response = await runtimeMessage<{ config: EmbeddingConfig; settings?: BetaSettings }>({
        type: 'SET_EMBEDDING_CONFIG',
        payload: { baseUrl, model, provider, browserModel, browserRevision },
        acknowledgeRemoteOrigin: provider === 'ollama'
      });
      if (response.settings) applySettings(response.settings);
      applyEmbedding(response.config || { baseUrl, model });
      if (downloads.open) await refreshDownloads();
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

  const browserDownload = bindBrowserDownload(root, {
    async saveSelection(model, revision) {
      const response = await runtimeMessage<{ config: EmbeddingConfig; settings?: BetaSettings }>({ type: 'SET_EMBEDDING_CONFIG', payload: { provider: 'browser', browserModel: model, browserRevision: revision } });
      if (response.settings) applySettings(response.settings);
      applyEmbedding(response.config || { ...DEFAULT_EMBEDDING, provider: 'browser', browserModel: model, browserRevision: revision });
    },
    async finished(download) {
      await refreshBrowserEmbedStatus();
      if (downloads.open) await refreshDownloads();
      if (download.state === 'ready') setStatus('Browser model ready');
    }
  });
  downloadBrowserBtn?.addEventListener('click', () => { void browserDownload.start(browserModelInput?.value.trim() || '', browserRevisionInput?.value.trim() || ''); });

  providerSaveBtn?.addEventListener('click', async () => {
    if (!providerBaseInput) return;
    const baseUrl = providerBaseInput.value.trim();
    if (!confirmRemoteProvider(baseUrl)) return;
    try {
      const response = await runtimeMessage<{ providers: unknown; settings?: BetaSettings }>({
        type: 'SET_PROVIDER_SETTING',
        providerId: providerSelect?.value || 'ollama',
        key: 'baseUrl',
        value: baseUrl,
        acknowledgeRemoteOrigin: true
      });
      if (response.settings) applySettings(response.settings);
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
      const response = await runtimeMessage<{ status?: { online?: boolean; lastError?: string; contextTokens?: number } }>({
        type: 'PROVIDER_ACTION',
        providerId: providerSelect?.value || 'ollama',
        action: 'test',
        baseOverride: providerBaseInput.value.trim()
      });
      const status = response.status;
      if (status?.online) {
        providerStatus.textContent = `${providerSelect?.selectedOptions[0]?.textContent || 'Provider'} online${status.contextTokens ? ` · ${status.contextTokens.toLocaleString()}-token context` : ''}`;
        providerStatus.style.color = 'var(--text)';
      } else {
        providerStatus.textContent = `Offline: ${status?.lastError || 'unknown error'}`;
        providerStatus.style.color = 'var(--error)';
      }
    } catch (err) {
      providerStatus.textContent = `Test failed: ${err instanceof Error ? err.message : String(err)}`;
      providerStatus.style.color = 'var(--error)';
    }
  });

  providerRefreshBtn?.addEventListener('click', () => {
    void refreshProvider();
  });

  providerSelect?.addEventListener('change', async () => {
    const selectedId = providerSelect.value || 'ollama';
    try {
      if (selectedId === 'apple' && !(await chrome.permissions.request({ permissions: ['nativeMessaging'] }))) {
        providerSelect.value = currentSettings.activeProviderId;
        setStatus('Apple helper access was not granted. Your previous provider is unchanged.'); return;
      }
      const response = await runtimeMessage<{ settings: BetaSettings }>({
        type: 'SET_SETTINGS',
        payload: { activeProviderId: selectedId }
      });
      applySettings(response.settings || { ...currentSettings, activeProviderId: selectedId });
    } catch {
      providerSelect.value = currentSettings.activeProviderId;
      setStatus('Unable to change provider. Your previous provider is still selected.');
      return;
    }
    const selected = providerCache.find((provider) => provider.id === selectedId);
    if (selected) applyProvider(selected);
    await refreshProvider();
  });

  appleCloud.addEventListener('change', async () => {
    const enabled = appleCloud.checked;
    if (enabled && !window.confirm('Enable Apple Private Cloud Compute? Your prompts and selected saved passages will be sent to Apple servers. This needs an eligible Mac and an entitled companion; it will not silently fall back to another provider.')) {
      appleCloud.checked = currentSettings.applePrivateCloud; return;
    }
    appleCloud.disabled = true;
    try {
      const response = await runtimeMessage<{ settings: BetaSettings }>({ type: 'SET_APPLE_CLOUD', enabled, acknowledgeCloud: enabled });
      applySettings(response.settings); await refreshProvider();
      setStatus(enabled ? 'Apple Private Cloud Compute selected. Test the helper before asking.' : 'Apple on-device inference selected.');
    } catch (error) { appleCloud.checked = currentSettings.applePrivateCloud; setStatus(`Unable to change Apple mode: ${String(error)}`, true); }
    finally { appleCloud.disabled = false; }
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
    const view = path.includes('/manage/') ? 'manage' : path.includes('/logs/') ? 'logs' : 'highlights';
    if (!navigateTo(view)) chrome.tabs.create({ url });
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
      setStatus('Initial sources updated');
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
}
