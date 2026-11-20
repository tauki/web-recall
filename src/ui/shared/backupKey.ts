import { readBackupKey, storeBackupKey } from '../../shared/backupKey';
import { createRecoveryKey, importRecoveryKey } from '../../shared/encryptedBackup';

export function bindBackupKeyControls(panel: HTMLDetailsElement, onKeyReady: (ready: boolean) => void): void {
  const form = panel.querySelector<HTMLFormElement>('#manage-backup-key-form')!;
  const key = form.querySelector<HTMLInputElement>('#manage-backup-key')!;
  const copy = form.querySelector<HTMLButtonElement>('#manage-backup-key-copy')!;
  const confirmed = form.querySelector<HTMLInputElement>('#manage-backup-key-confirm')!;
  const save = form.querySelector<HTMLButtonElement>('#manage-backup-key-save')!;
  const status = panel.querySelector<HTMLElement>('#manage-backup-key-status')!;
  const report = (text: string, error = false): void => {
    status.textContent = text;
    status.classList.toggle('danger-text', error);
  };
  const updateKey = (): void => { copy.disabled = !key.value.trim(); confirmed.checked = false; };
  const clearKey = (): void => { key.value = ''; key.type = 'password'; updateKey(); };
  const render = async (): Promise<void> => {
    const configured = Boolean(await readBackupKey());
    form.hidden = configured;
    report(configured ? 'Recovery key set up. Keep your copy outside Chrome.' : 'Set up a recovery key for encrypted backups.');
    onKeyReady(configured);
  };
  panel.addEventListener('toggle', () => {
    if (panel.open) void render().catch(error => report(String(error), true));
    else clearKey();
  });
  key.addEventListener('input', updateKey);
  copy.addEventListener('click', async () => {
    const value = key.value.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (key.value.trim() === value) report('Recovery key copied.');
    } catch {
      if (key.value.trim() !== value) return;
      key.focus(); key.select();
      report('Could not copy the recovery key. Copy it manually.', true);
    }
  });
  form.querySelector('#manage-backup-key-generate')!.addEventListener('click', () => {
    key.type = 'text';
    key.value = createRecoveryKey();
    updateKey();
    key.focus(); key.select();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      if (!confirmed.checked) throw new Error('Save a copy of your recovery key before continuing.');
      await storeBackupKey(await importRecoveryKey(key.value));
      clearKey();
      await render();
    } catch (error) { report(error instanceof Error ? error.message : String(error), true); }
    finally { save.disabled = false; }
  });
}

export async function askForRecoveryKey(dialog: HTMLDialogElement, signal: AbortSignal): Promise<CryptoKey | undefined> {
  signal.throwIfAborted();
  const field = dialog.querySelector<HTMLInputElement>('input')!;
  const submitted = await new Promise<string | undefined>(resolve => {
    const onAbort = () => dialog.close('cancel');
    dialog.addEventListener('close', () => {
      signal.removeEventListener('abort', onAbort);
      const value = dialog.returnValue === 'restore' ? field.value : undefined;
      field.value = '';
      resolve(value);
    }, { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  signal.throwIfAborted();
  return submitted === undefined ? undefined : importRecoveryKey(submitted);
}
