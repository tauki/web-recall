import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { withObservationDeadline } from '../scripts/lib/capture-qualification.mjs';
import { previousLayout } from './fixtures/previous-sqlite-layout.mjs';

const id = '08eed336-9b09-489c-9183-0cbe89e85e06';
const evidence = {
  url: 'https://browser-library.example/field-notes', title: 'Field notes', timestamp: 400, createdAt: 250, updatedAt: 410, manual: true,
  text: 'The mountain trail met the river after dusk.', summary: 'A note about the trail.',
  chunks: [{ text: 'The trail met the river.', embedding: [0.8, -0.1], embeddingKey: 'saved-local-space' }],
  versions: [{ timestamp: 250, versionId: 'first-visit', kept: true, text: 'The earlier version was archived.', chunks: [] }]
};

test('the bundled library worker restricts staging to the background and retains an atomic forget across a crash without IndexedDB', async () => {
  const owned = await mkdtemp(path.join(tmpdir(), 'web-recall-sqlite-worker-test-'));
  const extension = path.join(owned, 'extension');
  const runtime = path.join(extension, 'dist/beta');
  const offscreen = path.join(runtime, 'offscreen');
  let context;
  try {
    await mkdir(path.join(offscreen, 'sqlite'), { recursive: true });
    await build({ entryPoints: { index: 'src/offscreen/index.ts', libraryWorker: 'src/offscreen/libraryWorker.ts' },
      outdir: offscreen, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
    const engine = path.dirname(fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')));
    for (const name of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) await copyFile(path.join(engine, name), path.join(offscreen, 'sqlite', name));
    await copyFile('src/offscreen/index.html', path.join(offscreen, 'index.html'));
    const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: manifest.manifest_version, name: 'Disposable saved library runtime test', version: manifest.version,
      permissions: ['offscreen'], background: manifest.background, content_security_policy: manifest.content_security_policy,
      cross_origin_embedder_policy: { value: 'require-corp' }, cross_origin_opener_policy: { value: 'same-origin' }
    }));
    await writeFile(path.join(runtime, 'background.js'), `
      const host = 'dist/beta/offscreen/index.html';
      chrome.runtime.onMessage.addListener((message, sender, reply) => {
        if (message.type !== 'TEST_SQLITE' || sender.url !== chrome.runtime.getURL('probe.html')) return false;
        (async () => {
          if (message.request.kind === 'close') { await chrome.offscreen.closeDocument(); return { closed: true }; }
          if (!(await chrome.offscreen.hasDocument())) await chrome.offscreen.createDocument({ url: host, reasons: ['WORKERS'], justification: 'Exercise the storage worker in a disposable test.' });
          return chrome.runtime.sendMessage({ type: 'OFFSCREEN_SAVED_LIBRARY', request: message.request });
        })().then(reply, error => reply({ error: error.message }));
        return true;
      });
    `);
    await writeFile(path.join(extension, 'probe.html'), '<!doctype html><meta charset="utf-8"><title>Saved library test</title>');
    await writeFile(path.join(offscreen, 'previousLayout.js'), `
      import initialize from './sqlite/index.mjs';
      self.onmessage = async ({ data: { id, record } }) => {
        try {
          const { oo1 } = await initialize();
          const db = new oo1.OpfsWlDb('/web-recall-library.sqlite3', 'c');
          try {
            db.exec(${JSON.stringify(previousLayout)});
            db.exec('insert into saved_pages values(?,?,?,?,?,?)', { bind: [record.url, record.timestamp, record.title, JSON.stringify(record), '{}', new Uint8Array([0, 1])] });
            db.exec('insert into saved_library values(?,5,1,0,0,0,0)', { bind: [id] });
          } finally { db.close(); }
          self.postMessage({ written: true });
        } catch (error) { self.postMessage({ error: String(error) }); }
      };
    `);
    let origin;
    async function open() {
      context = await chromium.launchPersistentContext(path.join(owned, 'profile'), {
        channel: 'chromium', headless: true, timeout: 12000, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND']
      });
      const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
      const address = `chrome-extension://${new URL(background.url()).hostname}`;
      if (origin) assert.equal(address, origin);
      origin = address;
      const tab = await context.newPage();
      await tab.goto(`${origin}/probe.html`);
      return tab;
    }
    let page = await open();
    const send = request => withObservationDeadline(() => page.evaluate(request => chrome.runtime.sendMessage({ type: 'TEST_SQLITE', request }), request), request.kind);
    const operation = action => send({ kind: 'operate', id, action });
    assert.deepEqual(await send({ kind: 'inspect' }), { exists: false, library: null });
    const unauthorized = await page.evaluate(id => chrome.runtime.sendMessage({ type: 'OFFSCREEN_SAVED_LIBRARY', request: { kind: 'stage', id, source: 'empty' } }).catch(() => undefined), id);
    assert.equal(unauthorized, undefined);
    assert.deepEqual(await send({ kind: 'inspect' }), { exists: false, library: null }, 'A direct page request must not write a library');
    assert.match((await send({ kind: ['stage'], id })).error, /Unknown saved library request/u);
    assert.deepEqual(await send({ kind: 'inspect' }), { exists: false, library: null }, 'A malformed request must not open or initialize the authority');
    const descriptor = { id, sourceVersion: 5, pages: 1, processing: 0 };
    await withObservationDeadline(() => page.evaluate(input => new Promise((resolve, reject) => {
      const worker = new Worker('dist/beta/offscreen/previousLayout.js', { type: 'module' });
      worker.onmessage = ({ data }) => { worker.terminate(); if (data.written) resolve(); else reject(Error(data.error)); };
      worker.onerror = error => { worker.terminate(); reject(Error(error.message)); };
      worker.postMessage(input);
    }), { id, record: evidence }), 'stage an interrupted legacy layout in the disposable profile');
    assert.match((await send({ kind: 'stage', id: '4dd60641-b2fe-480e-a2f5-d2659e619aba', source: 'indexeddb', preparing: true })).error, /another migration/u);
    assert.deepEqual(await send({ kind: 'stage', id, source: 'indexeddb', preparing: true }), { library: descriptor }, 'Resume a sealed layout even though its IndexedDB source is not available');
    assert.deepEqual(await send({ kind: 'activate', id }), { active: true });
    const resumed = await operation({ op: 'searchText', query: '"river after dusk"', limit: 1, filters: {} });
    assert.equal(resumed.value.results[0]?.url, evidence.url);
    assert.deepEqual(await operation({ op: 'read', url: evidence.url }), { value: evidence });
    assert.deepEqual(await send({ kind: 'close' }), { closed: true });
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('web-recall-library.sqlite3'));
    await page.evaluate(record => new Promise((resolve, reject) => {
      const request = indexedDB.open('webRecallBeta', 5);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('pages', { keyPath: 'url' }).add(record);
        request.result.createObjectStore('processing', { keyPath: 'url' });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    }), evidence);
    assert.match((await send({ kind: 'stage', id, source: 'empty', preparing: true })).error, /cannot be replaced with an empty library/u);
    assert.deepEqual(await send({ kind: 'stage', id, source: 'indexeddb', preparing: true }), { library: descriptor });
    assert.deepEqual(await send({ kind: 'read', id, url: evidence.url }), { page: evidence });
    assert.match((await operation({ op: 'save', record: { ...evidence, text: 'Unverified cutover' } })).error, /active saved library is not available/u);
    assert.deepEqual(await send({ kind: 'activate', id }), { active: true });
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('webRecallBeta');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('The migration left the source open'));
    }));
    assert.deepEqual(await send({ kind: 'close' }), { closed: true });
    assert.deepEqual(await send({ kind: 'inspect' }), { exists: true, library: descriptor });
    assert.deepEqual(await operation({ op: 'read', url: evidence.url }), { value: evidence });
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), [], 'Reopening saved data must not recreate the missing source');

    const text = 'A later visit recorded a repaired footbridge.';
    const job = { url: evidence.url, title: evidence.title, status: 'queued', attempts: 0, createdAt: 900, updatedAt: 900, lastAttemptAt: 0,
      payload: { url: evidence.url, title: evidence.title, timestamp: 900, text, chunks: [text], captureId: 'new-generation' } };
    assert.deepEqual(await operation({ op: 'save', record: { ...evidence, timestamp: 900, text, chunks: [{ text, embedding: [] }] }, options: { captureEntry: job } }), { value: null });
    assert.deepEqual(await operation({ op: 'job', url: evidence.url }), { value: job });
    const result = (await operation({ op: 'searchPage', url: evidence.url })).value.record;
    assert.equal(result.text, text);
    assert.deepEqual(result.chunks, [], 'Text scan must not transfer model vectors');
    assert.equal(result.versions[0].text, evidence.text);
    assert.match((await operation({ op: 'save', record: evidence, options: { requireProcessing: true, expectedCaptureId: 'stale' } })).error, /Page update aborted/u);
    const browser = context.browser();
    const session = await browser.newBrowserCDPSession();
    const disconnected = new Promise(resolve => browser.once('disconnected', resolve));
    const removed = await operation({ op: 'forget', selection: [{ url: evidence.url, versionIds: [result.versionId] }], filters: { from: 700 } });
    assert.deepEqual(removed.value.captureJobs, [{ url: evidence.url, captureId: 'new-generation' }]);
    assert.equal(removed.value.versions, 1);
    await withObservationDeadline(() => Promise.all([session.send('Browser.crash').catch(() => {}), disconnected]), 'crash only the owned disposable browser');
    await context.close();
    page = await open();
    const afterCrash = await operation({ op: 'read', url: evidence.url });
    assert.equal(afterCrash.value.text, evidence.text);
    assert.deepEqual(afterCrash.value.chunks, evidence.chunks);
    assert.ok(!afterCrash.value.versions.some(version => version.text === text));
    assert.deepEqual(await operation({ op: 'job', url: evidence.url }), { value: null });
    assert.deepEqual(await operation({ op: 'setJob', entry: job, create: false }), { value: false });
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
    assert.deepEqual(await send({ kind: 'close' }), { closed: true });
    assert.deepEqual(await send({ kind: 'activate', id }), { active: true });
    await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('web-recall-library.sqlite3'));
    assert.match((await send({ kind: 'stage', id, source: 'empty', preparing: true })).error, /previously activated saved library is missing/u);
    assert.equal(await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle('web-recall-library.sqlite3').then(() => true, error => { if (error.name === 'NotFoundError') return false; throw error; });
    }), false);
  } finally {
    await context?.close();
    await rm(owned, { recursive: true, force: true });
  }
});
