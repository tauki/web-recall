import { storageManager, type PageRecord } from '../storage/manager';
import { cancelCaptureJobs } from '../capture/index';
import { markFailed } from '../processing/index';
import { replaceSavedWork } from '../processing/savedWork';
import { invalidateRecentPages } from './recents';
import { invalidateOffscreenIndex } from '../offscreen/index';

export async function restorePage(record: PageRecord, signal?: AbortSignal): Promise<void> {
  await replaceSavedWork(record.url, async () => {
    signal?.throwIfAborted();
    const stopped = await cancelCaptureJobs([record.url]);
    try { await storageManager.savePageRecord(record, { discardProcessing: true, replace: true, signal }); }
    catch (error) {
      await Promise.all(stopped.map(item => markFailed(item.payload, item.attempts, 'Indexing stopped after restore failed. Saved text was retained.').catch(failure => console.warn('[beta-manage] unable to record stopped indexing', failure))));
      throw error;
    }
  }, signal);
  await invalidateRecentPages();
  await invalidateOffscreenIndex();
}
