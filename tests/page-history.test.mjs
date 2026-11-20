import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, chromeFixture, plain, waitFor } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';

const url = 'https://saved.test/guide?edition=one#chapter';
const input = (text, timestamp) => ({ url, title: 'A saved guide', text, timestamp, manual: true, chunks: [text], captureId: `admission-${timestamp}` });

async function fixture(t) {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  const connection = await db.openDatabase(); t.after(() => connection.close());
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager: db } }, { chrome: chromeFixture });
  return { db, async capture(text, timestamp, extras = {}) { await processing.markQueued({ ...input(text, timestamp), ...extras }, 0); await processing.markDone(extras.url || url); return db.getPageRecord(extras.url || url); } };
}

test('changed recapture retains the exact earlier text, title, vectors and summary under a stable version identity', async t => {
  const state = await fixture(t);
  const first = await state.capture('Original evidence.', 10);
  await state.db.savePageRecord({ ...first, summary: 'Original overview.', chunks: [{ text: first.text, embedding: [1, 0], embeddingKey: 'original-model' }] });
  const current = await state.capture('Revised evidence.', 20, { title: 'Revised guide' });
  assert.notEqual(current.versionId, first.versionId); assert.equal(current.versions.length, 1);
  const earlier = current.versions[0];
  assert.equal(earlier.versionId, first.versionId); assert.equal(earlier.title, first.title); assert.equal(earlier.text, first.text);
  assert.equal(earlier.summary, 'Original overview.'); assert.deepEqual(plain(earlier.chunks[0].embedding), [1, 0]);
  assert.equal(earlier.timestamp, 10); assert.equal(current.timestamp, 20); assert.equal(current.summary, undefined);
});

test('unchanged captures record another observation without duplicating the version, while indexing is not another visit', async t => {
  const state = await fixture(t), first = await state.capture('Same evidence.', 10);
  const second = await state.capture('Same evidence.', 20);
  assert.equal(second.versionId, first.versionId); assert.equal(second.versions.length, 0);
  assert.equal(second.firstCapturedAt, 10); assert.equal(second.timestamp, 20); assert.equal(second.lastVisitedAt, 20);
  await state.db.savePageRecord({ ...second, lastEmbeddedAt: 30, chunks: [{ text: second.text, embedding: [0, 1] }] }, { expectedUpdatedAt: second.updatedAt });
  const indexed = await state.db.getPageRecord(url);
  assert.equal(indexed.versionId, first.versionId); assert.equal(indexed.lastVisitedAt, 20); assert.equal(indexed.firstCapturedAt, 10); assert.equal(indexed.timestamp, 20);
});

test('a title-only changed capture archives the old overview instead of assigning it to the new version', async t => {
  const state = await fixture(t), first = await state.capture('Shared reading content.', 10, { title: 'Original purpose' });
  await state.db.savePageRecord({ ...first, summary: 'An overview anchored to the original purpose.' });
  const revised = await state.capture('Shared reading content.', 20, { title: 'Revised purpose' });
  assert.notEqual(revised.versionId, first.versionId);
  assert.equal(revised.summary, undefined);
  assert.equal(revised.versions[0].summary, 'An overview anchored to the original purpose.');
  assert.equal(revised.versions[0].title, 'Original purpose');
});

test('automatic retention keeps the latest five versions plus an explicitly kept older version', async t => {
  const state = await fixture(t), first = await state.capture('Revision 1', 1);
  await state.db.updateSavedVersion(url, first.versionId, 'keep');
  for (let revision = 2; revision <= 8; revision++) await state.capture(`Revision ${revision}`, revision);
  const versions = await state.db.listPageVersions(url);
  assert.deepEqual(plain(versions.map(version => version.text)), ['Revision 8', 'Revision 7', 'Revision 6', 'Revision 5', 'Revision 4', 'Revision 1']);
  assert.equal(versions.at(-1).kept, true);
  await state.db.updateSavedVersion(url, first.versionId, 'release');
  await state.capture('Revision 9', 9);
  assert.deepEqual(plain((await state.db.listPageVersions(url)).map(version => version.text)), ['Revision 9', 'Revision 8', 'Revision 7', 'Revision 6', 'Revision 5']);
});

test('released imported history retains the newest versions regardless of its original array order', async t => {
  const state = await fixture(t);
  const versions = Array.from({ length: 7 }, (_, index) => ({ timestamp: index + 1, text: `Imported revision ${index + 1}`, chunks: [] }));
  await state.db.savePageRecord({ ...input('Current revision 10', 10), chunks: [], versions });
  const identified = await state.db.listPageVersions(url);
  for (const version of identified) await state.db.updateSavedVersion(url, version.versionId, 'release');
  await state.capture('Current revision 20', 20);
  assert.deepEqual(plain((await state.db.listPageVersions(url)).map(version => version.timestamp)), [20, 10, 7, 6, 5]);
});

