import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './helpers.mjs';

function environment() {
  let preferences = {};
  let sqlite = null;
  let failNextActiveWrite = false;
  let holdHost;
  const timeline = [];
  const context = { chrome: { storage: { local: {
    async get() { return structuredClone(preferences); },
    async set(value) {
      const state = Object.values(value)[0];
      if (failNextActiveWrite && state.phase === 'active') {
        failNextActiveWrite = false;
        throw Error('Failed to persist authority');
      }
      preferences = structuredClone(value);
      timeline.push(state.retired ? 'persist-retired' : `persist-${state.phase}`);
    }
  } } } };
  const tools = { '../offscreen/index': {
    ensureOffscreenDocument: async () => { const pending = holdHost; holdHost = undefined; await pending; },
    sendOffscreenMessage: async ({ request }) => {
      timeline.push(request.kind);
      if (request.kind === 'inspect') return { exists: Boolean(sqlite), library: sqlite };
      if (request.kind === 'stage') {
        assert.equal(request.preparing, true);
        sqlite ??= { id: request.id, sourceVersion: 5, pages: 1, processing: 0 };
        return { library: sqlite };
      }
      if (request.kind === 'activate') {
        if (sqlite?.id !== request.id) throw Error('The saved library file is missing.');
        return { active: true };
      }
      throw Error(`Unexpected worker operation ${request.kind}`);
    }
  } };
  return {
    start: () => loadSource('src/background/storage/libraryActivation.ts', '', tools, context),
    transport: () => loadSource('src/background/storage/sqlite.ts', '', tools, context),
    timeline,
    holdNextHost() { let release; holdHost = new Promise(resolve => { release = resolve; }); return release; },
    lostSqlite() { sqlite = null; },
    failActivationFence() { failNextActiveWrite = true; }
  };
}

test('a cold restart never restages a missing activated authority from the old source', async () => {
  const fixture = environment();
  const init = await fixture.start();
  const identity = await init.openSqliteAuthority(async () => 'indexeddb', async () => { fixture.timeline.push('retire'); });
  assert.deepEqual(fixture.timeline, ['inspect', 'persist-preparing', 'stage', 'persist-active', 'activate', 'retire', 'persist-retired']);
  fixture.lostSqlite();
  const restart = await fixture.start();
  await assert.rejects(restart.openSqliteAuthority(async () => { throw Error('Must not choose the legacy source again'); }, async () => {}), /library file is missing/u);
  const { callSavedLibraryWorker } = await fixture.transport();
  await assert.rejects(callSavedLibraryWorker({ kind: 'stage', source: 'indexeddb', id: identity.id }), /not authorized by the startup identity/u);
  assert.deepEqual(fixture.timeline, ['inspect', 'persist-preparing', 'stage', 'persist-active', 'activate', 'retire', 'persist-retired', 'activate']);
});

test('a staged copy is safe to resume if persisting its activation failed before any writes were allowed', async () => {
  const fixture = environment();
  fixture.failActivationFence();
  const first = await fixture.start();
  await assert.rejects(first.openSqliteAuthority(async () => 'indexeddb', async () => {}), /Failed to persist authority/u);
  assert.deepEqual(fixture.timeline, ['inspect', 'persist-preparing', 'stage']);
  const restart = await fixture.start();
  await restart.openSqliteAuthority(async () => { throw Error('Retry must use the original migration identity'); }, async () => { fixture.timeline.push('retire'); });
  assert.deepEqual(fixture.timeline, ['inspect', 'persist-preparing', 'stage', 'stage', 'persist-active', 'activate', 'retire', 'persist-retired']);
});

test('a stage request held across activation and host replacement is not dispatched', async () => {
  const fixture = environment();
  fixture.failActivationFence();
  const first = await fixture.start();
  await assert.rejects(first.openSqliteAuthority(async () => 'indexeddb', async () => {}), /Failed to persist authority/u);
  const { callSavedLibraryWorker } = await fixture.transport();
  const staged = await callSavedLibraryWorker({ kind: 'inspect' });
  const release = fixture.holdNextHost();
  const stale = callSavedLibraryWorker({ kind: 'stage', id: staged.library.id, source: 'indexeddb' });
  await (await fixture.start()).openSqliteAuthority(async () => { throw Error('Cannot stage the legacy source from scratch'); }, async () => {});
  fixture.lostSqlite();
  release();
  await assert.rejects(stale, /not authorized by the startup identity/u);
  assert.equal((await callSavedLibraryWorker({ kind: 'inspect' })).exists, false);
});

test('failed retirement does not complete readiness; restart retries retirement without copying old evidence again', async () => {
  const fixture = environment();
  const first = await fixture.start();
  await assert.rejects(first.openSqliteAuthority(async () => 'indexeddb', async () => { throw Error('Old source is busy'); }), /Old source is busy/u);
  assert.deepEqual(fixture.timeline, ['inspect', 'persist-preparing', 'stage', 'persist-active', 'activate']);
  const restarted = await fixture.start();
  await restarted.openSqliteAuthority(async () => { throw Error('Do not prepare the old library again'); }, async () => { fixture.timeline.push('retire'); });
  assert.deepEqual(fixture.timeline, ['inspect', 'persist-preparing', 'stage', 'persist-active', 'activate', 'activate', 'retire', 'persist-retired']);
});
