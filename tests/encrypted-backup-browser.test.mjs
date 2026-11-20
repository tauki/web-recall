import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { buildBrowserStorageRuntime } from './browser-storage-runtime.mjs';

test('Chrome saves encrypted local backups and restores saved history in a fresh offline profile', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-recall-encrypted-backup-'));
  let context;
  t.after(async () => { await context?.close(); await rm(directory, { recursive: true, force: true }); });
  await buildBrowserStorageRuntime(directory);
  const worker = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { storageManager } from './src/background/storage/manager.ts';
    import './src/background/index.ts';
    const wire = [];
    chrome.runtime.connectNative = () => {
      let receive;
      return {
        onMessage: { addListener(listener) { receive = listener; } }, onDisconnect: { addListener() {} }, disconnect() {},
        postMessage(request) {
          if (request.action === 'backup_status_encrypted') { receive({ id: request.id, type: 'backup_status_encrypted', text: 'Test folder' }); return; }
          if (request.action === 'backup_begin_encrypted') { receive({ id: request.id, type: 'backup_ready_encrypted' }); return; }
          if (request.action === 'backup_chunk') {
            wire.push(...atob(request.data).split('').map(character => character.charCodeAt(0)));
            receive({ id: request.id, type: 'backup_ack' }); return;
          }
          if (request.action === 'backup_finish') receive({ id: request.id, type: 'backup_saved' });
        }
      };
    };
    const address = 'https://reference.test/retained';
    globalThis.qualification = {
      seed() { return storageManager.savePageRecord({ url: address, title: 'Original article', text: 'Evidence kept private 🐢.', timestamp: 3000, versionId: 'current', chunks: [],
        versions: [{ title: 'Older saved article', text: 'A historical passage.', timestamp: 1000, versionId: 'historical', kept: true, chunks: [] }] }); },
      read() { return storageManager.getPageRecord(address); },
      file() { return wire; }
    };
  ` }, bundle: true, write: false, format: 'esm' });
  await writeFile(path.join(directory, 'dist/beta/background.js'), worker.outputFiles[0].text);
  const panel = path.join(directory, 'dist/beta/ui/sidepanel');
  await mkdir(panel, { recursive: true });
  await build({ entryPoints: ['src/ui/sidepanel/index.ts'], outfile: path.join(panel, 'index.js'), bundle: true, format: 'esm' });
  await writeFile(path.join(panel, 'index.html'), await readFile('src/ui/sidepanel/index.html'));
  const { background, side_panel, content_security_policy, cross_origin_embedder_policy, cross_origin_opener_policy } = JSON.parse(await readFile('manifest.json', 'utf8'));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Web Recall encrypted backup contract', version: '1.0',
    permissions: ['storage', 'offscreen', 'unlimitedStorage', 'nativeMessaging', 'alarms', 'sidePanel'], background,
    side_panel, content_security_policy, cross_origin_embedder_policy, cross_origin_opener_policy }));
  const open = async profile => {
    context = await chromium.launchPersistentContext(path.join(directory, profile), { channel: 'chromium', headless: true, timeout: 10000, args: [
      `--disable-extensions-except=${directory}`, `--load-extension=${directory}`
    ] });
    await context.setOffline(true);
    const runtime = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10000 });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`chrome-extension://${new URL(runtime.url()).host}/dist/beta/ui/sidepanel/index.html#settings-storage`);
    return { runtime, page };
  };
  const source = await open('source');
  await source.runtime.evaluate(() => globalThis.qualification.seed());
  const key = 'WR1-' + Buffer.alloc(32, 87).toString('base64url');
  const copy = source.page.getByRole('button', { name: 'Copy recovery key' });
  await copy.waitFor();
  assert.equal(await copy.isEnabled(), false);
  await source.page.evaluate(() => {
    globalThis.copiedKeys = [];
    Object.defineProperty(navigator, 'clipboard', { value: {
      async writeText(value) { globalThis.copiedKeys.push(value); }
    } });
  });
  await source.page.getByRole('button', { name: 'Generate recovery key' }).click();
  assert.equal(await copy.isEnabled(), true);
  await source.page.locator('#manage-backup-key').fill(key);
  assert.deepEqual(await source.page.evaluate(() => globalThis.copiedKeys), []);
  await copy.click();
  await source.page.getByText('Recovery key copied.', { exact: true }).waitFor();
  assert.deepEqual(await source.page.evaluate(() => globalThis.copiedKeys), [key]);
  await source.page.locator('#manage-backup-key-confirm').check();
  await source.page.getByRole('button', { name: 'Save recovery key' }).click();
  await source.page.getByText('Recovery key set up.', { exact: false }).waitFor();
  await source.page.evaluate(() => {
    window.showSaveFilePicker = ({ suggestedName }) => navigator.storage.getDirectory().then(root => root.getFileHandle(suggestedName, { create: true }));
  });
  await source.page.getByRole('button', { name: 'Save encrypted backup' }).click();
  await source.page.getByText('Export complete: 1 pages', { exact: true }).waitFor();
  const manual = Buffer.from(await source.page.evaluate(async () => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle('web-recall-backup.wrbackup')).getFile();
    return [...new Uint8Array(await file.arrayBuffer())];
  }));
  await source.page.locator('summary').filter({ hasText: 'Mac companion folder' }).click();
  await source.page.getByRole('button', { name: 'Back up now' }).click();
  await source.page.getByText('Encrypted backup saved to folder.', { exact: false }).waitFor();
  const bytes = Buffer.from(await source.runtime.evaluate(() => globalThis.qualification.file()));
  for (const archive of [manual, bytes]) {
    assert.equal(archive.subarray(0, 5).toString(), 'WRBK1');
    assert.ok(!archive.includes('Evidence kept private') && !archive.includes('historical passage') && !archive.includes('reference.test') && !archive.includes(key));
  }
  assert.notDeepEqual(manual, bytes, 'Each backup uses a fresh salt');

  await context.close();
  const { runtime, page } = await open('restore');
  assert.equal(await runtime.evaluate(() => globalThis.qualification.read()), undefined);
  const restore = async (file, expected) => {
    await page.locator('#manage-import').setInputFiles({ name: 'local-copy.wrbackup', mimeType: 'application/octet-stream', buffer: file });
    await page.getByLabel('Backup recovery key').fill(key);
    await page.getByRole('button', { name: 'Unlock backup' }).click();
    await page.getByText(expected, { exact: false }).waitFor();
  };
  await restore(bytes.subarray(0, -1), 'The encrypted backup is incomplete.');
  assert.equal(await runtime.evaluate(() => globalThis.qualification.read()), undefined);
  await restore(bytes, 'Import complete: 1 pages');
  const pageRecord = await runtime.evaluate(() => globalThis.qualification.read());
  assert.equal(pageRecord.text, 'Evidence kept private 🐢.');
  assert.equal(pageRecord.versions[0].text, 'A historical passage.');
  assert.equal(pageRecord.versions[0].kept, true);
});
