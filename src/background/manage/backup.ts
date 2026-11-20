import { BackupFrameDecoder } from '../../shared/backupFrames';
import type { PageRecord } from '../storage/manager';
import { exportOptions, exportSnapshot, openBackupSnapshot, type ExportChunk } from './backupSnapshot';
import { restorePage } from './restore';
import { beginWorkerLease } from '../lifetime';
import { isTrustedUi } from '../orchestration/trustedUi';
import { normalizeImportedPages } from '../../shared/db/records';
import { beginLibraryRecovery } from '../storage/libraryRecovery';
import { invalidateRecentPages } from './recents';

type TransferPort = {
  name: string;
  sender?: { id?: string; url?: string };
  disconnect: () => void;
  postMessage: (message: unknown) => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
};
let owner: TransferPort | undefined;

export function bindBackupTransfers(): void {
  chrome.runtime.onConnect?.addListener((port: TransferPort) => {
    if (port.name !== 'web-recall-backup') return;
    if (!isTrustedUi(port.sender)) { port.disconnect(); return; }
    const controller = new AbortController();
    let mode: 'export' | 'import' | undefined;
    let generator: AsyncGenerator<ExportChunk> | undefined;
    let decoder: BackupFrameDecoder | undefined;
    let page: PageRecord | undefined;
    let pages = 0;
    let staged = 0;
    let recovering = false;
    let verifiedEnd = false;
    let recovery: Awaited<ReturnType<typeof beginLibraryRecovery>> | undefined;
    let finished = false;
    let closing: Promise<void> | undefined;
    let release = (): void => {};
    let pending: Promise<void> | undefined;
    let cancelling = false;
    const finish = (): Promise<void> => closing ??= (async () => {
      finished = true;
      page = undefined;
      decoder = undefined;
      await generator?.return(undefined);
      generator = undefined;
      await recovery?.discard().catch(error => console.warn('[beta-storage] backup staging cleanup failed', error));
      recovery = undefined;
      release();
      if (owner === port) owner = undefined;
    })();
    const importPage = async (record: PageRecord): Promise<void> => {
      if (recovering) {
        recovery ??= await beginLibraryRecovery(controller.signal);
        await recovery.stage(record);
        staged++;
      } else {
        await restorePage(record, controller.signal);
        pages++;
      }
    };
    const completeImport = async (): Promise<void> => {
      if (recovering) {
        if (!recovery) throw new Error('Choose a complete backup with saved pages.');
        await recovery.publish(staged);
        recovery = undefined;
        pages = staged;
        await invalidateRecentPages();
      }
      await finish();
    };
    const reply = (value: unknown): void => { try { port.postMessage(value); } catch { controller.abort(new Error('Backup connection closed.')); } };
    port.onDisconnect.addListener(() => {
      controller.abort(new Error('Backup connection closed.'));
      void (pending || Promise.resolve()).finally(finish);
    });
    port.onMessage.addListener((message: unknown) => {
      const request = message as { id?: unknown; action?: unknown; line?: unknown; pages?: unknown[]; schemaVersion?: number; recover?: unknown; format?: unknown; urls?: unknown } | null;
      if (!request || !Number.isSafeInteger(request.id) || (request.id as number) < 1) { port.disconnect(); return; }
      const id = request.id as number;
      if (request.action === 'cancel') {
        if (cancelling) return;
        cancelling = true;
        controller.abort(new Error('Stopped by user'));
        void (pending || Promise.resolve()).then(async () => {
          await finish();
          reply({ id, ...(recovering && pages ? { complete: true } : { stopped: true }), pages });
        });
        return;
      }
      if (pending || finished || cancelling) { reply({ id, error: 'This backup transfer is busy or closed.', pages }); return; }
      pending = (async () => {
        try {
          controller.signal.throwIfAborted();
          const initial = !mode;
          if (!mode) {
            if (request.action !== 'export' && request.action !== 'import' && request.action !== 'legacy') throw new Error('Start a new backup transfer.');
            recovering = request.recover === true;
            if (recovering && (request.action === 'export' || new URL(port.sender!.url!).pathname !== '/dist/beta/ui/sidepanel/index.html')) {
              throw new Error('Restore a missing library from Settings.');
            }
            if (owner && owner !== port) throw new Error('Another backup transfer is running.');
            owner = port;
            release = beginWorkerLease();
            mode = request.action === 'export' ? 'export' : 'import';
            if (mode === 'export') {
              const { format, scope } = exportOptions(request.format, request.urls);
              generator = exportSnapshot(await openBackupSnapshot(controller.signal), controller.signal, format, scope);
            }
            else decoder = new BackupFrameDecoder();
          }
          if (request.action === 'legacy') {
            if (!initial) throw new Error('Start a new legacy import.');
            const records = normalizeImportedPages(request);
            for (const record of records) { controller.signal.throwIfAborted(); await importPage(record); }
            await completeImport();
            reply({ id, pages, complete: true });
          } else if (mode === 'export') {
            if (request.action !== 'export') throw new Error('Invalid export request.');
            const next = await generator!.next();
            if (next.done) throw new Error('The backup ended without a completion frame.');
            if (next.value.complete) { pages = next.value.pages; await finish(); }
            reply({ id, ...next.value });
          } else if (request.action === 'publish' && recovering) {
            if (!verifiedEnd) throw new Error('Restore requires a verified end to the backup.');
            await completeImport();
            reply({ id, pages, complete: true });
          } else {
            if (request.action !== 'import' || typeof request.line !== 'string') throw new Error('Invalid import frame.');
            const event = decoder!.consume(request.line);
            if (event.type === 'page') page = { ...event.page, versions: [] };
            if (event.type === 'version') page!.versions!.push(event.version);
            if (event.type === 'legacy-page') page = event.page;
            if (event.type === 'page-end' || event.type === 'legacy-page') {
              await importPage(page!);
              page = undefined;
            }
            if (event.type === 'end') {
              decoder!.finish();
              if (recovering) verifiedEnd = true;
              else await completeImport();
            }
            reply({ id, pages, ...(recovering ? { staged } : {}), complete: event.type === 'end' && !recovering });
          }
        } catch (error) {
          await finish();
          reply({ id, error: error instanceof Error ? error.message : String(error), pages });
        }
      })().finally(() => { pending = undefined; });
    });
  });
}
