import { validLibraryId } from '../../shared/db/sqliteLibrary';

const KEY = 'savedLibraryAuthority';

export type LibraryAuthority = {
  id: string;
  phase: 'preparing' | 'active';
  source: 'indexeddb' | 'empty' | 'backup';
  retired?: true;
  recoveryId?: string;
};

export async function readLibraryAuthority(): Promise<LibraryAuthority | null> {
  const values = await chrome.storage.local.get(KEY);
  if (!values || typeof values !== 'object') throw new Error('Cannot read the saved library authority.');
  if (!Object.hasOwn(values, KEY)) return null;
  const state = values[KEY] as LibraryAuthority;
  if (!state || !validLibraryId(state.id) || (state.phase !== 'preparing' && state.phase !== 'active') ||
      (state.source !== 'indexeddb' && state.source !== 'empty' && state.source !== 'backup') ||
      (state.retired !== undefined && (state.retired !== true || state.phase !== 'active')) ||
      (state.source === 'backup' && state.retired !== true) ||
      (state.recoveryId !== undefined && (!validLibraryId(state.recoveryId) || state.recoveryId === state.id || state.retired !== true))) {
    throw new Error('Invalid saved library authority.');
  }
  return state;
}

export function writeLibraryAuthority(state: LibraryAuthority): Promise<void> {
  return chrome.storage.local.set({ [KEY]: state });
}
