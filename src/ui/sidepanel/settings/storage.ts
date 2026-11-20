import { RECENT_VERSION_LIMIT } from '../../../shared/pageHistory';
import { bindBackupKeyControls } from '../../shared/backupKey';
import { createFileTransfers } from '../../shared/fileTransfers';
import { iconMarkup } from '../../shared/presentation';
import { bindFolderBackupControls } from './folderBackup';

function bindStorageUsage(root: HTMLElement, disclosure: HTMLDetailsElement): void {
  const usage = disclosure.querySelector<HTMLElement>('#manage-storage-usage')!;
  const refresh = disclosure.querySelector<HTMLButtonElement>('#manage-storage-refresh')!;
  let generation = 0;
  let expanded = false;
  const visible = (): boolean => disclosure.open && !root.hidden;
  const update = async (): Promise<void> => {
    const current = ++generation;
    expanded = visible();
    if (!expanded) { refresh.disabled = false; usage.setAttribute('aria-busy', 'false'); return; }
    refresh.disabled = true;
    usage.setAttribute('aria-busy', 'true');
    usage.textContent = 'Checking browser storage…';
    try {
      const estimate = await navigator.storage?.estimate();
      if (current !== generation || !visible()) return;
      const bytes = estimate?.usage;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('Unavailable');
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      const unit = bytes ? Math.min(Math.floor(Math.log2(Math.max(1, bytes)) / 10), units.length - 1) : 0;
      usage.textContent = `Estimated usage: ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${units[unit]}`;
    } catch {
      if (current === generation && visible()) usage.textContent = 'Storage estimate unavailable. Try Refresh.';
    } finally {
      if (current === generation) { refresh.disabled = false; usage.setAttribute('aria-busy', 'false'); }
    }
  };
  const onToggle = (): void => { const next = visible(); if (next !== expanded) { expanded = next; void update(); } };
  disclosure.addEventListener('toggle', onToggle);
  root.addEventListener('wr-refresh', () => { if (visible()) void update(); });
  refresh.addEventListener('click', () => { void update(); });
  window.addEventListener('wr-memory-changed', () => { void update(); });
}

export function mountStorageAndBackups(root: HTMLElement, disclosure: HTMLDetailsElement, content: HTMLElement): void {
  content.innerHTML = `
    <section class="wr-storage-block" aria-labelledby="backup-storage-heading">
      <h2 id="backup-storage-heading">Browser storage</h2>
      <div class="wr-storage-row"><p id="manage-storage-usage" class="field-note" role="status"></p><button id="manage-storage-refresh" type="button" class="text-button" aria-label="Refresh storage estimate">Refresh</button></div>
      <p class="field-note">Includes saved pages, search indexes and downloaded browser models.</p>
      <p class="field-note">Keeps the latest ${RECENT_VERSION_LIMIT} versions per page, plus any marked Keep. Clearing Chrome history won’t delete saved pages.</p>
    </section>
    <section class="wr-storage-block" aria-labelledby="backup-files-heading">
      <h2 id="backup-files-heading">Backup files</h2>
      <div class="button-row">
        <button id="manage-export-encrypted" class="secondary-button" disabled>Save encrypted backup</button>
        <label id="manage-import-label" class="secondary-button">Restore from file<input type="file" id="manage-import" accept=".json,.jsonl,.ndjson,.wrbackup,application/json,application/x-ndjson" /></label>
        <button id="manage-export" class="text-button" type="button">Save unencrypted backup</button>
        <button id="settings-transfer-stop" class="secondary-button" hidden>Stop transfer</button>
      </div>
      <p id="settings-backup-status" class="status-line" role="status"></p>
      <p class="field-note">Backups include page history. Use encryption for synced folders. Deleting pages won’t change existing backups.</p>
      <p id="manage-backup-key-status" class="field-note" role="status"></p>
      <form id="manage-backup-key-form" hidden>
        <div class="beta-field">
          <label for="manage-backup-key">Recovery key</label>
          <div class="backup-key-entry">
            <input id="manage-backup-key" type="password" required spellcheck="false" autocomplete="off" />
            <button id="manage-backup-key-copy" type="button" class="secondary-button" aria-label="Copy recovery key" disabled>Copy</button>
          </div>
        </div>
        <button id="manage-backup-key-generate" type="button" class="text-button">Generate recovery key</button>
        <label class="beta-toggle"><span>I saved a copy outside Chrome. This key won’t be shown again.</span><input id="manage-backup-key-confirm" type="checkbox" required /></label>
        <button id="manage-backup-key-save" class="secondary-button">Save recovery key</button>
      </form>
    </section>
    <details id="manage-folder-backup" class="setting-detail"><summary>Mac companion folder${iconMarkup('caret-down')}</summary><div class="setting-detail-body">
      <div class="wr-storage-row">
        <p id="manage-backup-folder" class="field-note" role="status">Choose a folder in the Mac companion.</p>
        <button id="manage-backup-connect" class="text-button" type="button">Check companion</button>
      </div>
      <div class="wr-folder-options">
        <label class="beta-toggle"><span>Automatic daily backups</span><input id="manage-backup-automatic" type="checkbox" disabled /></label>
        <label class="beta-field compact-setting">Backups to keep <input id="manage-backup-keep" type="number" min="1" max="30" value="3" required disabled /></label>
      </div>
      <p class="field-note">Automatic backups need Chrome and the companion open. Older .jsonl backups stay unencrypted.</p>
      <div class="button-row">
        <button id="manage-backup-run" class="text-button" type="button">Back up now</button>
      </div>
      <p id="manage-backup-report" class="field-note" role="status"></p>
    </div></details>
    <dialog id="manage-encrypted-restore" aria-label="Unlock encrypted backup"><form method="dialog" class="tool-disclosure-body">
      <label class="compact-setting">Backup recovery key <input type="password" autocomplete="off" spellcheck="false" /></label>
      <div class="button-row"><button value="cancel" class="text-button">Cancel</button><button value="restore" class="secondary-button">Unlock backup</button></div>
    </form></dialog>
  `;
  const status = content.querySelector<HTMLElement>('#settings-backup-status')!;
  const encryptedSave = content.querySelector<HTMLButtonElement>('#manage-export-encrypted')!;
  const unencryptedSave = content.querySelector<HTMLButtonElement>('#manage-export')!;
  const restoreInput = content.querySelector<HTMLInputElement>('#manage-import')!;
  const restoreDialog = content.querySelector<HTMLDialogElement>('#manage-encrypted-restore')!;
  const stop = content.querySelector<HTMLButtonElement>('#settings-transfer-stop')!;
  const transfers = createFileTransfers((message, error) => {
    status.textContent = message;
    status.dataset.variant = error ? 'error' : 'info';
  }, stop, [unencryptedSave, restoreInput], encryptedSave);
  bindStorageUsage(root, disclosure);
  bindBackupKeyControls(disclosure, transfers.setBackupKeyReady);
  bindFolderBackupControls(content);
  encryptedSave.addEventListener('click', () => void transfers.save(undefined, true));
  unencryptedSave.addEventListener('click', () => void transfers.save());
  restoreInput.addEventListener('change', () => {
    const file = restoreInput.files?.[0];
    if (file) void transfers.restore(file, restoreDialog);
    restoreInput.value = '';
  });
}