test('newest-first retention preserves a stable order among captures with identical timestamps', async t => {
  const state = await fixture(t);
  const versions = Array.from({ length: 5 }, (_, index) => ({ versionId: `tie-${index}`, timestamp: 1, text: `Tied revision ${index}`, chunks: [], kept: false }));
  await state.db.savePageRecord({ ...input('Current revision', 2), chunks: [], versionId: 'current', kept: false, versions });
  await state.capture('Newest revision', 3);
  assert.deepEqual(plain((await state.db.listPageVersions(url)).map(version => version.text)), ['Newest revision', 'Current revision', 'Tied revision 0', 'Tied revision 1', 'Tied revision 2']);
});

test('a failed capture transaction cannot prune an earlier saved version or leave a replacement job', async t => {
  const state = await fixture(t);
  for (let revision = 1; revision <= 5; revision++) await state.capture(`Revision ${revision}`, revision);
  const before = plain(await state.db.getPageRecord(url)), connection = await state.db.openDatabase(), transaction = connection.transaction.bind(connection);
  connection.transaction = (...args) => {
    const pending = transaction(...args);
    if (pending.mode === 'readwrite' && pending.objectStoreNames.contains('pages')) {
      const store = pending.objectStore('pages'), put = store.put.bind(store);
      store.put = (...values) => { const request = put(...values); request.addEventListener('success', () => pending.abort(), { once: true }); return request; };
    }
    return pending;
  };
  await assert.rejects(state.capture('Uncommitted revision', 6), /abort/i);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), before); assert.equal(await state.db.getProcessingEntry(url), undefined);
});

test('an older indexing snapshot cannot recreate a version explicitly removed during inference', async t => {
  const state = await fixture(t), first = await state.capture('Old evidence.', 10), current = await state.capture('Current evidence.', 20);
  await state.db.updateSavedVersion(url, first.versionId, 'delete');
  await state.db.savePageRecord({ ...current, chunks: [{ text: current.text, embedding: [1, 0] }] }, { expectedUpdatedAt: current.updatedAt });
  assert.equal((await state.db.getPageRecord(url)).versions.length, 0);
});

test('capture time zero remains a real capture time instead of becoming the current wall clock', async t => {
  const state = await fixture(t), saved = await state.capture('Archived epoch evidence.', 0);
  assert.equal(saved.timestamp, 0); assert.equal(saved.firstCapturedAt, 0); assert.equal(saved.lastVisitedAt, 0);
});

test('imported older history is not silently removed when new capture retention begins', async t => {
  const state = await fixture(t);
  const versions = Array.from({ length: 7 }, (_, index) => ({ timestamp: index + 1, text: `Imported evidence ${index}`, chunks: [], summary: `Imported summary ${index}` }));
  await state.db.savePageRecord({ ...input('Before upgrade.', 10), chunks: [], versions });
  const current = await state.capture('After upgrade.', 20);
  for (const version of versions) assert.ok(current.versions.some(saved => saved.text === version.text && saved.summary === version.summary && saved.kept));
  assert.ok(current.versions.some(saved => saved.text === 'Before upgrade.' && saved.kept));
});

test('keeping a version during a concurrent embedding update is retained by the transactional merge', async t => {
  const state = await fixture(t), first = await state.capture('Same evidence.', 10);
  await state.db.updateSavedVersion(url, first.versionId, 'keep');
  await state.db.savePageRecord({ ...first, chunks: [{ text: first.text, embedding: [1, 0] }] }, { expectedUpdatedAt: first.updatedAt });
  const saved = await state.db.getPageRecord(url);
  assert.equal(saved.kept, true); assert.equal(saved.versionId, first.versionId);
});

test('deleting an earlier version keeps the current page and fails explicitly for stale or current identities', async t => {
  const state = await fixture(t), first = await state.capture('Old evidence.', 10), current = await state.capture('Current evidence.', 20);
  await state.db.updateSavedVersion(url, first.versionId, 'delete');
  assert.equal((await state.db.listPageVersions(url)).length, 1); assert.equal((await state.db.getPageRecord(url)).text, current.text);
  await assert.rejects(state.db.updateSavedVersion(url, first.versionId, 'keep'), /no longer available/);
  await assert.rejects(state.db.updateSavedVersion(url, current.versionId, 'delete'), /Delete page/);
});

test('version history keeps meaningful query, fragment and trailing-path identities separate', async t => {
  const state = await fixture(t);
  const urls = ['https://saved.test/page?a=1#first', 'https://saved.test/page?a=2#first', 'https://saved.test/page?a=1#second', 'https://saved.test/page/', 'https://saved.test/page'];
  for (const [index, address] of urls.entries()) await state.capture(`Evidence ${index}`, index + 1, { url: address });
  assert.equal((await state.db.listAllPages()).length, urls.length);
  for (const [index, address] of urls.entries()) assert.equal((await state.db.getPageRecord(address)).text, `Evidence ${index}`);
});

