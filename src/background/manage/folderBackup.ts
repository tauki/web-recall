import { APPLE_HOST } from '../providers/apple';
import { exportSnapshot, openBackupSnapshot } from './backupSnapshot';
import { beginWorkerLease } from '../lifetime';
import { requireBackupKey } from '../../shared/backupKey';
import { encryptBackup, recoveryKeyIdentifier } from '../../shared/encryptedBackup';

const SETTINGS_KEY = 'folderBackupSettings';
const REPORT_KEY = 'encryptedFolderBackupReport';
const ALARM = 'web-recall-folder-backup';
const DAY = 24 * 60 * 60 * 1000;

type BackupSettings = { automatic: boolean; keep: number };
type BackupReport = { checkedAt?: number; savedAt?: number; message?: string; error?: boolean };
type BackupReply = { type: string; text?: string };
let active: { automatic: boolean; controller: AbortController } | undefined;

async function readSettings(): Promise<BackupSettings> {
  const value = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return { automatic: value?.automatic === true, keep: validKeep(value?.keep) ? value.keep : 3 };
}

function validKeep(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 30;
}

function encodeChunk(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function readReport(): Promise<BackupReport> {
  return (await chrome.storage.local.get(REPORT_KEY))[REPORT_KEY] ?? {};
}

function openNativeBackup(signal: AbortSignal) {
  signal.throwIfAborted();
  const port = chrome.runtime.connectNative(APPLE_HOST);
  const id = crypto.randomUUID();
  let waiting: { resolve: (value: BackupReply) => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure = error;
    waiting?.reject(error);
    waiting = undefined;
  };
  const abort = (): void => {
    fail(signal.reason instanceof Error ? signal.reason : new Error('Backup stopped.'));
    port.disconnect();
  };
  signal.addEventListener('abort', abort, { once: true });
  port.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message;
    fail(new Error(detail ? `Mac companion unavailable: ${detail}` : 'Mac companion disconnected. Check that the updated companion is running.'));
  });
  port.onMessage.addListener((reply: unknown) => {
    const message = reply as { id?: string; type?: string; text?: string } | null;
    if (message?.id !== id || !waiting || typeof message.type !== 'string') return;
    if (message.type === 'error') {
      fail(new Error(message.text === 'Invalid native request.' ? 'Update the Mac companion to use encrypted folder backups.' : message.text || 'The Mac companion could not save the backup.'));
      return;
    }
    const pending = waiting;
    waiting = undefined;
    pending.resolve({ type: message.type, text: message.text });
  });
  return {
    close() { signal.removeEventListener('abort', abort); port.disconnect(); },
    async send(action: string, fields: Record<string, unknown> = {}): Promise<BackupReply> {
      signal.throwIfAborted();
      if (failure) throw failure;
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        try { port.postMessage({ id, action, ...fields }); }
        catch { fail(new Error('Could not send backup data to the Mac companion.')); }
      });
    }
  };
}

export async function getFolderBackup(probe = false) {
  const [settings, report] = await Promise.all([readSettings(), readReport()]);
  let folder: string | undefined;
  if (probe) {
    const connection = openNativeBackup(new AbortController().signal);
    try {
      const reply = await connection.send('backup_status_encrypted');
      if (reply.type !== 'backup_status_encrypted') throw new Error('Update the Mac companion to use encrypted folder backups.');
      folder = reply.text;
    } finally { connection.close(); }
  }
  return { ...settings, ...report, busy: Boolean(active), folder };
}

async function syncAlarm(automatic: boolean): Promise<void> {
  if (!chrome.alarms) return;
  if (!automatic) { await chrome.alarms.clear(ALARM); return; }
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 60 });
}

export async function setFolderBackup(automatic: unknown, keep: unknown): Promise<void> {
  if (typeof automatic !== 'boolean' || !validKeep(keep)) throw new Error('Choose a retention count from 1 to 30.');
  if (automatic) await requireBackupKey();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { automatic, keep } });
  if (!automatic && active?.automatic) active.controller.abort(new Error('Automatic backup turned off.'));
  await syncAlarm(automatic);
  if (automatic) void runScheduledBackup();
}

export async function runFolderBackup(automatic = false): Promise<BackupReport> {
  if (active) throw new Error('A folder backup is already running.');
  const controller = new AbortController();
  active = { automatic, controller };
  const signal = controller.signal;
  const release = beginWorkerLease();
  let connection: ReturnType<typeof openNativeBackup> | undefined;
  try {
    const settings = await readSettings();
    const previous = await readReport();
    if (automatic && (!settings.automatic || Date.now() - (previous.checkedAt ?? 0) < DAY)) return previous;
    if (!await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) throw new Error('Allow the Mac companion connection in Settings → Storage & backups first.');
    const key = await requireBackupKey();
    const snapshot = await openBackupSnapshot(signal);
    let report: BackupReport;
    if (!snapshot.hasPages) {
      report = { ...previous, checkedAt: Date.now(), message: 'No saved pages to back up.', error: false };
    } else {
      const keyId = await recoveryKeyIdentifier(key);
      connection = openNativeBackup(signal);
      const begin = await connection.send('backup_begin_encrypted', { keyId, libraryId: snapshot.libraryId, revision: snapshot.revision, automatic: automatic && !previous.error, keep: settings.keep });
      if (begin.type === 'backup_unchanged_encrypted' && automatic) {
        report = { ...previous, checkedAt: Date.now(), message: 'Library unchanged.', error: false };
      } else {
        if (begin.type !== 'backup_ready_encrypted') throw new Error('Update the Mac companion to use encrypted folder backups.');
        const encoder = new TextEncoder();
        async function* plaintext() {
          for await (const { line } of exportSnapshot(snapshot, signal)) yield encoder.encode(line + '\n');
        }
        for await (const bytes of encryptBackup(plaintext(), key, signal)) {
          if ((await connection.send('backup_chunk', { data: encodeChunk(bytes) })).type !== 'backup_ack') throw new Error('The Mac companion did not confirm the backup data.');
        }
        const finish = await connection.send('backup_finish');
        if (finish.type !== 'backup_saved') throw new Error('The Mac companion did not confirm that the backup was saved.');
        report = { checkedAt: Date.now(), savedAt: Date.now(), message: finish.text || 'Encrypted backup saved to folder.', error: false };
      }
    }
    await chrome.storage.local.set({ [REPORT_KEY]: report });
    return report;
  } catch (error) {
    if (!signal.aborted) {
      const previous = await readReport();
      await chrome.storage.local.set({ [REPORT_KEY]: { ...previous, error: true, message: error instanceof Error ? error.message : String(error) } });
    }
    throw error;
  } finally {
    connection?.close();
    active = undefined;
    release();
  }
}

async function runScheduledBackup(): Promise<void> {
  try { if (!active && (await readSettings()).automatic) await runFolderBackup(true); }
  catch (error) { console.warn('[beta-backup] automatic backup did not complete', error); }
}

export function bindFolderBackups(): void {
  if (!chrome.alarms) return;
  chrome.alarms.onAlarm.addListener((alarm: { name: string }) => { if (alarm.name === ALARM) void runScheduledBackup(); });
  chrome.runtime.onStartup?.addListener(() => { void runScheduledBackup(); });
  chrome.permissions?.onRemoved?.addListener((removed: { permissions?: string[] }) => {
    if (removed.permissions?.includes('nativeMessaging')) active?.controller.abort(new Error('Mac companion access was revoked.'));
  });
  void readSettings().then(settings => syncAlarm(settings.automatic)).catch(error => console.warn('[beta-backup] could not schedule backups', error));
}
