import type { BrowserModelTransfer } from '../../../shared/browserModels';
import { BROWSER_EMBEDDING_MODELS } from '../../../shared/config/index';
import { sendRuntimeMessage } from '../../shared/runtime';

const activeStates = new Set(['queued', 'downloading', 'preparing', 'cancelling']);

export function createBrowserDownloadControls(): HTMLElement {
  const section = document.createElement('section');
  section.id = 'beta-browser-transfer'; section.className = 'wr-browser-transfer'; section.hidden = true;
  section.setAttribute('aria-label', 'Browser model download');
  section.innerHTML = `<p id="beta-browser-transfer-title"></p><p id="beta-browser-transfer-status" class="wr-help" role="status" aria-live="polite"></p>
    <progress id="beta-browser-transfer-progress" max="100" aria-label="Current model file progress"></progress>
    <p id="beta-browser-transfer-file" class="wr-help"></p><div class="button-row"><button id="beta-browser-transfer-cancel" type="button" class="text-button">Cancel download</button><button id="beta-browser-transfer-retry" type="button" class="secondary-button" hidden>Retry download</button></div>`;
  return section;
}

export function bindBrowserDownload(root: HTMLElement, callbacks: {
  saveSelection: (model: string, revision: string) => Promise<void>;
  finished: (download: BrowserModelTransfer) => Promise<void>;
}): { start: (model: string, revision: string) => Promise<void> } {
  const section = root.querySelector<HTMLElement>('#beta-browser-transfer')!;
  const title = section.querySelector<HTMLElement>('#beta-browser-transfer-title')!;
  const status = section.querySelector<HTMLElement>('#beta-browser-transfer-status')!;
  const progress = section.querySelector<HTMLProgressElement>('progress')!;
  const file = section.querySelector<HTMLElement>('#beta-browser-transfer-file')!;
  const cancel = section.querySelector<HTMLButtonElement>('#beta-browser-transfer-cancel')!;
  const retry = section.querySelector<HTMLButtonElement>('#beta-browser-transfer-retry')!;
  const startButton = root.querySelector<HTMLButtonElement>('#beta-download-browser-model')!;
  const models = root.querySelector<HTMLDetailsElement>('#settings-models')!;
  let download: BrowserModelTransfer | null = null;
  let run: { requestId: string; sent: boolean; cancelled: boolean } | null = null;

  function render(next: BrowserModelTransfer): void {
    if (run && next.requestId !== run.requestId) return;
    if (download && next.requestId !== download.requestId && next.startedAt < download.startedAt) return;
    const restoreFocus = section.contains(document.activeElement);
    download = next;
    const active = activeStates.has(next.state);
    section.hidden = next.state === 'ready'; startButton.disabled = active;
    title.textContent = BROWSER_EMBEDDING_MODELS.find(model => model.id === next.model && model.revision === next.revision)?.label || next.model;
    const labels = { queued: 'Waiting to start…', downloading: 'Downloading model files…', preparing: 'Preparing model…', cancelling: 'Stopping download…', cancelled: 'Download cancelled. Completed files are kept for retry.', ready: 'Model ready', error: `Download failed: ${next.error || 'Try again.'}` };
    status.textContent = labels[next.state]; status.dataset.variant = next.state === 'error' ? 'error' : 'info';
    progress.hidden = !active || next.state === 'cancelling';
    const measured = next.state === 'downloading' && next.totalBytes && next.totalBytes > 0;
    if (measured) progress.value = Math.min(100, next.loadedBytes / next.totalBytes! * 100); else progress.removeAttribute('value');
    const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
    file.textContent = next.file ? `${next.file}${next.state === 'downloading' ? ` · ${mb(next.loadedBytes)}${measured ? ` / ${mb(next.totalBytes!)} · ${Math.min(100, Math.floor(progress.value))}% of this file` : ''}` : ''}` : '';
    cancel.hidden = !active; cancel.disabled = next.state === 'cancelling'; retry.hidden = active || next.state === 'ready';
    if (restoreFocus && next.state === 'ready') startButton.focus({ preventScroll: true });
    else if (restoreFocus && !active) retry.focus({ preventScroll: true });
  }

  async function refresh(): Promise<void> {
    try {
      const response = await sendRuntimeMessage<{ download: BrowserModelTransfer | null }>({ type: 'GET_BROWSER_MODEL_DOWNLOAD' });
      if (response.download) render(response.download);
    } catch { /* The download action reports connection failures when requested. */ }
  }

  async function start(model: string, revision: string, saveSelection = true): Promise<void> {
    if (run || (download && activeStates.has(download.state))) return;
    const request = { requestId: crypto.randomUUID(), sent: false, cancelled: false };
    run = request;
    render({ requestId: request.requestId, model, revision, startedAt: Date.now(), state: 'queued', loadedBytes: 0 });
    section.scrollIntoView({ block: 'nearest' }); cancel.focus({ preventScroll: true });
    try {
      if (saveSelection) await callbacks.saveSelection(model, revision);
      if (request.cancelled) { render({ ...download!, state: 'cancelled' }); return; }
      request.sent = true;
      await sendRuntimeMessage({ type: 'DOWNLOAD_BROWSER_EMBED', requestId: request.requestId, model, revision });
      if (run !== request) return;
      render({ ...download!, state: 'ready' });
    } catch (error) {
      if (run !== request) return;
      render({ ...download!, state: request.cancelled || download?.state === 'cancelled' ? 'cancelled' : 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (run === request) { run = null; if (download) await callbacks.finished(download); }
    }
  }

  cancel.addEventListener('click', () => {
    if (!download || !activeStates.has(download.state) || download.state === 'cancelling') return;
    const current = download;
    if (run) run.cancelled = true;
    render({ ...current, state: 'cancelling' });
    if (run && !run.sent) return;
    void sendRuntimeMessage({ type: 'CANCEL_BROWSER_MODEL_DOWNLOAD', requestId: current.requestId }).then(refresh).catch(error => {
      if (download?.requestId === current.requestId && download.state === 'cancelling') { status.textContent = `Unable to confirm cancellation: ${String(error.message || error)}. Reopen Models to check its state.`; status.dataset.variant = 'error'; }
    });
  });
  retry.addEventListener('click', () => { if (download) void start(download.model, download.revision, false); });
  models.addEventListener('toggle', () => { if (models.open) void refresh(); });
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message.type === 'BROWSER_MODEL_DOWNLOAD_UPDATE' && message.download) render(message.download as BrowserModelTransfer);
  });
  return { start };
}