test('structured-capture limitations survive admission, re-indexing and a streaming backup round trip', async t => {
  const state = await fixture(t), captureInfo = { source: 'main', warnings: ['Embedded content is not included.'] };
  const saved = await state.capture('Visible loaded evidence.', 10, { captureInfo });
  await state.db.savePageRecord({ ...saved, lastEmbeddedAt: 20, chunks: [{ text: saved.text, embedding: [1, 0] }] });
  const backup = await loadSource('src/shared/backup.ts');
  const restored = backup.decodeBackupPage(backup.encodeBackupPage(await state.db.getPageRecord(url)));
  assert.deepEqual(plain(restored.captureInfo), captureInfo); assert.equal(restored.versionId, saved.versionId);
  assert.equal(restored.firstCapturedAt, 10); assert.equal(restored.lastVisitedAt, 10);
});

test('saved readers use stable identities across unchanged revisits and changed captures, even when timestamps collide', async () => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'), processing = await backend.load('src/background/processing/index.ts');
  await processing.markQueued(input('Original evidence.', 10), 0); const first = await db.getPageRecord(url);
  await processing.markQueued(input('Unrelated replacement.', 10), 0);
  const earlier = await backend.send({ type: 'GET_SAVED_PAGE', url, timestamp: 10, versionId: first.versionId });
  assert.equal(earlier.page.text, 'Original evidence.'); assert.equal(earlier.page.current, false);
  assert.match((await backend.send({ type: 'GET_SAVED_PAGE', url, timestamp: 10 })).error, /Several captures share this time/);
  const listed = await backend.send({ type: 'GET_SAVED_HISTORY', url });
  assert.equal(listed.versions.length, 2); assert.equal('chunks' in listed.versions[0], false); assert.equal(backend.requests.length, 0);
  await processing.markQueued(input('Unrelated replacement.', 20), 0);
  const current = await db.getPageRecord(url);
  assert.equal((await backend.send({ type: 'GET_SAVED_PAGE', url, versionId: current.versionId })).page.text, current.text);
});

test('backup validation rejects malformed or colliding identities and invalid retention metadata instead of discarding it', async () => {
  const backup = await loadSource('src/shared/backup.ts');
  const base = { ...input('Evidence.', 10), chunks: [] };
  for (const fields of [{ versionId: 7 }, { kept: 'yes' }, { firstCapturedAt: -1 }, { captureInfo: { source: 'remote-script', warnings: [] } }, { versionId: 'duplicate', versions: [{ versionId: 'duplicate', text: 'Older', timestamp: 1, chunks: [] }] }]) {
    assert.throws(() => backup.decodeBackupPage(JSON.stringify({ type: 'page', page: { ...base, ...fields } })), /Invalid|unique/);
  }
});

test('JSON import does not attach an older summary or old vectors to explicit newer current content', async () => {
  const backend = providerFixture(); await backend.connect();
  const modern = { ...input('Current unrelated evidence.', 20), chunks: [], versions: [{ timestamp: 10, title: 'Old guide', text: 'Historical bird evidence.', chunks: [{ text: 'Historical bird evidence.', embedding: [1, 0] }], summary: 'An old overview about birds.' }] };
  const first = await backend.send({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [modern] }); assert.equal(first.imported, 1);
  const db = await backend.load('src/shared/db/index.ts');
  const saved = await db.getPageRecord(url);
  assert.equal(saved.summary, undefined); assert.equal(saved.text, modern.text); assert.equal(saved.chunks.length, 0);
  assert.equal(saved.versions[0].summary, modern.versions[0].summary);
  const exported = (await backend.send({ type: 'GET_ALL_PAGES' })).pages;
  assert.equal((await backend.send({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: exported })).imported, 1);
  assert.equal((await db.getPageRecord(url)).summary, undefined);
  const lackingChunks = { ...modern }; delete lackingChunks.chunks;
  assert.equal((await backend.send({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [lackingChunks] })).imported, 1);
  assert.equal((await db.getPageRecord(url)).chunks.length, 0);
});

test('worker recovery replays pending indexing without duplicating versions or changing their identities and observation times', async t => {
  const state = await fixture(t), first = await state.capture('Original evidence.', 10);
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager: state.db } }, { chrome: chromeFixture });
  await processing.markQueued(input('Pending revised evidence.', 20), 0);
  const current = await state.db.getPageRecord(url);
  await state.db.updateSavedVersion(url, first.versionId, 'keep');
  const capture = await loadSource('src/background/capture/index.ts', '', {
    './processor': { processCapturePayload: async () => {} }, '../processing/index': processing,
    '../settings/index': { shouldCaptureUrl: async () => true, getCachedSettingsSnapshot: () => ({}) }, '../../shared/logger/index': { log: async () => {} }
  }, { chrome: chromeFixture });
  const queue = capture.createCaptureQueue(); await queue.ready; await waitFor(() => !queue.isProcessing(), 'pending capture recovery');
  const recovered = await state.db.getPageRecord(url);
  assert.equal(recovered.versionId, current.versionId); assert.equal(recovered.firstCapturedAt, 20); assert.equal(recovered.lastVisitedAt, 20);
  assert.equal(recovered.versions.length, 1); assert.equal(recovered.versions[0].versionId, first.versionId); assert.equal(recovered.versions[0].kept, true);
  assert.equal(await state.db.getProcessingEntry(url), undefined);
});
