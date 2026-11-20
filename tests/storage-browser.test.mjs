import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { loadSource } from './helpers.mjs';
import { assertRetainedPages, withObservationDeadline } from '../scripts/lib/capture-qualification.mjs';
import { buildBrowserStorageRuntime } from './browser-storage-runtime.mjs';

async function crashBrowser(context) {
  const browser = context.browser(), session = await browser.newBrowserCDPSession();
  const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
  await withObservationDeadline(() => Promise.all([session.send('Browser.crash').catch(() => {}), disconnected]), 'crash the disposable browser', 10000);
  assert.equal(browser.isConnected(), false);
  await context.close().catch(() => {});
}

const rpc = (page, message) => withObservationDeadline(() => page.evaluate(message => chrome.runtime.sendMessage(message), message), message.type, 10000);
const readAuthority = page => page.evaluate(async () => (await chrome.storage.local.get('savedLibraryAuthority')).savedLibraryAuthority);
const savedFiles = page => page.evaluate(async () => (await Array.fromAsync((await navigator.storage.getDirectory()).keys())).sort());
const missingLibrary = /saved library (?:file )?is missing/iu;

async function waitForOwnedState(check, label) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function removeOwnedDatabase(page, filename) {
  assert.ok((await savedFiles(page)).includes(filename), 'Only an existing test-owned library can be removed');
  await waitForOwnedState(() => page.evaluate(async name => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(name); return true; }
    catch (error) { if (error.name === 'NoModificationAllowedError') return false; throw error; }
  }, filename), 'Chrome to release the disposable SQLite file lock');
}

async function restoreThroughPort(page, frames, after) {
  return withObservationDeadline(() => page.evaluate(async ({ frames, after }) => {
    const port = chrome.runtime.connect({ name: 'web-recall-backup' });
    if (after === 'hold') globalThis.ownedRecoveryTestPort = port;
    let sequence = 0;
    const request = fields => new Promise((resolve, reject) => {
      const id = ++sequence;
      const receive = reply => {
        if (reply.id !== id) return;
        port.onMessage.removeListener(receive);
        port.onDisconnect.removeListener(disconnected);
        resolve(reply);
      };
      const disconnected = () => reject(Error(chrome.runtime.lastError?.message || 'Backup port disconnected'));
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(disconnected);
      port.postMessage({ id, ...fields });
    });
    try {
      let reply;
      for (const line of frames) {
        reply = await request({ action: 'import', line, recover: true });
        if (reply.error) return reply;
      }
      return after === 'cancel' || after === 'publish' ? await request({ action: after }) : reply;
    } finally {
      if (after !== 'hold') port.disconnect();
    }
  }, { frames, after }), 'receive backup staging feedback', 10000);
}

