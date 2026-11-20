import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fingerprint, withObservationDeadline } from './lib/capture-qualification.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argument = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const browserExecutable = argument('browser-executable');
const expectedVersion = argument('browser-version');
const sqliteDist = argument('sqlite-dist');
assert.ok(browserExecutable && /^\d+\.\d+\.\d+\.\d+$/u.test(expectedVersion || '') && sqliteDist, 'Provide --browser-executable, exact --browser-version, and --sqlite-dist');
const baseline = path.resolve(root, argument('baseline') ?? 'dist/release-v0.2.3/web-recall-0.2.3.zip');
const baselineBytes = await readFile(baseline);
const baselineDigest = fingerprint(baselineBytes);
assert.equal(baselineDigest, 'f7d40b097e36a9b651b289c50e90357021b9f29ca3e4493cbf8179e36ad3bfe5', 'Use the published v0.2.3 Chrome ZIP');
const execFile = promisify(execFileCallback);
const sqlitePackage = JSON.parse(await readFile(path.join(sqliteDist, '..', 'package.json'), 'utf8'));
assert.equal(sqlitePackage.name, '@sqlite.org/sqlite-wasm');
assert.equal(sqlitePackage.version, '3.54.1-build1');
const sqliteAssets = {
  'index.mjs': '0dcdd860e6ec672623b13b8b8e41bb6c78be7a5df80ec553fc4f69160161c8af',
  'sqlite3.wasm': 'b8a92a19f441a90ff2339fe988fbe317c4adf3ed844096f12aee04aa72d58257',
  'sqlite3-opfs-async-proxy.js': '02c38ed7f2d41d2b57ee02241d7f8a09059e1ded16749013f2412137614aa459'
};
const startedAt = new Date().toISOString();
const output = path.join(root, 'output/qualification');
await mkdir(output, { recursive: true });
const reportFile = path.resolve(root, argument('report') ?? path.join(output, `${startedAt.replace(/[:.]/gu, '-')}-sqlite-recovery.json`));
await writeFile(reportFile, '', { flag: 'wx' });
const report = {
  protocol: 'sqlite-offscreen-migration-qualification-v3', startedAt, browserExecutable, expectedVersion, sqlite: sqlitePackage.version, vfs: 'opfs-wl', baselineDigest,
  fixture: {}, stages: [], requests: [], cleanupErrors: [],
  limitations: [
    'Disposable MV3 offscreen document and dedicated worker. Upgrade from the published package into a fixture using the current source reader. No user data, profile, cache, or network is used.',
    'SQLite apply/recovery fixture only. Not a crash inside sync/commit, raw-disk power loss, live application cutover, or a storage/latency benchmark.'
  ]
};
let owned, extension, profile, context, extensionId;

const first = {
  pages: [['current', 'First recorded title', 'The old text is the only evidence.'], ['retired', 'Archived note', 'This page will be forgotten.']],
  versions: [['older', 'current', 'Previously saved evidence.'], ['retired-earlier', 'retired', 'An earlier snapshot to forget.']],
  jobs: [['current', 'old-capture'], ['retired', 'retired-capture']]
};
const second = {
  pages: [['current', 'New recorded title', 'The new text uses café and spruce 🌲.'], ['new', 'One more page', 'This save belongs to the same transaction.']],
  versions: [['first', 'current', 'The old text is the only evidence.'], ['older', 'current', 'Previously saved evidence.']],
  jobs: [['current', 'new-capture'], ['new', 'additional-capture']]
};
const op = (kind, changes) => ({ pages: [], jobs: [], versions: [], forget: [], ...changes, kind });

async function stage(name, action) {
  const entry = { name };
  report.stages.push(entry);
  Object.assign(entry, await action(entry), { passed: true });
  console.info(`${name}: passed`);
}

