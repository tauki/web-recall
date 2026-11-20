import { readLibraryAuthority, writeLibraryAuthority, type LibraryAuthority } from './libraryAuthorityState';
import { callSavedLibraryWorker } from './sqlite';

export async function openSqliteAuthority(prepareSource: () => Promise<'indexeddb' | 'empty'>, retireSource: () => Promise<void>): Promise<LibraryAuthority> {
  let state = await readLibraryAuthority();
  if (!state) {
    const result = await callSavedLibraryWorker<{ exists?: boolean }>({ kind: 'inspect' });
    if (result.exists !== false) throw new Error('The saved library has no matching startup identity.');
    state = { id: crypto.randomUUID(), phase: 'preparing', source: await prepareSource() };
    await writeLibraryAuthority(state);
  }
  if (state.phase === 'preparing') {
    const result = await callSavedLibraryWorker<{ library?: { id: string } }>({ kind: 'stage', id: state.id, source: state.source });
    if (result.library?.id !== state.id) throw new Error('The saved library did not verify the migration.');
    state = { ...state, phase: 'active' };
    await writeLibraryAuthority(state);
  }
  const result = await callSavedLibraryWorker<{ active?: boolean }>({ kind: 'activate', id: state.id });
  if (result.active !== true) throw new Error('The saved library could not be activated.');
  if (!state.retired) {
    await retireSource();
    state = { ...state, retired: true };
    await writeLibraryAuthority(state);
  }
  return state;
}
