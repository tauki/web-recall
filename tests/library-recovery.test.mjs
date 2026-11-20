import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './helpers.mjs';

const previousId = 'ea3f23de-3b76-4523-aa2e-f59dc6eb568c';
const page = { url: 'https://backup.test/owned', title: 'Saved note', text: 'Backup evidence', timestamp: 1, manual: true, chunks: [] };

async function fixture({ onSeal, onCommit } = {}) {
  const previous = { id: previousId, phase: 'active', source: 'indexeddb', retired: true };
  let preferences = { savedLibraryAuthority: previous };
  let originalExists = false;
  const stagedFiles = new Map();
  const read = () => structuredClone(preferences.savedLibraryAuthority);
  const mod = await loadSource('src/background/storage/libraryRecovery.ts', '', {
    './sqlite': { async callSavedLibraryWorker(request) {
      if (request.action === 'check') return { missing: !originalExists };
      if (request.action === 'start') { stagedFiles.set(request.recoveryId, []); return { started: true }; }
      if (request.action === 'write') { stagedFiles.get(request.recoveryId).push(request.record); return { staged: true }; }
      if (request.action === 'seal') {
        assert.equal(stagedFiles.get(request.recoveryId).length, request.pages);
        await onSeal?.(() => { originalExists = true; });
        return { sealed: true };
      }
      if (request.action === 'discard') { stagedFiles.delete(request.recoveryId); return { discarded: true }; }
      assert.fail(`Unhandled recovery command: ${request.action}`);
    } }
  }, { chrome: { storage: { local: {
    get: async () => structuredClone(preferences),
    async set(next) {
      preferences = structuredClone(next);
      if (read().source === 'backup') await onCommit?.();
    }
  } } } });
  return { ...mod, read, previous, stagedFiles };
}

test('a recovered backup cannot replace the prior library if its file returns before publication', async () => {
  const store = await fixture({ onSeal: returnPrevious => returnPrevious() });
  const recovery = await store.beginLibraryRecovery(new AbortController().signal);
  await recovery.stage(page);
  await assert.rejects(recovery.publish(1), /file returned during restore/iu);
  await recovery.discard();
  assert.deepEqual(store.read(), store.previous);
  assert.equal(store.stagedFiles.size, 0);
});

test('Stop after the authority write cannot discard a committed backup even before its reply', async () => {
  const controller = new AbortController();
  const store = await fixture({ onCommit: () => controller.abort(Error('Stopped by user')) });
  const recovery = await store.beginLibraryRecovery(controller.signal);
  await recovery.stage(page);
  await recovery.publish(1);
  await recovery.discard();
  assert.notEqual(store.read().id, previousId);
  assert.equal(store.read().recoveryId, undefined);
  assert.deepEqual(store.stagedFiles.get(store.read().id), [page]);
});