async function open(pagePath) {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', executablePath: browserExecutable, headless: true, timeout: 20000,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--host-resolver-rules=MAP * ~NOTFOUND']
  });
  const browser = context.browser();
  report.browserVersion = browser.version();
  assert.equal(report.browserVersion, expectedVersion);
  context.on('request', request => { if (/^https?:/u.test(request.url())) report.requests.push(request.url()); });
  await withObservationDeadline(() => context.route(/^https?:/u, route => route.abort()), 'block nonfixture requests');
  const session = await withObservationDeadline(() => browser.newBrowserCDPSession(), 'attach to the owned fixture browser');
  try {
    const { id } = await withObservationDeadline(() => session.send('Extensions.loadUnpacked', { path: extension }), 'load the owned fixture');
    assert.match(id, /^[a-p]{32}$/u);
    if (extensionId) assert.equal(id, extensionId, 'The test must reopen the same extension origin');
    extensionId = id;
  } finally { await withObservationDeadline(() => session.detach(), 'detach the fixture installer'); }
  return openProbe(pagePath);
}

async function openProbe(pagePath = 'probe.html') {
  const page = await withObservationDeadline(() => context.newPage(), 'open the owned fixture page');
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`, { timeout: 12000 });
  return page;
}

async function reloadFixture() {
  const manager = await withObservationDeadline(() => context.newPage(), 'open fixture registration');
  try {
    await manager.goto('chrome://extensions/', { timeout: 12000 });
    const label = { name: 'Developer mode', exact: true };
    const developerMode = manager.getByRole('switch', label).or(manager.getByRole('button', label));
    if (!(await developerMode.evaluate(node => node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true'))) await developerMode.click();
    await manager.getByRole('switch', { ...label, checked: true }).or(manager.getByRole('button', { ...label, pressed: true })).waitFor({ timeout: 10000 });
    const registration = await withObservationDeadline(() => manager.evaluate(async id => {
      const details = { includeDisabled: true, includeTerminated: true };
      const previous = (await chrome.developerPrivate.getExtensionsInfo(details)).find(entry => entry.id === id);
      if (previous?.version !== '0.2.3' || previous.state !== 'ENABLED') throw Error('The published release is not the enabled fixture registration');
      const failure = await chrome.developerPrivate.reload(id, { failQuietly: true, populateErrorForUnpacked: true });
      if (failure) throw Error(failure.error || 'The unpacked fixture did not reload');
      const updated = (await chrome.developerPrivate.getExtensionsInfo(details)).find(entry => entry.id === id);
      return { id: updated?.id, name: updated?.name, state: updated?.state, version: updated?.version };
    }, extensionId), 'reload only the disposable release registration and await completion');
    assert.deepEqual(registration, { id: extensionId, name: 'Disposable SQLite recovery fixture', state: 'ENABLED', version: '1.0.0' });
  } finally { await manager.close(); }
  return openProbe();
}

async function close() {
  if (!context) return;
  const browser = context.browser();
  await withObservationDeadline(() => context.close(), 'close the owned browser');
  assert.equal(browser.isConnected(), false, 'Do not reopen or remove the running profile');
  context = undefined;
}

async function crash(session, triggerTime) {
  const disconnected = new Promise(resolve => context.browser().once('disconnected', resolve));
  let requestedAfterMs;
  await withObservationDeadline(() => {
    if (triggerTime !== undefined) requestedAfterMs = performance.now() - triggerTime;
    return Promise.all([session.send('Browser.crash').catch(() => {}), disconnected]);
  }, 'crash only the owned process');
  await close();
  return requestedAfterMs;
}

function rpc(page, request) {
  return withObservationDeadline(() => page.evaluate(request => chrome.runtime.sendMessage({ channel: 'sqlite-probe', request }), request), `SQLite fixture ${request.kind}`);
}

function fileState(page) {
  return withObservationDeadline(() => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const database = await (await root.getFileHandle('qualification-library.sqlite3')).getFile();
    if (database.size > 2 * 1024 * 1024) throw Error('Unexpected size for the bounded qualification fixture');
    const journal = await root.getFileHandle('qualification-library.sqlite3-journal').catch(error => {
      if (error.name !== 'NotFoundError') throw error;
    });
    const digest = await crypto.subtle.digest('SHA-256', await database.arrayBuffer());
    return { dbBytes: database.size, dbDigest: Array.from(new Uint8Array(digest)), journalBytes: journal ? (await journal.getFile()).size : 0 };
  }), 'inspect the bounded fixture database and rollback-journal bytes');
}

async function verify(page, expected) {
  const observed = await rpc(page, { kind: 'inspect' });
  assert.deepEqual(observed, { ...expected, integrity: ['ok'], brokenReferences: [] });
  return { pages: observed.pages.length, versions: observed.versions.length, jobs: observed.jobs.length, digest: fingerprint(JSON.stringify(observed)) };
}

function legacyRows(page, jobToInsert) {
  return withObservationDeadline(() => page.evaluate(async jobToInsert => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('webRecallBeta');
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (jobToInsert) await new Promise((resolve, reject) => {
        const tx = database.transaction('processing', 'readwrite', { durability: 'strict' });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        tx.objectStore('processing').add(jobToInsert);
      });
      return await new Promise((resolve, reject) => {
        const tx = database.transaction(['pages', 'processing'], 'readonly');
        const pages = tx.objectStore('pages').getAll(), processing = tx.objectStore('processing').getAll();
        tx.oncomplete = () => resolve({ version: database.version, pages: pages.result, processing: processing.result });
        tx.onabort = () => reject(tx.error);
      });
    } finally { database.close(); }
  }, jobToInsert), 'independently observe the published indexed database');
}

try {
  owned = await mkdtemp(path.join(tmpdir(), 'web-recall-sqlite-recovery-'));
  extension = path.join(owned, 'extension');
  profile = path.join(owned, 'profile');
  await mkdir(path.join(extension, 'sqlite'), { recursive: true });
  const assets = {
    'manifest.json': JSON.stringify({ manifest_version: 3, version: '1.0.0', name: 'Disposable SQLite recovery fixture',
      permissions: ['offscreen'], background: { service_worker: 'background.js', type: 'module' },
      cross_origin_embedder_policy: { value: 'require-corp' }, cross_origin_opener_policy: { value: 'same-origin' },
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
    }),
    'probe.html': '<!doctype html><meta charset="utf-8"><title>SQLite recovery fixture</title>',
    'offscreen.html': '<!doctype html><meta charset="utf-8"><script src="sqlite-offscreen.js"></script>',
    'background.js': await readFile(path.join(root, 'tests/fixtures/opfs-recovery/sqlite-background.js')),
    'sqlite-offscreen.js': await readFile(path.join(root, 'tests/fixtures/opfs-recovery/sqlite-offscreen.js')),
    'sqlite-worker.mjs': await readFile(path.join(root, 'tests/fixtures/opfs-recovery/sqlite-worker.mjs'))
  };
  for (const [name, expectedDigest] of Object.entries(sqliteAssets)) {
    const bytes = await readFile(path.join(sqliteDist, name));
    assert.equal(fingerprint(bytes), expectedDigest, `SQLite fixture asset does not match the pinned build: ${name}`);
    assets[`sqlite/${name}`] = bytes;
  }
  const sourceReader = await build({ entryPoints: [path.join(root, 'src/shared/db/savedLibrarySource.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  assets['saved-library-source.mjs'] = sourceReader.outputFiles[0].contents;
  const writeFixture = async (directory = extension) => {
    for (const [name, bytes] of Object.entries(assets)) {
      await writeFile(path.join(directory, name), bytes);
      report.fixture[name] = fingerprint(bytes);
    }
  };
  await writeFixture();
  report.runner = fingerprint(await readFile(new URL(import.meta.url)));
  let page = await open();
  await stage('unknown-library-is-not-initialized-by-read', async () => {
    assert.equal((await rpc(page, { kind: 'inspect' })).errorName, 'NotFoundError');
    assert.deepEqual(await withObservationDeadline(() => page.evaluate(async () => {
      const names = [];
      for await (const key of (await navigator.storage.getDirectory()).keys()) names.push(key);
      return names;
    }), 'verify inspection did not create any authority'), []);
  });
  await stage('offscreen-owner-outlives-the-visible-caller-and-reopens', async () => {
    assert.deepEqual(await rpc(page, op('initialize', first)), { committed: true });
    const initial = await verify(page, first);
    const status = await rpc(page, { kind: 'host-status' });
    assert.deepEqual(status, { hostId: status?.hostId, hostIsolated: true, workerIsolated: true, vfsAvailable: true });
    assert.match(status.hostId, /^[0-9a-f-]{36}$/u);
    await page.close({ reason: 'Simulate closing the visible extension caller' });
    page = await openProbe();
    assert.equal((await rpc(page, { kind: 'host-status' })).hostId, status.hostId, 'A new caller must reuse the hidden owner');
    assert.deepEqual(await verify(page, first), initial);
    assert.deepEqual(await rpc(page, { kind: 'close-host' }), { closed: true });
    const replaced = await rpc(page, { kind: 'host-status' });
    assert.deepEqual(replaced, { ...status, hostId: replaced?.hostId });
    assert.match(replaced.hostId, /^[0-9a-f-]{36}$/u);
    assert.notEqual(replaced.hostId, status.hostId, 'Closing the hidden owner must replace it on the next call');
    return { hostIsolated: status.hostIsolated, workerIsolated: status.workerIsolated, vfsAvailable: status.vfsAvailable, reopened: await verify(page, first) };
  });
  await stage('open-transaction-with-file-writes-recovers-all-prior-evidence', async entry => {
    entry.initial = await verify(page, first);
    const before = await fileState(page);
    assert.equal(before.journalBytes, 0);
    const session = await withObservationDeadline(() => context.browser().newBrowserCDPSession(), 'attach before the pending transaction');
    const pages = [...second.pages, ...Array.from({ length: 32 }, (_, index) => [`spill-${index}`, `Affected page ${index}`, 'Uncommitted evidence. '.repeat(1024)])];
    assert.deepEqual(await rpc(page, op('leave-open', { ...second, pages, versions: [second.versions[0]], forget: ['retired'] })), { pending: true });
    const pending = await fileState(page);
    assert.ok(pending.dbBytes > before.dbBytes && pending.journalBytes > 0, 'The open transaction must change database bytes and leave a rollback journal');
    assert.notDeepEqual(pending.dbDigest, before.dbDigest);
    entry.fileEvidence = { priorDatabaseBytes: before.dbBytes, pendingDatabaseBytes: pending.dbBytes, rollbackJournalBytes: pending.journalBytes };
    await crash(session);
    page = await open();
    return verify(page, first);
  });
  await stage('acknowledged-capture-history-jobs-and-forget-commit-together', async entry => {
    const session = await withObservationDeadline(() => context.browser().newBrowserCDPSession(), 'attach before the acknowledged transaction');
    const result = await rpc(page, op('commit', { ...second, versions: [second.versions[0]], forget: ['retired'] }));
    const repliedAt = performance.now();
    assert.deepEqual(result, { committed: true });
    entry.commitAckToCrashRequestMs = await crash(session, repliedAt);
    page = await open();
    entry.afterCrash = await verify(page, second);
    await close();
    page = await open();
    return verify(page, second);
  });
  await stage('published-library-copy-is-atomic-and-preserves-the-source', async entry => {
    await close();
    profile = path.join(owned, 'upgrade-profile');
    await rm(extension, { recursive: true, force: true });
    await mkdir(extension);
    const verifiedArchive = path.join(owned, 'verified-release.zip');
    await writeFile(verifiedArchive, baselineBytes, { flag: 'wx' });
    await execFile('unzip', ['-q', verifiedArchive, '-d', extension], { timeout: 15000 });
    const oldManifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    assert.equal(oldManifest.version, '0.2.3');
    page = await open(oldManifest.options_page);
    const send = message => withObservationDeadline(() => page.evaluate(message => chrome.runtime.sendMessage(message), message), `released extension ${message.type}`);
    const paused = await send({ type: 'SET_SETTINGS', payload: { paused: true } });
    assert.equal(paused.settings?.paused, true);
    const body = 'The saved article contains café and spruce 🌲.';
    const previous = 'Earlier evidence is still useful.';
    const imported = {
      url: 'https://memory.example/article', title: 'Article captured on the previous version', manual: true, timestamp: 1700000000000,
      text: body, summary: 'Current summary.', chunks: [{ text: body, embeddingKey: 'legacy-local-model', embedding: [0.25, -0.75] }],
      versions: [{ timestamp: 1699000000000, text: previous, summary: 'Earlier summary.', chunks: [{ text: previous, embeddingKey: 'legacy-local-model', embedding: [0.1, 0.9] }] }]
    };
    assert.equal((await send({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [imported] })).imported, 1);
    const queuedUrl = 'https://memory.example/waiting';
    const queued = { url: queuedUrl, title: 'Retry needed', status: 'failed', attempts: 9, lastAttemptAt: 1700000020000,
      createdAt: 1700000020000, updatedAt: 1700000020000,
      payload: { url: queuedUrl, title: 'Retry needed', timestamp: 1700000020000, chunks: ['A saved pending capture.'], text: 'A saved pending capture.' } };
    const source = await legacyRows(page, queued);
    assert.equal(source.version, 4);
    assert.equal(source.pages.length, 1);
    for (const key of ['url', 'text', 'summary', 'chunks', 'versions']) assert.deepEqual(source.pages[0][key], imported[key], `Released fixture must meaningfully preserve ${key}`);
    assert.deepEqual(source.processing, [queued]);

    await page.close();
    const staged = path.join(owned, 'upgrade-candidate');
    await mkdir(path.join(staged, 'sqlite'), { recursive: true });
    await writeFixture(staged);
    await rename(extension, path.join(owned, 'release-files'));
    await rename(staged, extension);
    page = await reloadFixture();
    const probeManifest = await withObservationDeadline(() => page.evaluate(() => chrome.runtime.getManifest().name), 'confirm the fixture replaced the release at the same origin');
    assert.equal(probeManifest, 'Disposable SQLite recovery fixture');
    entry.upgradedHost = await rpc(page, { kind: 'host-status' });
    assert.equal(entry.upgradedHost.vfsAvailable, true, 'The updated registration must own a usable offscreen document');
    assert.match((await rpc(page, { kind: 'copy-legacy', failFirstPage: true })).error, /^Injected failure after copying evidence$/u);
    assert.deepEqual(await rpc(page, { kind: 'inspect-migration' }), { committed: false, tables: [] });
    assert.deepEqual(await legacyRows(page), source);
    assert.deepEqual(await rpc(page, { kind: 'copy-legacy' }), { migrated: { pages: 1, processing: 1 } });
    await close();
    page = await open();
    const actual = await rpc(page, { kind: 'inspect-migration' });
    assert.deepEqual(actual, { committed: true, marker: [[4, 1, 1]], pages: JSON.parse(JSON.stringify(source.pages)), processing: source.processing, integrity: ['ok'] });
    assert.deepEqual(await legacyRows(page), source);
    entry.sourceUnchanged = true;
    return { version: source.version, pages: actual.pages.length, processing: actual.processing.length, digest: fingerprint(JSON.stringify(actual)) };
  });
} catch (error) { report.error = String(error); console.error(error); }
finally {
  try { await close(); } catch (error) { report.cleanupErrors.push(String(error)); }
  if (context) report.retainedDirectory = owned;
  else if (owned) try { await rm(owned, { recursive: true, force: true }); } catch (error) { report.cleanupErrors.push(String(error)); }
  report.finishedAt = new Date().toISOString();
  report.passed = !report.error && !report.cleanupErrors.length && !report.requests.length && report.stages.length === 5 && report.stages.every(entry => entry.passed);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.info(`Report: ${reportFile}`);
  if (!report.passed) process.exitCode = 1;
}