for (const [interruption, name] of [
  ['restart', 'saved memory survives an isolated Chrome restart and cached model files remain reusable'],
  ['browser-process crash', 'saved memory survives an isolated Chrome browser-process crash'],
  ['indexeddb loss', 'the live Chrome extension retains saved text across IndexedDB removal and restart'],
  ['authority loss', 'only a confirmed complete backup restores a missing library across browser crashes']
]) test(name, { timeout: interruption === 'authority loss' ? 90000 : 30000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'web-recall-storage-test-'));
  const extension = path.join(temporary, 'extension');
  const profile = path.join(temporary, 'profile');
  let context;
  try {
    await mkdir(extension);
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const { manifest_version, minimum_chrome_version, version, permissions, background, content_security_policy,
      cross_origin_embedder_policy, cross_origin_opener_policy } = manifest;
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version, minimum_chrome_version, version, permissions,
      background, content_security_policy, cross_origin_embedder_policy, cross_origin_opener_policy, name: 'Web Recall isolated storage test' }));
    await mkdir(path.join(extension, 'dist/beta/ui'), { recursive: true });
    await writeFile(path.join(extension, 'dist/beta/ui/inspect.html'), '<!doctype html><title>Isolated storage test</title>');
    const browserBundle = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' };
    await buildBrowserStorageRuntime(extension);
    if (interruption === 'authority loss') {
      for (const view of ['manage', 'sidepanel']) {
        const target = path.join(extension, 'dist/beta/ui', view);
        await mkdir(target);
        await copyFile(`src/ui/${view}/index.html`, path.join(target, 'index.html'));
        await build({ ...browserBundle, entryPoints: [`src/ui/${view}/index.ts`], outfile: path.join(target, 'index.js') });
      }
    }
    const launch = () => chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, timeout: 10000,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const open = async () => {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
      const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
      const page = await context.newPage();
      await page.goto(`${origin}/dist/beta/ui/inspect.html`);
      return page;
    };
    context = await launch();
    const first = await open();
    assert.equal(await first.evaluate(() => chrome.permissions.contains({ permissions: ['unlimitedStorage'] })), true);
    let cachedFile;
    if (interruption === 'restart') {
      const { BROWSER_MODEL_CACHE } = await loadSource('src/shared/browserModels.ts');
      cachedFile = { name: BROWSER_MODEL_CACHE, url: 'https://huggingface.co/example/storage-test/resolve/pinned/onnx/model.onnx', contents: 'Synthetic cached model bytes, not usable model weights.' };
      await first.evaluate(async file => {
        const cache = await caches.open(file.name);
        await cache.put(file.url, new Response(file.contents));
      }, cachedFile);
    }
    const saved = { url: 'https://example.test/durable', title: 'Persistent article', text: 'Saved evidence before restart.', timestamp: 10, manual: true, summary: 'The article explains durable storage.', chunks: [{ text: 'Saved evidence before restart.', embedding: [0.25, 0.75], embeddingKey: 'test-model' }] };
    const imported = await first.evaluate(record => chrome.runtime.sendMessage({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [record] }), saved);
    assert.equal(imported.error, undefined);
    assert.equal(imported.imported, 1);
    if (interruption === 'indexeddb loss') {
      const session = await context.newCDPSession(first);
      const origin = await first.evaluate(() => location.origin);
      assert.match(origin, /^chrome-extension:\/\/[a-p]{32}$/u);
      await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
      await session.detach();
      await first.waitForFunction(async () => !(await indexedDB.databases()).some(entry => entry.name === 'webRecallBeta'), undefined, { timeout: 10000 });
    }
    if (interruption === 'authority loss') {
      const recovered = {
        url: 'https://backup.test/estuary', title: 'Estuary notes', text: 'The inlet floods twice a day.',
        timestamp: 80, manual: true, summary: 'Field notes on estuary tides.', versionId: 'inlet-new',
        chunks: [{ text: 'The inlet floods twice a day.', embedding: [0.5, 0.25], embeddingKey: 'test-model' }],
        versions: [{ title: 'Low tide', text: 'The sandbar is exposed at low tide.', timestamp: 50,
          versionId: 'inlet-old', kept: true, chunks: [{ text: 'The sandbar is exposed at low tide.', embedding: [0.75, 0], embeddingKey: 'test-model' }] }]
      };
      const { versions, ...current } = recovered;
      const frames = [
        { format: 'web-recall', schemaVersion: 3 }, { type: 'page', page: current, versionCount: 1 },
        { type: 'version', url: current.url, index: 0, version: versions[0] },
        { type: 'page-end', url: current.url, versionCount: 1 }, { type: 'end', pages: 1 }
      ].map(item => JSON.stringify(item));
      const backup = { name: 'saved-estuary.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(frames.join('\n') + '\n') };
      const probe = (operation, label) => withObservationDeadline(operation, label, 10000);
      const origin = await probe(() => first.evaluate(() => location.origin), 'identify the disposable extension origin');
      assert.match(origin, /^chrome-extension:\/\/[a-p]{32}$/u);
      const manageUrl = `${origin}/dist/beta/ui/manage/index.html`;
      const settingsUrl = `${origin}/dist/beta/ui/sidepanel/index.html#settings-storage`;
      await first.goto(manageUrl);
      await first.locator('#manage-count').filter({ hasText: '1 page' }).waitFor({ timeout: 10000 });
      assert.equal(await first.getByRole('link', { name: 'Restore from backup' }).isVisible(), false);
      const otherView = await restoreThroughPort(first, frames, 'close');
      assert.match(otherView.error, /restore a missing library from settings/iu);
      const prior = await readAuthority(first);
      await first.getByRole('link', { name: 'Backups', exact: true }).click();
      await first.waitForURL(settingsUrl);
      assert.equal((await rpc(first, { type: 'GET_BACKUP_RESTORE_MODE' })).recover, false);
      const refused = await restoreThroughPort(first, frames, 'close');
      assert.match(refused.error, /library file still exists/iu);
      assert.deepEqual(await readAuthority(first), prior);
      assertRetainedPages([saved], (await rpc(first, { type: 'GET_ALL_PAGES' })).pages);
      const worker = context.serviceWorkers().find(target => target.url().startsWith(`${origin}/`));
      assert.ok(worker);
      const runtimeMarker = await probe(() => worker.evaluate(() => { globalThis.storageTestRuntime = crypto.randomUUID(); return globalThis.storageTestRuntime; }), 'mark the live extension worker');
      await probe(() => worker.evaluate(() => chrome.offscreen.closeDocument()), 'close only the disposable authority worker');
      await removeOwnedDatabase(first, 'web-recall-library.sqlite3');
      await first.goto(manageUrl, { timeout: 10000 });
      await first.locator('#manage-status').filter({ hasText: missingLibrary }).waitFor({ timeout: 10000 });
      assert.doesNotMatch(await first.locator('#manage-count').textContent({ timeout: 10000 }), /0 pages/u);
      assert.doesNotMatch(await first.locator('#manage-rows').textContent({ timeout: 10000 }), /no saved pages/iu);
      assert.equal(await probe(() => worker.evaluate(() => globalThis.storageTestRuntime), 'verify the same worker handled the missing library'), runtimeMarker);
      assert.deepEqual(await savedFiles(first), []);
      await first.getByRole('link', { name: 'Restore from backup' }).click();
      await first.locator('#manage-import:focus').waitFor({ timeout: 10000 });
      assert.equal((await rpc(first, { type: 'GET_BACKUP_RESTORE_MODE' })).recover, true);
      const incomplete = await restoreThroughPort(first, frames.slice(0, -1), 'publish');
      assert.match(incomplete.error, /verified end/iu);
      assert.deepEqual(await readAuthority(first), prior);
      const extra = await restoreThroughPort(first, [...frames, '{}'], 'close');
      assert.match(extra.error, /after the backup end/iu);
      assert.deepEqual(await readAuthority(first), prior);
      const stopped = await restoreThroughPort(first, frames, 'cancel');
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.pages, 0);
      assert.deepEqual(await savedFiles(first), []);
      const staged = await restoreThroughPort(first, frames, 'hold');
      assert.equal(staged.pages, 0, 'A verified but unpublished backup must not acknowledge restored pages');
      assert.equal(staged.complete, false);
      assert.equal(staged.staged, 1);
      assert.match((await rpc(first, { type: 'GET_PAGE_LIST' })).error, missingLibrary);
      const interrupted = await readAuthority(first);
      assert.equal(interrupted.id, prior.id);
      assert.notEqual(interrupted.recoveryId, prior.id);
      await crashBrowser(context);
      context = await launch();
      const manage = await open();
      await manage.goto(manageUrl, { timeout: 10000 });
      await manage.locator('#manage-status').filter({ hasText: missingLibrary }).waitFor({ timeout: 10000 });
      assert.equal((await readAuthority(manage)).id, prior.id);
      await manage.getByRole('link', { name: 'Restore from backup' }).click();
      await manage.locator('#manage-import:focus').waitFor({ timeout: 10000 });
      manage.once('dialog', dialog => dialog.dismiss());
      await manage.locator('#manage-import').setInputFiles(backup);
      await manage.locator('#settings-backup-status').filter({ hasText: 'Library restore cancelled' }).waitFor({ timeout: 10000 });
      assert.equal((await readAuthority(manage)).id, prior.id);
      manage.once('dialog', dialog => dialog.accept());
      await manage.locator('#manage-import').setInputFiles(backup);
      await manage.locator('#settings-backup-status').filter({ hasText: /Library restored: 1 saved page/u }).waitFor({ timeout: 10000 });
      const replacement = await readAuthority(manage);
      assert.equal((await rpc(manage, { type: 'GET_BACKUP_RESTORE_MODE' })).recover, false);
      assert.notEqual(replacement.id, prior.id, 'A restored backup must become a new authority');
      assert.deepEqual(await savedFiles(manage), [`web-recall-library-${replacement.id}.sqlite3`], 'Interrupted restore files must be retired on retry');
      assertRetainedPages([recovered], (await rpc(manage, { type: 'GET_ALL_PAGES' })).pages);
      assert.ok((await rpc(manage, { type: 'SEARCH_QUERY', query: '"sandbar is exposed"', requestId: 'restored-history' })).results.some(hit => hit.url === recovered.url && hit.versionId === 'inlet-old'));
      assert.equal((await rpc(manage, { type: 'SET_SETTINGS', payload: { automaticAi: false } })).error, undefined);
      const newer = { url: 'https://example.test/after-restore', title: 'New entry', text: 'New evidence after recovery.', timestamp: 200, manual: true };
      assert.equal((await rpc(manage, { type: 'SAVE_PAGE', ...newer, chunks: [newer.text] })).status, 'queued');
      const committed = await rpc(manage, { type: 'GET_ALL_PAGES' });
      assert.equal(committed.pages.find(page => page.url === newer.url)?.text, newer.text, 'New capture admission must recover in the same worker');
      await crashBrowser(context);
      context = await launch();
      const reopened = await open();
      assertRetainedPages(committed.pages, (await rpc(reopened, { type: 'GET_ALL_PAGES' })).pages);
      await waitForOwnedState(async () => (await rpc(reopened, { type: 'GET_PROCESSING' })).queue?.length === 0, 'the disposable capture queue to drain');
      const reopenedWorker = context.serviceWorkers().find(target => target.url().startsWith(`${origin}/`));
      await reopenedWorker.evaluate(() => chrome.offscreen.closeDocument());
      await removeOwnedDatabase(reopened, `web-recall-library-${replacement.id}.sqlite3`);
      assert.deepEqual(await savedFiles(reopened), [], 'A fixture must actually remove the first restored database');
      await reopened.goto(manageUrl);
      const status = reopened.locator('#manage-status');
      await status.filter({ hasText: missingLibrary }).waitFor({ timeout: 10000 }).catch(async error => {
        const detail = { status: await status.textContent({ timeout: 1000 }), count: await reopened.locator('#manage-count').textContent(),
          authority: await readAuthority(reopened), files: await savedFiles(reopened), read: await rpc(reopened, { type: 'GET_PAGE_LIST' }) };
        throw new Error(`Expected missing recovered library; observed ${JSON.stringify(detail)}.`, { cause: error });
      });
      await reopened.goto(settingsUrl);
      reopened.once('dialog', dialog => dialog.accept());
      await reopened.locator('#manage-import').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, pages: [saved] })) });
      await reopened.locator('#settings-backup-status').filter({ hasText: /Library restored: 1 saved page/u }).waitFor({ timeout: 10000 });
      assertRetainedPages([saved], (await rpc(reopened, { type: 'GET_ALL_PAGES' })).pages);
      const remaining = await savedFiles(reopened);
      assert.equal(remaining.length, 1);
      await reopened.evaluate(() => chrome.storage.local.remove('savedLibraryAuthority'));
      await context.close();
      context = await launch();
      const noPointer = await open();
      assert.match((await rpc(noPointer, { type: 'GET_PAGE_LIST' })).error, /no matching startup identity/iu);
      assert.deepEqual(await savedFiles(noPointer), remaining, 'Missing identity must not overwrite recovered database bytes or initialize a new library');
      return;
    }
    const originalUrl = first.url();
    if (interruption === 'browser-process crash') {
      await crashBrowser(context);
    } else await context.close();
    context = undefined;
    context = await launch();
    const second = await open();
    assert.equal(second.url(), originalUrl);
    const result = await second.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_BACKUP_PAGE' }));
    assert.equal(result.error, undefined);
    const restored = JSON.parse(result.line).page;
    assert.equal(restored.url, saved.url);
    assert.equal(restored.title, saved.title);
    assert.equal(restored.text, saved.text);
    assert.equal(restored.timestamp, saved.timestamp);
    assert.equal(restored.summary, saved.summary);
    assert.equal(restored.manual, true);
    assert.deepEqual(restored.chunks, saved.chunks);
    if (cachedFile) {
      const retainedModel = await second.evaluate(async file => {
        if (!(await caches.has(file.name))) return null;
        return (await (await caches.open(file.name)).match(file.url))?.text();
      }, cachedFile);
      assert.equal(retainedModel, cachedFile.contents, 'A normal restart must reuse cached model files');
    }
  } finally {
    try { await withObservationDeadline(() => context?.close(), 'close the disposable Chrome profile', 10000); }
    finally { if (!context?.browser()?.isConnected()) await rm(temporary, { recursive: true, force: true }); }
  }
});
