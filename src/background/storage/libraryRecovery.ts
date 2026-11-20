import type { PageRecord } from '../../shared/db/index';
import { invalidateSavedLibraryWork } from '../processing/savedWork';
import { invalidateStorageReadiness } from './index';
import { readLibraryAuthority, writeLibraryAuthority, type LibraryAuthority } from './libraryAuthorityState';
import { callSavedLibraryWorker } from './sqlite';

type RecoveryCommand = 'check' | 'start' | 'write' | 'seal' | 'discard';

function recoverCommand<Result>(state: LibraryAuthority, action: RecoveryCommand, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Result> {
  return callSavedLibraryWorker<Result>({ kind: 'recover', id: state.id, recoveryId: state.recoveryId, action, ...fields }, signal);
}

async function isLibraryMissing(state: LibraryAuthority, signal?: AbortSignal): Promise<boolean> {
  const result = await recoverCommand<{ missing: boolean }>(state, 'check', {}, signal);
  return result.missing;
}

export async function needsLibraryRecovery(): Promise<boolean> {
  const state = await readLibraryAuthority();
  return state?.phase === 'active' && state.retired === true && await isLibraryMissing(state);
}

function isSameRecovery(current: LibraryAuthority | null, expected: LibraryAuthority): boolean {
  return current?.id === expected.id && current.source === expected.source && current.recoveryId === expected.recoveryId && current.retired === true;
}

async function discardRecovery(expected: LibraryAuthority): Promise<void> {
  const current = await readLibraryAuthority();
  if (!current || !isSameRecovery(current, expected)) return;
  if (!(await recoverCommand<{ discarded?: boolean }>(current, 'discard')).discarded) throw new Error('Could not discard the incomplete library restore.');
  const previous = { ...current };
  delete previous.recoveryId;
  await writeLibraryAuthority(previous);
}

export async function beginLibraryRecovery(signal: AbortSignal) {
  const previous = await readLibraryAuthority();
  if (previous?.phase !== 'active' || !previous.retired) throw new Error('No previously activated library is eligible for backup recovery.');
  if (!await isLibraryMissing(previous, signal)) {
    throw new Error('The saved library file still exists. Use Restore from file in Settings to import into it.');
  }
  if (previous.recoveryId) await discardRecovery(previous);
  signal.throwIfAborted();
  const recoveryId = crypto.randomUUID();
  const state = { ...previous, recoveryId };
  const discard = () => discardRecovery(state);
  try {
    await writeLibraryAuthority(state);
    if (!(await recoverCommand<{ started?: boolean }>(state, 'start', {}, signal)).started) throw new Error('Could not start restoring the saved library.');
  } catch (error) {
    await discard().catch(failure => console.warn('[beta-storage] backup staging cleanup failed', failure));
    throw error;
  }
  return {
    async stage(record: PageRecord): Promise<void> {
      if (!(await recoverCommand<{ staged?: boolean }>(state, 'write', { record }, signal)).staged) throw new Error('Could not stage the restored page.');
    },
    async publish(pages: number): Promise<void> {
      if (!(await recoverCommand<{ sealed?: boolean }>(state, 'seal', { pages }, signal)).sealed) throw new Error('Could not verify the restored library.');
      if (!await isLibraryMissing(state, signal)) throw new Error('The saved library file returned during restore.');
      if (!isSameRecovery(await readLibraryAuthority(), state)) throw new Error('The saved library authority changed during restore.');
      signal.throwIfAborted();
      await writeLibraryAuthority({ id: recoveryId, phase: 'active', source: 'backup', retired: true });
      invalidateSavedLibraryWork();
      invalidateStorageReadiness();
    },
    discard
  };
}
