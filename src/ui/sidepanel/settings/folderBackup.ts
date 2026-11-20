import { sendRuntimeMessage } from '../../shared/runtime';

type FolderStatus = { automatic: boolean; keep: number; folder?: string; message?: string; savedAt?: number; error?: boolean; busy?: boolean };
type FolderSettings = Pick<FolderStatus, 'automatic' | 'keep'>;

export function bindFolderBackupControls(root: HTMLElement): void {
  const panel = root.querySelector<HTMLDetailsElement>('#manage-folder-backup')!;
  const checkbox = panel.querySelector<HTMLInputElement>('#manage-backup-automatic')!;
  const keep = panel.querySelector<HTMLInputElement>('#manage-backup-keep')!;
  const run = panel.querySelector<HTMLButtonElement>('#manage-backup-run')!;
  const connect = panel.querySelector<HTMLButtonElement>('#manage-backup-connect')!;
  const folder = panel.querySelector<HTMLElement>('#manage-backup-folder')!;
  const report = panel.querySelector<HTMLElement>('#manage-backup-report')!;
  let busy = false;
  let saved: FolderSettings | undefined;
  let settingsWrites = Promise.resolve();

  const showSettings = (): void => {
    if (!saved) return;
    checkbox.checked = saved.automatic;
    keep.value = String(saved.keep);
  };

  const display = (text: string, error = false): void => {
    report.textContent = text;
    report.classList.toggle('danger-text', error);
  };
  const showStatus = (status: FolderStatus, probe = false): void => {
    if (probe) folder.textContent = status.folder || 'Choose a folder in the Mac companion dashboard.';
    const last = status.savedAt ? `Last backup: ${new Date(status.savedAt).toLocaleString()}.` : 'No successful folder backup yet.';
    display(status.busy ? 'Backup running…' : [status.message, last].filter(Boolean).join(' '), status.error);
  };
  const getStatus = (probe = false): Promise<FolderStatus> => sendRuntimeMessage({ type: 'GET_FOLDER_BACKUP', probe });
  const perform = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    for (const control of [checkbox, keep, run, connect]) control.disabled = true;
    try { await work(); }
    catch (error) { display(error instanceof Error ? error.message : String(error), true); }
    finally {
      busy = false;
      checkbox.disabled = keep.disabled = !saved;
      run.disabled = connect.disabled = false;
    }
  };
  const grant = async (): Promise<void> => {
    if (!chrome.permissions?.request || !await chrome.permissions.request({ permissions: ['nativeMessaging'] })) {
      throw new Error('Allow the Mac companion connection to use folder backups.');
    }
  };
  panel.addEventListener('toggle', () => {
    if (!panel.open) return;
    void perform(async () => {
      await settingsWrites;
      const status = await getStatus();
      saved = { automatic: status.automatic, keep: status.keep };
      showSettings();
      showStatus(status);
      if (await chrome.permissions?.contains?.({ permissions: ['nativeMessaging'] })) showStatus(await getStatus(true), true);
    });
  });
  connect.addEventListener('click', () => void perform(async () => {
    await grant();
    showStatus(await getStatus(true), true);
  }));
  const saveSettings = (change: { automatic: boolean } | { keep: number }): void => {
    if (!saved || busy) return;
    const permission = 'automatic' in change && change.automatic
      ? grant().catch(error => ({ error }))
      : undefined;
    settingsWrites = settingsWrites.then(async () => {
      const previous = saved!;
      const next = { ...previous, ...change };
      if (previous.automatic === next.automatic && previous.keep === next.keep) return;
      try {
        const enabling = next.automatic && !previous.automatic;
        if (enabling) {
          const denied = await permission;
          if (denied) throw denied.error;
          const status = await getStatus(true);
          showStatus(status, true);
          if (!status.folder) throw new Error('Choose a folder in the Mac companion dashboard before turning on automatic backups.');
        }
        await sendRuntimeMessage({ type: 'SET_FOLDER_BACKUP', ...next });
        saved = next;
        display('automatic' in change ? (next.automatic ? 'Automatic backups on.' : 'Automatic backups off.') : 'Backup retention saved.');
      } catch (error) {
        if ('automatic' in change && checkbox.checked === change.automatic) checkbox.checked = previous.automatic;
        if ('keep' in change && keep.valueAsNumber === change.keep) keep.value = String(previous.keep);
        display(error instanceof Error ? error.message : String(error), true);
      }
    });
  };
  checkbox.addEventListener('change', () => {
    saveSettings({ automatic: checkbox.checked });
  });
  keep.addEventListener('change', () => {
    if (!saved) return;
    if (!keep.validity.valid) {
      keep.value = String(saved.keep);
      display('Choose a retention count from 1 to 30.', true);
      return;
    }
    saveSettings({ keep: keep.valueAsNumber });
  });
  keep.addEventListener('keydown', event => {
    if (event.key === 'Enter') keep.blur();
  });
  run.addEventListener('click', () => void perform(async () => {
    await grant();
    await settingsWrites;
    display('Writing backup…');
    await sendRuntimeMessage({ type: 'RUN_FOLDER_BACKUP' });
    showStatus(await getStatus());
  }));
  chrome.storage?.onChanged?.addListener((changes: Record<string, unknown>, area: string) => {
    if (area !== 'local' || !changes.encryptedFolderBackupReport || !panel.open || busy) return;
    void getStatus().then(status => { if (!busy) showStatus(status); }).catch(() => {});
  });
}
