import { abortable } from '../../shared/abort';
import { readBackupLines } from '../../shared/backup';
import { BackupFrameDecoder, validateBackup } from '../../shared/backupFrames';
import { requireBackupKey } from '../../shared/backupKey';
import { decryptBackup, encryptBackup } from '../../shared/encryptedBackup';
import { askForRecoveryKey } from './backupKey';
import { BackupTransfer } from './backupTransfer';
import { sendRuntimeMessage } from './runtime';

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

export function createFileTransfers(
  updateStatus: (message: string, error?: boolean) => void,
  stopButton: HTMLButtonElement,
  controls: (HTMLButtonElement | HTMLInputElement)[],
  encryptedSave?: HTMLButtonElement
) {
  let transferController: AbortController | undefined;
  let backupKeyReady = false;

  function setTransferBusy(busy: boolean): void {
    for (const control of controls) control.disabled = busy;
    if (encryptedSave) encryptedSave.disabled = busy || !backupKeyReady;
    stopButton.hidden = !busy;
  }

  stopButton.addEventListener('click', () => transferController?.abort(new Error('Stopped by user')));

  async function handleExport(options?: { format: 'json' | 'markdown'; urls?: string[] }, encrypted = false): Promise<void> {
    if (transferController) return;
    const controller = transferController = new AbortController();
    setTransferBusy(true);
    let writer: FileSystemWritableFileStream | undefined;
    let transfer: BackupTransfer | undefined;
    const stop = (): void => { void transfer?.cancel().catch(() => {}); void writer?.abort().catch(() => {}); };
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
      if (!picker) throw new Error('This browser does not support streaming backup saves. Use Chrome on desktop.');
      const kind = encrypted ? { name: 'web-recall-backup.wrbackup', description: 'Encrypted Web Recall backup', mime: 'application/octet-stream', extension: '.wrbackup' }
        : options?.format === 'markdown' ? { name: 'web-recall-export.md', description: 'Markdown', mime: 'text/markdown', extension: '.md' }
        : options?.format === 'json' ? { name: 'web-recall-export.json', description: 'JSON', mime: 'application/json', extension: '.json' }
        : { name: 'web-recall-backup.jsonl', description: 'Unencrypted Web Recall backup', mime: 'application/x-ndjson', extension: '.jsonl' };
      const file = await picker.call(window, { suggestedName: kind.name, types: [{ description: kind.description, accept: { [kind.mime]: [kind.extension] } }] });
      const key = encrypted ? await requireBackupKey() : undefined;
      controller.signal.throwIfAborted();
      writer = await file.createWritable();
      controller.signal.throwIfAborted();
      transfer = new BackupTransfer('export', false, options);
      const decoder = options ? undefined : new BackupFrameDecoder();
      let count = 0;
      async function* lines() {
        while (true) {
          const response = await transfer!.next();
          controller.signal.throwIfAborted();
          const event = decoder?.consume(response.line!);
          if (event && response.complete !== (event.type === 'end')) throw new Error('Invalid backup completion response.');
          if (event?.type === 'page-end') updateStatus(`Exporting… ${++count} pages`);
          if (options && response.pages !== count) updateStatus(`Exporting… ${count = response.pages} pages`);
          yield response.line! + (options ? '' : '\n');
          if (response.complete) { decoder?.finish(); return; }
        }
      }
      if (key) {
        const encoder = new TextEncoder();
        async function* plaintext() { for await (const line of lines()) yield encoder.encode(line); }
        for await (const bytes of encryptBackup(plaintext(), key, controller.signal)) await writer.write(bytes);
      } else {
        for await (const line of lines()) {
          await writer.write(line);
          controller.signal.throwIfAborted();
        }
      }
      controller.signal.throwIfAborted();
      await writer.close();
      writer = undefined;
      updateStatus(`Export complete: ${count} pages`);
    } catch (err) {
      await writer?.abort().catch(() => {});
      updateStatus(controller.signal.aborted || (err instanceof Error && err.name === 'AbortError') ? 'Export cancelled' : `Export failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      controller.signal.removeEventListener('abort', stop);
      transfer?.close();
      transferController = undefined;
      setTransferBusy(false);
    }
  }

  async function handleImport(file: File, dialog: HTMLDialogElement): Promise<void> {
    if (transferController) return;
    let recover = false;
    const controller = transferController = new AbortController();
    setTransferBusy(true);
    let transfer: BackupTransfer | undefined;
    const stop = (): void => { void transfer?.cancel().catch(() => {}); };
    const restoreCount = (count: number): string => `${count} saved page${count === 1 ? '' : 's'}`;
    const confirmRecovery = (count: number): boolean => {
      if (!recover) return true;
      if (!count) throw new Error('Choose a complete backup with saved pages.');
      if (window.confirm(`Restore your missing library from this backup of ${restoreCount(count)}? A library that still exists will not be replaced.`)) return true;
      updateStatus('Library restore cancelled');
      return false;
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      const mode = await abortable(sendRuntimeMessage<{ recover: boolean }>({ type: 'GET_BACKUP_RESTORE_MODE' }), controller.signal);
      controller.signal.throwIfAborted();
      if (typeof mode.recover !== 'boolean') throw new Error('Could not check the saved library before restoring.');
      recover = mode.recover;
      const encrypted = /\.wrbackup$/iu.test(file.name);
      if (encrypted || /\.(jsonl|ndjson)$/i.test(file.name)) {
        const key = encrypted ? await askForRecoveryKey(dialog, controller.signal) : undefined;
        if (encrypted && !key) { updateStatus('Restore cancelled'); return; }
        const stream = () => key ? decryptBackup(file, key, controller.signal) : file.stream();
        updateStatus('Validating backup…');
        const total = await validateBackup(stream(), controller.signal);
        if (encrypted && !recover && !window.confirm(`Restore ${restoreCount(total)} from this encrypted backup? Saved pages with the same address will be replaced.`)) {
          updateStatus('Restore cancelled'); return;
        }
        if (!confirmRecovery(total)) return;
        transfer = new BackupTransfer('import', recover);
        let complete = false;
        for await (const line of readBackupLines(stream(), controller.signal)) {
          const response = await transfer.next(line);
          complete = response.complete!;
          if (complete) break;
          controller.signal.throwIfAborted();
          updateStatus(recover ? `Verifying restore… ${response.staged ?? 0} of ${total} pages` : `Importing… ${transfer.pages} of ${total} pages`);
        }
        if (recover) {
          controller.signal.throwIfAborted();
          complete = (await transfer.publishRestore()).complete === true;
        }
        if (!complete) throw new Error('The backup import did not complete.');
        updateStatus(recover ? `Library restored: ${restoreCount(transfer.pages)}` : `Import complete: ${transfer.pages} pages`);
        return;
      }
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('Legacy JSON file exceeds 10 MB. Use a streaming .jsonl backup for larger libraries.');
      const text = await file.text();
      controller.signal.throwIfAborted();
      const parsed = JSON.parse(text);
      if (parsed?.format === 'web-recall-export') throw new Error('This is a portable export, not a recovery backup.');
      let pages: unknown[] = [];
      let schemaVersion: number | undefined;
      if (Array.isArray(parsed)) {
        pages = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.pages)) {
        pages = parsed.pages;
        schemaVersion =
          typeof (parsed as { schemaVersion?: unknown }).schemaVersion === 'number'
            ? (parsed as { schemaVersion: number }).schemaVersion
            : undefined;
      } else {
        throw new Error('Invalid schema: expected array or { pages: [] }');
      }
      if (!confirmRecovery(pages.length)) return;
      updateStatus('Importing…');
      transfer = new BackupTransfer('import', recover);
      const response = await transfer.importLegacy(pages, schemaVersion);
      if (response.complete !== true) throw new Error('The legacy import did not complete.');
      updateStatus(recover ? `Library restored: ${restoreCount(transfer.pages)}` : 'Import complete');
    } catch (err) {
      let stopFailure: unknown;
      if (controller.signal.aborted && transfer) { try { await transfer.cancel(); } catch (error) { stopFailure = error; } }
      const failure = stopFailure || err;
      const status = controller.signal.aborted && !stopFailure ? `Import stopped: ${transfer?.pages || 0} pages restored` : `Import failed${transfer?.pages ? ` after ${transfer.pages} pages` : ''}: ${failure instanceof Error ? failure.message : String(failure)}`;
      updateStatus(status, true);
    } finally {
      controller.signal.removeEventListener('abort', stop);
      transfer?.close();
      transferController = undefined;
      setTransferBusy(false);
      if (transfer) window.dispatchEvent(new window.CustomEvent('wr-memory-changed', { detail: 'restore' }));
    }
  }

  return {
    save: handleExport,
    restore: handleImport,
    setBackupKeyReady(ready: boolean): void {
      backupKeyReady = ready;
      if (encryptedSave) encryptedSave.disabled = Boolean(transferController) || !ready;
    }
  };
}
