import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, stat, lstat, cp, open as fsOpen } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { setTimeout as delay } from 'node:timers/promises';
import { assertCapturedPage, assertRetainedPages, assertIndexedChunks, withObservationDeadline, inspectCaptureStore, requireRecoveryIdentity, durationSummary, fingerprint } from './lib/capture-qualification.mjs';
import { createRecoveryProvider } from './lib/recovery-provider.mjs';
import { qualifyBackup, qualifyModelCacheRecovery } from './lib/backup-qualification.mjs';
import { qualifySustained, sustainedFixture, SUSTAINED_PHASE, SUSTAINED_COUNT, SUSTAINED_DIMENSIONS } from './lib/sustained-capture.mjs';
import { qualifyKeyboard } from './lib/keyboard-qualification.mjs';
import { captureLevelJournals, replayClosedJournalTail } from './lib/level-journal.mjs';
import { holdSqliteCommit, inspectSqliteAuthority } from './lib/sqlite-capture-qualification.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
const sustained = args.includes('--sustained');
const keyboard = args.includes('--keyboard');
const sqliteCutover = args.includes('--sqlite-cutover');
const sqliteJournalReplay = args.includes('--sqlite-journal-replay');
const SQLITE_PROVIDER_PHASE = 'sqlite-loopback-provider-and-semantic-read';
const argument = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const restartStudy = argument('restart-study');
assert.ok(restartStudy === undefined || (!sustained && ['reuse', 'load-unpacked', 'split-profile', 'observe', 'preinstalled', 'journal'].includes(restartStudy)), 'Use --restart-study=reuse|load-unpacked|split-profile|observe|preinstalled|journal without --sustained');
const journalStudy = restartStudy === 'journal';
const largeJournalSentinel = args.includes('--large-journal-sentinel');
assert.ok(!largeJournalSentinel || journalStudy, 'Use --large-journal-sentinel only with --restart-study=journal');
const normalRelaunchTiming = !restartStudy || restartStudy === 'observe' || restartStudy === 'preinstalled' || journalStudy;
assert.ok(!keyboard || (!sustained && !restartStudy), 'Use --keyboard on its own');
assert.ok(!sqliteCutover || (!keyboard && !sustained && !restartStudy), 'Use --sqlite-cutover on its own');
assert.ok(!sqliteJournalReplay || sqliteCutover, 'Use --sqlite-journal-replay with --sqlite-cutover');
const channel = argument('browser') || 'chromium';
assert.ok(['chromium', 'chrome'].includes(channel), 'Use --browser=chromium or --browser=chrome');
const executablePath = argument('browser-executable');
const expectedBrowserVersion = argument('browser-version');
assert.ok(!executablePath || /^\d+\.\d+\.\d+\.\d+$/u.test(expectedBrowserVersion || ''), 'Supply the exact --browser-version with --browser-executable');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const candidate = path.resolve(argument('candidate') || `dist/web-recall-${manifest.version}.zip`);
const baseline = argument('baseline');
const baselineHash = argument('baseline-sha256');
assert.ok(baseline && /^[a-f0-9]{64}$/u.test(baselineHash || ''), 'Supply --baseline=<published ZIP> and --baseline-sha256=<published digest>');
let scenarios = [], recoveryScenarios = [], provenanceFiles = [], directory, extension;
const report = {
  protocol: sqliteJournalReplay ? 'packaged-sqlite-journal-replay-v1' : sqliteCutover ? 'packaged-sqlite-cutover-v1' : keyboard ? 'packaged-keyboard-recall-v2' : sustained ? 'packaged-sustained-capture-v2-sqlite' : restartStudy ? 'packaged-relaunch-diagnostic-v1' : 'packaged-capture-recovery-backup-v5-sqlite', startedAt: new Date().toISOString(), channel,
  hardware: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version },
  candidate: { path: candidate }, baseline: { path: path.resolve(baseline), sha256: baselineHash },
  provenance: {}, phases: [], openings: [], ownedDirectory: null,
  limitations: ['Disposable local profiles; no installed extension or user data is accessed.', 'Small model-free capture workflows and synthetic-provider recovery, not maximum indexing throughput or AI quality.', 'Interrupted admission holds removal of the real SQLite rollback journal in the disposable OPFS worker. This qualifies that commit boundary, not arbitrary filesystem or power-loss failures.', 'Backup uses an actual browser-managed writer through a test picker adapter; native save dialog interaction is not qualified.', 'Capture timings include browser automation overhead; searchability is confirmed after acknowledgment, not its exact first instant.']
};
if (executablePath) report.customBrowser = { executablePath: path.resolve(executablePath), expectedVersion: expectedBrowserVersion };
if (restartStudy) {
  report.restartStudy = restartStudy;
  report.limitations.push('Only the first three lifecycle phases run. The first post-relaunch response is decisive; later probes are diagnostic only.');
}
if (restartStudy || sqliteCutover) report.browserWarnings = [];
if (restartStudy === 'split-profile') report.limitations.push('Both branches start from the same closed synthetic profile bytes, but use different profile paths. The original takes the duplicate load first; the copy takes ordinary restart. Copying and observing files can change timing.');
if (restartStudy === 'observe') report.limitations.push('Preserves the original diagnostic launch procedure, without the setup reload used in current qualification. Browser diagnostics are read after the first result.');
if (restartStudy === 'preinstalled') report.limitations.push('Installation gets one orderly close and reopen before capture. Both subsequent relaunches must reuse the enabled registration; a missing registration is distinct from a storage failure.');
if (journalStudy) report.limitations.push('Read physical LevelDB journal fragments and manifest checksums from the closed disposable profile before either relaunch. Snapshots add timing overhead and omit payloads, table files and logical-record decoding; an unreadable snapshot is not evidence of a clean file.');
if (largeJournalSentinel) report.limitations.push('The last acknowledged page is a larger authored article. This exercises more journal blocks, not the original failure workload or a production-sized library.');
if (sustained) report.limitations.push('Sustained workload uses synthetic embeddings and summaries on loopback, with a scripted 120 ms embedding delay. Heap observations exclude provider/source/offscreen/OS memory; they are not a universal capacity bound.');
if (keyboard) report.limitations = ['Only disposable profiles and owned loopback content are used.', 'Tests DOM keyboard navigation in the packaged panel document, not Chrome chrome-level shortcuts, browser assistive technology or observed users. Automation selects tabs so the source is active during capture.', 'Model dispatches are audited in the background worker after guard attachment, before the first keyboard action. The SQLite storage worker remains available.'];
if (sqliteCutover) report.limitations = ['Uses the exact release and candidate archives in disposable profiles. Browser reload uses the unpacked Extensions workflow, not a Chrome Web Store update.',
  'The crash phase injects scoped IndexedDB removal, not whole-origin loss.',
  ...(sqliteJournalReplay ? ['The separate physical fault phase synthesizes the original torn-header/append checksum failure in a closed profile; it does not reproduce the original crash timing or prove a Chrome bug across all versions.'] : [])];
if (!restartStudy) report.limitations.push('Each initial unpacked installation must open an empty library. Chrome’s extension manager then reloads the same ID once and the owned browser is closed and reopened before fixture records are written. Later restart checks never reload or reinstall; a missing registration is not a saved-library result.');
const reportDirectory = path.join(root, 'output/qualification');
await mkdir(reportDirectory, { recursive: true });
const reportFile = path.resolve(argument('report') || path.join(reportDirectory, `${report.startedAt.replace(/[:.]/gu, '-')}-${channel}.json`));
await writeFile(reportFile, '', { flag: 'wx' });
const fixtures = new Map();
const journalSentinelParagraphs = largeJournalSentinel ? Array.from({ length: 192 }, (_, index) => `Field observation ${index + 1}: The bright object crossed a narrow strip of sky before dawn. Two observers compared notes and checked their estimates against the field clock.`) : [];
const provider = createRecoveryProvider(phase => phase === SUSTAINED_PHASE ? { embeddingDelayMs: 120, contextLength: 131072, dimensions: SUSTAINED_DIMENSIONS } : {});
const network = [], networkFailures = [], assetFailures = [];
let context, extensionId, serverOrigin, closing = false;
const sockets = new Set();
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://local.test').pathname;
  if (pathname.startsWith('/api/')) {
    void provider.handle(request, response, report.phases.at(-1)?.name);
    return;
  }
  const [kind, key] = pathname.split('/').slice(1);
  const index = Number(key);
  let body = sustained && kind === 'sustained' && /^\d+$/u.test(key || '') && index >= 0 && index < SUSTAINED_COUNT ? sustainedFixture(index).html : fixtures.get(kind);
  if (largeJournalSentinel && kind === 'article' && key === 'fresh-crash-sentinel') {
    const end = body.lastIndexOf('</article>');
    body = body.slice(0, end) + journalSentinelParagraphs.map(paragraph => `<p>${paragraph}</p>`).join('\n') + body.slice(end);
  }
  response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body || 'No qualification page here');
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

async function unpack(filename) {
  const entries = execFileSync('unzip', ['-Z1', filename], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.every(entry => !entry.startsWith('/') && !entry.includes('\\') && !entry.split('/').includes('..') && (entry === 'manifest.json' || entry.startsWith('dist/beta/'))), 'Package must contain only safe manifest/runtime paths');
  await rm(extension, { recursive: true, force: true });
  execFileSync('unzip', ['-q', filename, '-d', extension]);
  return JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
}

async function rpc(page, message) {
  const response = await page.evaluate(message => chrome.runtime.sendMessage(message), message);
  assert.ok(response && !response.error, `${message.type}: ${response?.error || 'No response'}`);
  return response;
}

async function open(profile, packaged, { reuseInstalled = true, requireInstalled = false, observeOffscreen = false } = {}) {
  closing = false;
  context = await chromium.launchPersistentContext(profile, { channel, executablePath: report.customBrowser?.executablePath, headless: true, timeout: 20000, viewport: { width: 420, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ...(observeOffscreen ? ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] : [])] });
  context.on('request', request => { if (/^https?:/u.test(request.url())) network.push({ url: request.url(), serviceWorker: Boolean(request.serviceWorker()), method: request.method(), phase: report.phases.at(-1)?.name, at: new Date().toISOString() }); });
  context.on('response', response => { if (response.url().startsWith('chrome-extension:') && response.status() >= 400) assetFailures.push({ url: response.url(), status: response.status() }); });
  context.on('requestfailed', request => {
    if (/^https?:/u.test(request.url())) networkFailures.push({ url: request.url(), method: request.method(), phase: report.phases.at(-1)?.name, error: request.failure()?.errorText, body: request.url() === `${serverOrigin}/api/embed` ? request.postData() : undefined });
    if (request.url().startsWith('chrome-extension:') && !(closing && request.failure()?.errorText === 'net::ERR_ABORTED')) assetFailures.push({ url: request.url(), error: request.failure()?.errorText });
  });
  if (report.browserWarnings) context.on('console', message => {
    const url = message.location().url;
    if (report.browserWarnings.length < 40 && url?.startsWith('chrome-extension:') && ['warning', 'error'].includes(message.type())) {
      report.browserWarnings.push({ phase: report.phases.at(-1)?.name, type: message.type(), url, text: message.text().slice(0, 500) });
    }
  });
  await context.route(/^https?:/u, route => new URL(route.request().url()).origin === serverOrigin ? route.continue() : route.abort());
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  const label = { name: 'Developer mode', exact: true };
  const developerMode = manager.getByRole('switch', label).or(manager.getByRole('button', label));
  if (!(await developerMode.evaluate(node => node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-pressed') === 'true'))) {
    assert.ok(!requireInstalled, 'Developer mode did not survive the restart of the owned test profile');
    await developerMode.click();
  }
  await manager.getByRole('switch', { ...label, checked: true }).or(manager.getByRole('button', { ...label, pressed: true })).waitFor();
  let prior;
  if (extensionId) {
    prior = await withObservationDeadline(() => manager.evaluate(async id => {
      const entries = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
      const installed = entries.find(entry => entry.id === id);
      return installed && { version: installed.version, state: installed.state, location: installed.location };
    }, extensionId), 'read existing extension registration');
  }
  let registration = 'load-unpacked';
  const matches = prior?.state === 'ENABLED' && prior.version === packaged.version && prior.location === 'UNPACKED';
  if (reuseInstalled && prior) registration = matches ? 'reused' : 'refused';
  if (requireInstalled && !matches) registration = 'refused';
  const opening = { profile: path.basename(profile), phase: report.phases.at(-1)?.name, loadedBeforeInstall: prior ?? null, registration };
  report.openings.push(opening);
  try {
    assert.notEqual(registration, 'refused', 'Browser relaunch did not find the expected enabled extension; do not replace it to qualify storage');
    if (registration === 'load-unpacked') {
      const protocol = await context.browser().newBrowserCDPSession();
      const installed = await protocol.send('Extensions.loadUnpacked', { path: extension });
      if (extensionId) assert.equal(installed.id, extensionId, 'Restart/upgrade must retain the extension origin');
      extensionId = installed.id;
      if (!restartStudy) {
        const setupPage = await openUi(packaged);
        try {
          const reply = await withObservationDeadline(() => rpc(setupPage, { type: 'GET_PAGE_LIST' }), 'read the clean library after installation');
          assert.deepEqual(reply.pages, [], 'The first install must open an empty library before its setup reload');
        } finally { await setupPage.close(); }
        opening.setupReload = await reloadInstalledRegistration(manager, packaged.version, packaged.version);
      }
    }
  } finally { await manager.close(); }
  if (opening.setupReload) {
    await close();
    return open(profile, packaged, { requireInstalled: true, observeOffscreen });
  }
  return openUi(packaged);
}

async function openUi(packaged) {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(`chrome-extension://${extensionId}/${packaged.options_page}`);
  const count = page.locator('#manage-count').filter({ hasText: /^\d+ pages?$/u });
  const failure = page.locator('#manage-status.danger').filter({ hasText: /^Failed to load pages:/u });
  try { await count.or(failure).first().waitFor(); }
  catch (error) {
    const checkpoint = report.phases.at(-1) ?? report.openings.at(-1);
    checkpoint.manageStartup = await withObservationDeadline(() => page.evaluate(async () => ({
      count: document.querySelector('#manage-count')?.textContent,
      status: document.querySelector('#manage-status')?.textContent,
      authority: (await chrome.storage.local.get('savedLibraryAuthority')).savedLibraryAuthority,
      contexts: (await chrome.runtime.getContexts({})).map(context => context.contextType)
    })), 'read disposable Memory Manager startup status', 2000).catch(() => null);
    throw error;
  }
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), packaged.version);
  assert.ok(Number(context.browser().version().split('.')[0]) >= Number(packaged.minimum_chrome_version), 'Browser must satisfy the package minimum');
  report.browser = context.browser().version();
  if (expectedBrowserVersion) assert.equal(report.browser, expectedBrowserVersion, 'The isolated test must run the requested exact browser version');
  assert.equal(await page.evaluate(() => chrome.permissions.contains({ permissions: ['nativeMessaging'] })), false, 'No helper permission may be granted in the isolated no-model profile');
  return page;
}

async function reloadUnpacked(page, packaged) {
  await page.evaluate(() => chrome.runtime.reload()).catch(error => {
    if (!/Execution context was destroyed|Target page, context or browser has been closed/u.test(String(error))) throw error;
  });
  const manager = await context.newPage();
  try {
    await manager.goto('chrome://extensions/');
    const card = manager.locator(`extensions-item[id=${JSON.stringify(extensionId)}]`);
    const installed = await until(async () => {
      const state = await card.evaluate(node => ({ id: node.id, version: node.data?.version, enabled: node.data?.state === 'ENABLED' }), undefined, { timeout: 10000 });
      return state.enabled && state.version === packaged.version ? state : null;
    }, 'the Chrome extension card to show the enabled candidate version after reload');
    report.phases.at(-1).reloadConfirmation = installed;
  } finally { await manager.close(); }
  return openUi(packaged);
}

async function reloadInstalledRegistration(manager, previousVersion, expectedVersion) {
  const registration = await withObservationDeadline(() => manager.evaluate(async ({ id, previousVersion }) => {
    const options = { includeDisabled: true, includeTerminated: true };
    const before = (await chrome.developerPrivate.getExtensionsInfo(options)).find(entry => entry.id === id);
    if (before?.version !== previousVersion || before.state !== 'ENABLED' || before.location !== 'UNPACKED') throw Error('Expected the enabled unpacked extension before reloading');
    const failure = await chrome.developerPrivate.reload(id, { failQuietly: true, populateErrorForUnpacked: true });
    if (failure) throw Error(failure.error || 'The owned unpacked extension did not reload');
    const after = (await chrome.developerPrivate.getExtensionsInfo(options)).find(entry => entry.id === id);
    return { id: after?.id, version: after?.version, state: after?.state, location: after?.location };
  }, { id: extensionId, previousVersion }), 'reload the owned unpacked registration and await completion');
  assert.deepEqual(registration, { id: extensionId, version: expectedVersion, state: 'ENABLED', location: 'UNPACKED' });
  return registration;
}

async function reloadCutover(previousVersion, candidateManifest) {
  const manager = await context.newPage();
  try {
    await manager.goto('chrome://extensions/', { timeout: 12000 });
    await reloadInstalledRegistration(manager, previousVersion, candidateManifest.version);
  } finally { await manager.close(); }
  return openUi(candidateManifest);
}

async function close() {
  if (!context) return;
  closing = true;
  const browser = context.browser();
  await context.close();
  assert.equal(browser?.isConnected(), false, 'The disposable browser must be closed before reusing or removing its profile');
  context = undefined;
}

async function crash() {
  closing = true;
  const browser = context.browser(), protocol = await browser.newBrowserCDPSession();
  const disconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned browser did not crash')), 15000);
    browser.once('disconnected', () => { clearTimeout(timer); resolve(); });
  });
  const requestedAt = performance.now();
  await Promise.all([protocol.send('Browser.crash').catch(() => {}), disconnected]);
  assert.equal(browser.isConnected(), false, 'A recovery run requires authoritative process termination');
  await context.close().catch(() => {}); context = undefined;
  return { requestedAt, disconnectedAt: performance.now() };
}

async function pages(page) { return (await rpc(page, { type: 'GET_ALL_PAGES' })).pages; }

async function storageEvidence(page) {
  if (!restartStudy) return { backend: 'sqlite-opfs', ...(await inspectSqliteAuthority(page)) };
  return withObservationDeadline(() => page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const storageKeys = Object.keys(await chrome.storage.local.get(null)).sort();
    const database = databases.find(entry => entry.name === 'webRecallBeta');
    const counts = {};
    if (database) await new Promise((resolve, reject) => {
      const request = indexedDB.open(database.name);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const stores = ['pages', 'pageText', 'processing'].filter(name => db.objectStoreNames.contains(name));
        if (!stores.length) { db.close(); resolve(); return; }
        const transaction = db.transaction(stores);
        for (const name of stores) {
          const count = transaction.objectStore(name).count();
          count.onsuccess = () => { counts[name] = count.result; };
        }
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
    return { origin: location.origin, databases, storageKeys, counts };
  }), 'read database and settings counts');
}

async function profileStorageEvidence(profile, digest = false) {
  const entries = {};
  for (const store of ['IndexedDB', 'Local Extension Settings']) {
    const root = path.join(profile, 'Default', store);
    const folders = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    entries[store] = {};
    for (const folder of folders.filter(entry => entry.isDirectory() && entry.name.includes(extensionId))) {
      const directory = path.join(root, folder.name);
      const files = (await readdir(directory, { withFileTypes: true, recursive: true })).filter(entry => entry.isFile());
      entries[store][folder.name] = Object.fromEntries(await Promise.all(files.map(async file => {
        const filename = path.join(file.parentPath, file.name);
        const size = (await stat(filename)).size;
        return [path.relative(directory, filename), digest ? { size, sha256: fingerprint(await readFile(filename)) } : size];
      })));
    }
  }
  if (digest) {
    entries.preferences = {};
    for (const file of ['Local State', 'Default/Preferences', 'Default/Secure Preferences']) {
      const filename = path.join(profile, file);
      const metadata = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (metadata?.isFile()) entries.preferences[file] = fingerprint(await readFile(filename));
    }
  }
  return entries;
}

function observeBacking(label, read) {
  return withObservationDeadline(read, label, 2000).catch(error => ({ observationError: String(error) }));
}

async function restartBackingEvidence(profile) {
  const snapshot = await observeBacking('read profile file sizes', () => profileStorageEvidence(profile));
  if (snapshot.observationError) return snapshot;
  const files = snapshot.IndexedDB;
  const logs = await Promise.all(Object.keys(files).map(async folder => {
    const directory = path.join(profile, 'Default', 'IndexedDB', folder);
    const entries = await Promise.all(['LOG', 'LOG.old'].filter(name => Object.hasOwn(files[folder], name)).map(async name => {
      const tail = await observeBacking(`read IndexedDB ${name} tail`, async () => {
        const handle = await fsOpen(path.join(directory, name), 'r');
        try {
          const { size } = await handle.stat();
          const buffer = Buffer.alloc(2048);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
          return buffer.toString('utf8', 0, bytesRead);
        } finally { await handle.close(); }
      });
      return [name, tail];
    }));
    return [folder, Object.fromEntries(entries)];
  }));
  return { files, logs: Object.fromEntries(logs) };
}

function browserStorageHistograms() {
  return observeBacking('read browser storage histograms', async () => {
    const session = await context.browser().newBrowserCDPSession();
    try {
      const groups = await Promise.all(['IndexedDB', 'Quota'].map(query => session.send('Browser.getHistograms', { query })));
      return groups.flatMap(group => group.histograms).filter(histogram => histogram.count > 0 && /Open|Corrupt|DataLoss|Delete|BackingStore|Evict/u.test(histogram.name));
    } finally { await session.detach(); }
  });
}

async function levelCanary(page, seed = false) {
  return withObservationDeadline(() => page.evaluate(async seed => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open('web-recall-qualification-journal-canary', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('proof');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = seed ? database.transaction('proof', 'readwrite', { durability: 'strict' }) : database.transaction('proof');
        const store = transaction.objectStore('proof');
        const request = seed ? store.put('persisted before fault', 'proof') : store.get('proof');
        transaction.oncomplete = () => resolve(seed || request.result === 'persisted before fault');
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, seed), 'read the disposable IndexedDB canary');
}

async function replayAndCheck(profile, packaged, entry) {
  const browser = context.browser();
  await close();
  assert.equal(browser.isConnected(), false, 'Do not edit any journal while the disposable browser is running');
  entry.replay = await replayClosedJournalTail(directory, profile, extensionId);
  const page = await open(profile, packaged, { requireInstalled: true });
  assert.equal(await levelCanary(page), false, 'Chrome must encounter the injected IndexedDB failure, not ignore a stale journal');
  entry.histograms = await browserStorageHistograms();
  const corruptions = Array.isArray(entry.histograms) ? entry.histograms.find(histogram => histogram.name === 'WebCore.IndexedDB.LevelDBOpenErrors.Corruption')?.buckets : undefined;
  assert.ok(corruptions?.some(bucket => bucket.low === 27 && bucket.count > 0), 'Chrome must independently report the checksum-mismatch code (27)');
  return page;
}

async function verifyRelaunch(profile, packaged, reuseInstalled, acknowledged, entry) {
  const relaunchAt = performance.now();
  const page = await open(profile, packaged, { reuseInstalled, requireInstalled: !restartStudy || (restartStudy !== 'observe' && !journalStudy) });
  entry.registration = report.openings.at(-1).registration;
  let restored;
  let exportError;
  try {
    restored = await withObservationDeadline(() => pages(page), 'read the first export after browser relaunch');
    entry.firstExportCount = restored.length;
  } catch (error) {
    exportError = error;
    entry.firstExportError = String(error);
  } finally { entry.relaunchToFirstExportMs = performance.now() - relaunchAt; }
  let storageError;
  try { entry.storageAfterRestart = await storageEvidence(page); }
  catch (error) { storageError = error; entry.storageAfterRestartError = String(error); }
  const backingMatches = restartStudy
    ? entry.storageAfterRestart?.counts.pages === acknowledged.length && entry.storageAfterRestart?.counts.pageText === acknowledged.length
    : entry.storageAfterRestart?.id === entry.storageBeforeClose?.id && entry.storageAfterRestart?.pages === acknowledged.length;
  const lostRecords = restored?.length !== acknowledged.length || !backingMatches;
  if (lostRecords) {
    entry.backingAfterFailedRelaunch = await restartBackingEvidence(profile);
  }
  if (lostRecords || restartStudy === 'observe' || restartStudy === 'preinstalled' || journalStudy) entry.browserStorageHistograms = await browserStorageHistograms();
  if (restartStudy) {
    entry.displayedCountAfterStorageProbe = await page.locator('#manage-count').textContent();
    entry.displayedStatusAfterStorageProbe = await page.locator('#manage-status').textContent();
    if (restored?.length !== acknowledged.length) {
      const diagnostic = await Promise.allSettled([
        withObservationDeadline(() => rpc(page, { type: 'GET_PAGE_LIST' }), 'read independent memory list'),
        withObservationDeadline(() => pages(page), 'read diagnostic export')
      ]);
      entry.diagnosticCounts = diagnostic.map((result, index) => result.status === 'fulfilled' ? (index === 0 ? result.value.pages.length : result.value.length) : String(result.reason));
    }
  }
  if (exportError) throw exportError;
  assertRetainedPages(acknowledged, restored);
  if (storageError) throw storageError;
  assert.ok(backingMatches, 'Post-relaunch authority must retain the same library and every acknowledged page');
  if (!restartStudy) {
    const sentinel = acknowledged.find(record => record.url.endsWith('/article/fresh-crash-sentinel'));
    const scenario = scenarios.find(scenario => scenario.kind === 'article');
    assert.ok(sentinel && scenario);
    const result = await rpc(page, { type: 'SEARCH_QUERY', query: '"' + scenario.phrase + '"', requestId: crypto.randomUUID(), limit: 50 });
    assert.ok(result.results.some(hit => hit.url === sentinel.url && hit.versionId === sentinel.versionId), 'Reopened text search must find the acknowledged version');
  }
  if (entry.registration !== 'reused') report.limitations.push('A browser relaunch that loads the unpacked extension again does not verify an ordinary restart.');
  return { retained: acknowledged.length, ordinaryRestartVerified: entry.registration === 'reused' };
}

async function until(check, label) {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw Error(`Qualification observation did not complete: ${label}`);
}

async function processing(page, url) { return (await inspectSqliteAuthority(page, { op: 'job', url })) ?? undefined; }

function recoveryPayload(name) {
  const scenario = recoveryScenarios.find(scenario => scenario.name === name);
  assert.ok(scenario, `Missing authored recovery fixture: ${name}`);
  return { url: `${serverOrigin}/article/${name}`, title: scenario.title, text: scenario.text, chunks: scenario.chunks, timestamp: Date.now(), manual: true };
}

async function savedCapture(page, expected) {
  const saved = (await pages(page)).find(record => record.url === expected.url);
  assert.ok(saved, `Acknowledged saved text is missing: ${expected.url}`);
  for (const field of ['url', 'title', 'text', 'timestamp', 'manual']) assert.equal(saved[field], expected[field], `Recovered ${field} changed`);
  assert.equal((saved.versions || []).length, 0, 'Indexing must not create duplicate saved versions');
  requireRecoveryIdentity(saved.versionId, 'Saved version ID');
  assert.deepEqual(saved.chunks.map(chunk => chunk.text), expected.chunks);
  return saved;
}

function embeddingRequests(payload) {
  return provider.requests.filter(request => request.path === '/api/embed' && request.body?.input?.includes(payload.chunks[0]));
}

async function searchable(page, payload, expected = true) {
  const scenario = recoveryScenarios.find(scenario => scenario.title === payload.title);
  const result = await rpc(page, { type: 'SEARCH_QUERY', query: `"${scenario.phrase}"`, requestId: crypto.randomUUID() });
  assert.equal(result.results.some(result => result.url === payload.url), expected, 'Text search must reflect the saved or deleted capture independently of indexing');
}

async function indexedCapture(page, payload, admitted) {
  await until(async () => !(await processing(page, payload.url)), 'indexing job removal');
  const saved = await savedCapture(page, payload);
  requireRecoveryIdentity(admitted.versionId, 'Acknowledged version ID');
  assert.equal(saved.versionId, admitted.versionId, 'Re-indexing must preserve the acknowledged saved version');
  assert.ok(Number.isFinite(saved.lastEmbeddedAt), 'Completed indexing must record its completion time');
  const scenario = recoveryScenarios.find(scenario => scenario.title === payload.title);
  assertIndexedChunks(saved.chunks, payload.chunks, scenario.expectedVectors, JSON.stringify(['ollama', serverOrigin, 'qualification-vector']));
  for (const request of embeddingRequests(payload)) assert.deepEqual(request.body.input, payload.chunks, 'The provider must receive every actual saved section, not substituted text');
  await searchable(page, payload);
  return { url: payload.url, versionId: saved.versionId, chunks: saved.chunks.length };
}

async function phase(name, run) {
  const entry = { name, startedAt: new Date().toISOString() }; report.phases.push(entry);
  try { Object.assign(entry, await run(entry), { passed: true }); }
  catch (error) { entry.passed = false; entry.error = String(error); throw error; }
  finally { entry.finishedAt = new Date().toISOString(); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n'); }
  console.info(`${name}: passed`);
}

try {
  const candidateBytes = await readFile(candidate), baselineBytes = await readFile(baseline);
  report.candidate.sha256 = fingerprint(candidateBytes);
  assert.equal(fingerprint(baselineBytes), baselineHash, 'Baseline must match its independently obtained published checksum');
  scenarios = JSON.parse(await readFile('tests/fixtures/capture-qualification.json', 'utf8'));
  recoveryScenarios = JSON.parse(await readFile('tests/fixtures/recovery-qualification.json', 'utf8'));
  const sourceFiles = (await readdir('src', { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.relative(root, path.resolve(entry.parentPath, entry.name))).sort();
  provenanceFiles = [...sourceFiles, 'manifest.json', 'package.json', 'pnpm-lock.yaml', 'scripts/qualify-capture.mjs', 'scripts/lib/capture-qualification.mjs', 'scripts/lib/recovery-provider.mjs', 'scripts/lib/backup-qualification.mjs', 'tests/fixtures/capture-qualification.json', 'tests/fixtures/recovery-qualification.json', ...scenarios.map(scenario => `tests/fixtures/extraction/${scenario.kind}.html`)];
  if (keyboard) provenanceFiles.push('scripts/lib/keyboard-qualification.mjs', 'scripts/lib/recall-observer.mjs');
  if (!restartStudy && !sqliteCutover) {
    provenanceFiles.push('scripts/lib/sqlite-capture-qualification.mjs', 'scripts/lib/recall-cdp.mjs');
    if (sustained) provenanceFiles.push('scripts/lib/sustained-capture.mjs');
  }
  if (journalStudy || sqliteJournalReplay) provenanceFiles.push('scripts/lib/level-journal.mjs');
  report.provenance = Object.fromEntries(await Promise.all(provenanceFiles.map(async file => [file, fingerprint(await readFile(file))])));
  report.sourceDigest = fingerprint(JSON.stringify(report.provenance));
  for (const scenario of scenarios) fixtures.set(scenario.kind, await readFile(`tests/fixtures/extraction/${scenario.kind}.html`, 'utf8'));
  directory = await mkdtemp(path.join(tmpdir(), 'web-recall-capture-qualification-'));
  report.ownedDirectory = directory;
  extension = path.join(directory, 'extension');
  const stagedCandidate = path.join(directory, 'candidate.zip'), stagedBaseline = path.join(directory, 'baseline.zip');
  await writeFile(stagedCandidate, candidateBytes, { flag: 'wx' });
  await writeFile(stagedBaseline, baselineBytes, { flag: 'wx' });
  const packaged = await unpack(stagedCandidate);
  assert.equal(packaged.version, manifest.version, 'Qualify the current built version');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  serverOrigin = `http://127.0.0.1:${server.address().port}`;
  const openPanel = async () => {
    const panel = await context.newPage();
    panel.setDefaultTimeout(15000);
    await panel.goto(`chrome-extension://${extensionId}/${packaged.side_panel.default_path}`);
    await panel.locator('#beta-search-input').waitFor();
    return panel;
  };
  if (sqliteCutover) {
    const profile = path.join(directory, 'sqlite-cutover');
    let page, savedBefore;
    const address = 'https://migration.qualification.test/saved#chapter';
    const known = [{ url: address, title: 'Earlier field notes', text: 'The kayaker visited three coves at low tide.', timestamp: 1609459200000, manual: true,
      summary: 'Coastal field observations.', chunks: [{ text: 'The kayaker visited three coves at low tide.', embedding: [0.25, 0.75], embeddingKey: 'qualification-legacy-space' }],
      versions: [{ text: 'Early observations covered only the inlet.', timestamp: 1609450000000, summary: 'Earlier inlet observations.', chunks: [] }] }];
    if (sqliteJournalReplay) await phase('journal-replay-published-indexeddb-control', async entry => {
      const previous = await unpack(stagedBaseline);
      assert.equal(previous.version, '0.2.3');
      const control = path.join(directory, 'leveldb-control');
      let controlPage = await open(control, previous);
      await rpc(controlPage, { type: 'SET_SETTINGS', payload: { paused: true } });
      assert.equal((await rpc(controlPage, { type: 'IMPORT_PAGES', schemaVersion: 1, pages: known })).imported, 1);
      assertRetainedPages(known, await pages(controlPage));
      assert.equal(await levelCanary(controlPage, true), true);
      assert.equal(await levelCanary(controlPage), true);
      controlPage = await replayAndCheck(control, previous, entry);
      assert.deepEqual(await pages(controlPage), [], 'The published IndexedDB authority must exhibit acknowledged page loss under the matched fault');
      await close();
      return { acknowledgedBefore: 1, afterCorruption: 0, canaryLost: true };
    });
    await phase('published-release-to-active-sqlite', async () => {
      const previous = await unpack(stagedBaseline);
      assert.equal(previous.version, '0.2.3');
      page = await open(profile, previous);
      await rpc(page, { type: 'SET_SETTINGS', payload: { paused: true } });
      assert.equal((await rpc(page, { type: 'IMPORT_PAGES', schemaVersion: 1, pages: known })).imported, 1);
      savedBefore = await pages(page);
      assertRetainedPages(known, savedBefore);
      await page.close();
      const candidateManifest = await unpack(stagedCandidate);
      page = await reloadCutover(previous.version, candidateManifest);
      await rpc(page, { type: 'SET_SETTINGS', payload: { automaticAi: false, queryRewrite: false, searchRerank: false } });
      assertRetainedPages(savedBefore, await pages(page));
      const state = await page.evaluate(async () => (await chrome.storage.local.get('savedLibraryAuthority')).savedLibraryAuthority);
      assert.equal(state?.phase, 'active');
      assert.equal(state?.retired, true);
      const retiredPages = await inspectCaptureStore(page, 'pages', { count: true });
      assert.equal(retiredPages, 0, 'There must not be an independently readable IndexedDB copy after activation');
      const result = await rpc(page, { type: 'SEARCH_QUERY', query: '"three coves"', requestId: 'sqlite-upgrade' });
      assert.ok(result.results.some(entry => entry.url === address));
      return { retained: savedBefore.length, retainedVersions: savedBefore[0].versions.length, retired: state.retired, sourceVersion: previous.version };
    });
    await phase('active-sqlite-survives-indexeddb-loss-and-forced-relaunch', async entry => {
      await close();
      page = await open(profile, packaged, { requireInstalled: true });
      const origin = await page.evaluate(() => location.origin);
      assert.equal(origin, `chrome-extension://${extensionId}`);
      const session = await context.newCDPSession(page);
      try { await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' }); }
      finally { await session.detach(); }
      await until(() => page.evaluate(async () => !(await indexedDB.databases()).some(database => database.name === 'webRecallBeta')), 'browser IndexedDB removal');
      assertRetainedPages(savedBefore, await pages(page));
      const source = await context.newPage();
      const article = scenarios.find(scenario => scenario.kind === 'article');
      const url = `${serverOrigin}/${article.kind}/sqlite-crash-sentinel`;
      await source.goto(url); await source.bringToFront();
      const acknowledgement = await rpc(page, { type: 'CAPTURE_ACTIVE_TAB' });
      const acknowledgedAt = performance.now();
      assert.equal(acknowledgement.received, true);
      await crash();
      entry.ackToCrashAndDisconnectMs = performance.now() - acknowledgedAt;
      page = await open(profile, packaged, { requireInstalled: true });
      const afterCrash = await pages(page);
      const sentinel = afterCrash.find(record => record.url === url);
      assertCapturedPage(sentinel, article, url);
      assertRetainedPages(savedBefore, afterCrash.filter(record => record.url !== url));
      await close();
      page = await open(profile, packaged, { requireInstalled: true });
      assertRetainedPages(afterCrash, await pages(page));
      return { afterCrash: afterCrash.length, orderlyRelaunch: afterCrash.length };
    });
    await phase(SQLITE_PROVIDER_PHASE, async () => {
      await rpc(page, { type: 'SET_EMBEDDING_CONFIG', payload: { provider: 'ollama', baseUrl: serverOrigin, model: 'qualification-vector' } });
      await rpc(page, { type: 'SET_PROVIDER_SETTING', providerId: 'ollama', key: 'baseUrl', value: serverOrigin });
      await rpc(page, { type: 'SET_MODEL', key: 'chatModel', value: 'qualification-chat' });
      await rpc(page, { type: 'SET_SETTINGS', payload: { paused: true, automaticAi: true, activeProviderId: 'ollama', queryRewrite: false, searchRerank: false } });
      const payload = recoveryPayload('interrupted-indexing');
      assert.equal((await rpc(page, { type: 'SAVE_PAGE', ...payload })).status, 'queued');
      const indexed = await until(async () => {
        const saved = (await pages(page)).find(record => record.url === payload.url);
        return saved?.chunks.every(chunk => chunk.embedding.length) && saved;
      }, 'confirmed vectors in the active authority');
      assertIndexedChunks(indexed.chunks, payload.chunks, [[1, 2], [2, 3]], JSON.stringify(['ollama', serverOrigin, 'qualification-vector']));
      const phrase = 'estuarine marshland';
      assert.ok(!indexed.text.includes(phrase));
      const result = await rpc(page, { type: 'SEARCH_QUERY', query: phrase, requestId: 'sqlite-semantic-match' });
      const hit = result.results.find(record => record.url === payload.url);
      assert.ok(hit?.score > 0 && !hit.containsExact, 'The result must come from stored vectors, not a literal match');
      assert.equal((await rpc(page, { type: 'DELETE_PAGE', url: payload.url })).deleted, 1);
      const after = await rpc(page, { type: 'SEARCH_QUERY', query: phrase, requestId: 'sqlite-semantic-after-forget' });
      assert.ok(!after.results.some(record => record.url === payload.url), 'Semantic search must not return deleted evidence');
      await rpc(page, { type: 'SET_SETTINGS', payload: { automaticAi: false } });
      return { embeddedChunks: indexed.chunks.length, semanticResult: true, deletedResultAbsent: true };
    });
    if (sqliteJournalReplay) await phase('journal-replay-retains-sqlite-evidence', async entry => {
      const expected = await pages(page);
      assert.equal(expected.length, 2, 'Verify only the upgraded library and the acknowledged crash sentinel; forgotten evidence must stay absent');
      assertRetainedPages(savedBefore, expected.filter(record => record.url === address));
      assert.equal(await levelCanary(page, true), true);
      assert.equal(await levelCanary(page), true);
      page = await replayAndCheck(profile, packaged, entry);
      assertRetainedPages(expected, await pages(page));
      const result = await rpc(page, { type: 'SEARCH_QUERY', query: '"covered only the inlet"', requestId: 'replayed-history' });
      assert.ok(result.results.some(record => record.url === address && record.timestamp === 1609450000000), 'Earlier retained evidence must remain searchable');
      await close();
      page = await open(profile, packaged, { requireInstalled: true });
      assertRetainedPages(expected, await pages(page));
      return { acknowledgedBefore: expected.length, afterCorruption: expected.length, canaryLost: true, historicalSearch: true, laterRelaunchRetained: true };
    });
  } else if (keyboard) {
    await phase('keyboard-only-first-save-find-and-read', async entry => qualifyKeyboard({
      openPanel, optionsPage: await open(path.join(directory, 'keyboard'), packaged),
      scenario: scenarios.find(scenario => scenario.kind === 'article'), origin: serverOrigin, rpc, entry
    }));
  } else if (sustained) {
    await phase(SUSTAINED_PHASE, entry => qualifySustained({ open: (profile, options) => open(profile, packaged, options), openPanel, crash, directory, origin: serverOrigin, rpc, provider, entry }));
  } else {
  const profile = path.join(directory, 'fresh');
  let page = await open(profile, packaged), acknowledged, journalAfterCrash;
  if (restartStudy === 'preinstalled') {
    await close();
    page = await open(profile, packaged, { requireInstalled: true });
  }
  await phase('fresh-package-capture-search-read', async () => {
    const settings = (await rpc(page, { type: 'GET_SETTINGS' })).settings;
    assert.equal(settings.paused, true); assert.equal(settings.automaticAi, false);
    assert.deepEqual(await pages(page), []);
    const source = await context.newPage(), samples = [], started = performance.now();
    for (let round = 0; round < 6; round++) for (const scenario of scenarios) {
      const url = `${serverOrigin}/${scenario.kind}/${round}`;
      await source.goto(url); await source.bringToFront();
      const start = performance.now();
      const capture = await rpc(page, { type: 'CAPTURE_ACTIVE_TAB' });
      const acknowledgedMs = performance.now() - start;
      assert.equal(capture.ok, true); assert.equal(capture.received, true);
      const query = `"${scenario.phrase}"`;
      const result = await rpc(page, { type: 'SEARCH_QUERY', query, requestId: `capture-${scenario.kind}-${round}` });
      const confirmedSearchableMs = performance.now() - start;
      const found = result.results.find(result => result.url === url);
      assert.ok(found, `${scenario.kind}: acknowledged text must be immediately searchable without vectors`);
      const saved = (await rpc(page, { type: 'GET_SAVED_PAGE', url, versionId: found.versionId, query })).page;
      assertCapturedPage(saved, scenario, url);
      samples.push({ url, kind: scenario.kind, acknowledgedMs, confirmedSearchableMs, textBytes: Buffer.byteLength(saved.text), versionId: saved.versionId });
    }
    await source.goto('about:blank'); await source.close();
    acknowledged = await pages(page);
    assert.equal(acknowledged.length, samples.length);
    assert.ok(acknowledged.every(record => record.chunks.every(chunk => !chunk.embedding.length)));
    await page.waitForFunction(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'GET_PROCESSING' });
      if (response.error) throw Error(response.error);
      return response.queue.length === 0;
    }, undefined, { timeout: 15000 });
    const panel = await context.newPage(); panel.setDefaultTimeout(15000);
    await panel.goto(`chrome-extension://${extensionId}/${packaged.side_panel.default_path}`);
    for (const scenario of scenarios) {
      const sample = samples.find(sample => sample.kind === scenario.kind);
      await panel.locator('#beta-search-input').fill(`"${scenario.phrase}"`); await panel.locator('#beta-search-input').press('Enter');
      const row = panel.locator('#beta-search-results > article').filter({ has: panel.locator(`details[data-url=${JSON.stringify(sample.url)}]`) });
      await row.locator(':scope > details > summary').click(); await row.locator('.read-saved-page').click();
      await row.locator('.saved-reader-text').waitFor();
      assert.equal(await row.locator('.saved-reader-text').textContent(), acknowledged.find(record => record.url === sample.url).text);
      assert.equal(await row.locator('.saved-reader-text mark').textContent(), scenario.phrase);
      assert.equal(await row.locator('.saved-reader-text mark').isVisible(), true);
      if (scenario.partial) assert.equal(await row.locator('.saved-reader-host .capture-notice').isVisible(), true, 'Partial capture limitations must be visible in the packaged reader');
      assert.equal(await row.locator('.saved-reader-text img').count(), 0, 'Saved code must remain inert text');
      assert.equal(await panel.evaluate(() => globalThis.savedCodeRan), undefined);
    }
    await panel.close();
    const durationMs = performance.now() - started;
    return { samples, acknowledgment: durationSummary(samples.map(sample => sample.acknowledgedMs)), confirmedSearchable: durationSummary(samples.map(sample => sample.confirmedSearchableMs)), serialWorkflowMs: durationMs, serialWorkflowsPerSecond: samples.length * 1000 / durationMs, storedTextBytes: samples.reduce((sum, sample) => sum + sample.textBytes, 0), storage: await page.evaluate(() => navigator.storage.estimate()) };
  });
  await phase('acknowledged-captures-survive-process-crash', async entry => {
    const source = await context.newPage(), scenario = scenarios.find(scenario => scenario.kind === 'article');
    const url = `${serverOrigin}/article/fresh-crash-sentinel`;
    await source.goto(url); await source.bringToFront();
    if (largeJournalSentinel) await source.getByText(journalSentinelParagraphs.at(-1), { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const captureStartedAt = Date.now();
    const capture = await rpc(page, { type: 'CAPTURE_ACTIVE_TAB' });
    assert.equal(capture.ok, true); assert.equal(capture.received, true);
    const captureAcknowledgedAt = Date.now(), acknowledgedAt = performance.now();
    const termination = await crash();
    if (journalStudy) {
      journalAfterCrash = await observeBacking('snapshot closed journal after browser crash', () => captureLevelJournals(profile, extensionId));
      entry.journalBeforeCrashReopen = journalAfterCrash;
    }
    page = await open(profile, packaged, { reuseInstalled: normalRelaunchTiming, requireInstalled: !restartStudy || restartStudy === 'preinstalled' });
    const recovered = await withObservationDeadline(() => pages(page), 'read the first export after process-crash recovery');
    const sentinel = recovered.find(record => record.url === url);
    assert.ok(sentinel, 'Fresh acknowledged text must survive without an intervening orderly shutdown');
    assertCapturedPage(sentinel, scenario, url);
    if (largeJournalSentinel) for (const paragraph of journalSentinelParagraphs) assert.ok(sentinel.text.includes(paragraph), 'The larger acknowledged article must survive in full');
    assert.ok(sentinel.timestamp >= captureStartedAt && sentinel.timestamp <= captureAcknowledgedAt, 'The recovered capture must retain the time of the acknowledged save');
    assert.equal(sentinel.manual, true); assert.equal((sentinel.versions || []).length, 0);
    assertRetainedPages(acknowledged, recovered.filter(record => record.url !== url));
    acknowledged = recovered;
    return { retained: recovered.length, freshAcknowledgedUrl: url, freshAcknowledgedTextBytes: Buffer.byteLength(sentinel.text), acknowledgmentToCrashRequestMs: termination.requestedAt - acknowledgedAt, crashToDisconnectedMs: termination.disconnectedAt - termination.requestedAt };
  });
  await phase('acknowledged-captures-survive-browser-relaunch', async entry => {
    if (normalRelaunchTiming || restartStudy === 'reuse') entry.storageBeforeClose = await storageEvidence(page);
    await close();
    if (journalStudy) entry.journalBeforeOrdinaryRelaunch = await observeBacking('snapshot closed journal before orderly restart', () => captureLevelJournals(profile, extensionId, journalAfterCrash));
    else if (restartStudy === 'reuse') entry.backingAfterClose = await restartBackingEvidence(profile);
    else if (!normalRelaunchTiming) entry.storageFilesAfterClose = await profileStorageEvidence(profile);
    if (restartStudy !== 'split-profile') return verifyRelaunch(profile, packaged, restartStudy !== 'load-unpacked', acknowledged, entry);
    const controlProfile = path.join(directory, 'restart-control');
    await cp(profile, controlProfile, { recursive: true, force: false, errorOnExist: true, filter: async source => !(await lstat(source)).isSymbolicLink() });
    entry.snapshotDigests = await profileStorageEvidence(profile, true);
    assert.ok(Object.values(entry.snapshotDigests.IndexedDB).some(files => Object.entries(files).some(([file, value]) => /\.(log|ldb|sst)$/u.test(file) && value.size > 0)), 'The closed profile must contain nonempty IndexedDB data files');
    assert.deepEqual(await profileStorageEvidence(controlProfile, true), entry.snapshotDigests, 'The two branches must start with the same database and settings bytes');
    let firstError;
    for (const branch of [
      { name: 'duplicateLoad', profile, reuseInstalled: false },
      { name: 'existingRegistration', profile: controlProfile, reuseInstalled: true }
    ]) {
      const evidence = entry[branch.name] = {};
      try { Object.assign(evidence, await verifyRelaunch(branch.profile, packaged, branch.reuseInstalled, acknowledged, evidence)); }
      catch (error) { firstError ||= error; evidence.error = String(error); }
      try { await close(); }
      catch (error) {
        evidence.closeError = String(error);
        if (branch.name === 'duplicateLoad') entry.existingRegistration = { notRun: 'The original browser did not close cleanly.' };
        throw error;
      }
      try { evidence.storageFilesAfterRelaunch = await profileStorageEvidence(branch.profile); }
      catch (error) { firstError ||= error; evidence.fileProbeError = String(error); }
    }
    if (firstError) throw firstError;
  });
  await close();
  if (!restartStudy) {
  await phase('published-baseline-upgrade', async entry => {
    const previous = await unpack(stagedBaseline), upgradeProfile = path.join(directory, 'upgrade');
    page = await open(upgradeProfile, previous);
    await rpc(page, { type: 'SET_SETTINGS', payload: { paused: true } });
    const known = [
      { url: 'https://saved.qualification.test/article', title: 'Earlier field notes', text: 'Three coastal observations were saved before this upgrade.', timestamp: 1609459200000, manual: true, summary: 'Coastal field observations.', chunks: [{ text: 'Three coastal observations were saved before this upgrade.', embedding: [0.25, 0.75], embeddingKey: 'qualification-legacy-space' }] },
      { url: 'https://saved.qualification.test/manual#section', title: 'A manual with a fragment', text: 'The reference keeps a meaningful section address.', timestamp: 1640995200000, manual: false, chunks: [] }
    ];
    const imported = await rpc(page, { type: 'IMPORT_PAGES', schemaVersion: 1, pages: known });
    assert.equal(imported.imported, known.length);
    const before = await pages(page);
    assertRetainedPages(known, before);
    await page.close(); await unpack(stagedCandidate); page = await reloadCutover(previous.version, packaged);
    assertRetainedPages(before, await pages(page));
    entry.settingsBeforeSearch = (await rpc(page, { type: 'GET_SETTINGS' })).settings;
    assert.equal(entry.settingsBeforeSearch.paused, true);
    entry.settingsAfterOptOut = (await rpc(page, { type: 'SET_SETTINGS', payload: { automaticAi: false, queryRewrite: false, searchRerank: false } })).settings;
    entry.databases = await page.evaluate(() => indexedDB.databases());
    assert.equal(entry.settingsAfterOptOut.automaticAi, false, 'The upgraded worker must apply the current no-model preference before any query');
    const found = await rpc(page, { type: 'SEARCH_QUERY', query: '"coastal observations"', requestId: 'after-upgrade' });
    assert.ok(found.results.some(result => result.url === known[0].url));
    const read = (await rpc(page, { type: 'GET_SAVED_PAGE', url: known[0].url })).page;
    assert.equal(read.text, known[0].text);
    return { from: previous.version, to: packaged.version, retained: before.length };
  });
  await close();
  const recoveryProfile = path.join(directory, 'recovery');
  page = await open(recoveryProfile, packaged, { observeOffscreen: true });
  await rpc(page, { type: 'SET_SETTINGS', payload: { paused: true, automaticAi: false, queryRewrite: false, searchRerank: false } });
  await phase('interrupted-admission-is-not-acknowledged', async () => {
    const payload = recoveryPayload('interrupted-admission');
    const independent = { url: 'https://saved.qualification.test/committed', title: 'Committed save before interruption', text: 'Previously saved paper survives a different interrupted save.', timestamp: 1609459200000, manual: true, chunks: [] };
    assert.equal((await rpc(page, { type: 'IMPORT_PAGES', schemaVersion: 1, pages: [independent] })).imported, 1);
    const committed = await pages(page);
    assertRetainedPages([independent], committed);
    assert.deepEqual((await rpc(page, { type: 'GET_PROCESSING' })).queue, []);
    const authority = await inspectSqliteAuthority(page);
    const commit = await holdSqliteCommit(page, recoveryProfile);
    let held, termination;
    try {
      await page.evaluate(payload => {
        const admission = globalThis.qualificationAdmission = { settled: false };
        void chrome.runtime.sendMessage({ type: 'SAVE_PAGE', ...payload }).then(response => { admission.response = response; }, error => { admission.error = String(error); }).finally(() => { admission.settled = true; });
      }, payload);
      held = await until(commit.observe, 'admission to reach the real rollback journal removal');
      assert.ok(held.journalBytes > 0, 'An uncommitted rollback journal must exist at the interruption');
      assert.equal(await page.evaluate(() => globalThis.qualificationAdmission.settled), false, 'Uncommitted text must not be acknowledged');
      termination = await crash();
    } finally { await commit.close(); }
    page = await open(recoveryProfile, packaged, { requireInstalled: true });
    assertRetainedPages(committed, await pages(page));
    assert.equal((await inspectSqliteAuthority(page)).id, authority.id);
    assert.deepEqual((await rpc(page, { type: 'GET_PROCESSING' })).queue, [], 'Interrupted admission must not leave a phantom job');
    await searchable(page, payload, false);
    assert.equal((await rpc(page, { type: 'SAVE_PAGE', ...payload })).status, 'queued');
    await until(async () => !(await processing(page, payload.url)), 'model-free retry to drain');
    const saved = await savedCapture(page, payload); await searchable(page, payload);
    return { commitHeld: held, termination, retriedVersionId: saved.versionId, acknowledgedEarlierPagesRetained: committed.length };
  });
  await rpc(page, { type: 'SET_EMBEDDING_CONFIG', payload: { provider: 'ollama', baseUrl: serverOrigin, model: 'qualification-vector' } });
  await rpc(page, { type: 'SET_PROVIDER_SETTING', providerId: 'ollama', key: 'baseUrl', value: serverOrigin });
  await rpc(page, { type: 'SET_MODEL', key: 'chatModel', value: 'qualification-chat' });
  await rpc(page, { type: 'SET_SETTINGS', payload: { paused: true, automaticAi: true, activeProviderId: 'ollama', queryRewrite: false, searchRerank: false } });
  await phase('interrupted-indexing-recovers-acknowledged-text', async () => {
    const payload = recoveryPayload('interrupted-indexing');
    provider.setMode('hold');
    assert.equal((await rpc(page, { type: 'SAVE_PAGE', ...payload })).status, 'queued');
    await until(() => embeddingRequests(payload).find(request => request.state === 'held'), 'initial embedding request to reach the controlled provider');
    const admitted = await savedCapture(page, payload), job = await processing(page, payload.url);
    requireRecoveryIdentity(job.payload.captureId, 'Acknowledged indexing admission ID');
    assert.equal(job.status, 'processing'); assert.equal(job.textSaved, true); assert.equal(job.payload.text, payload.text);
    await searchable(page, payload);
    const termination = await crash();
    await until(() => embeddingRequests(payload)[0].state === 'disconnected', 'the crashed provider connection to close');
    page = await open(recoveryProfile, packaged, { requireInstalled: true });
    await until(() => embeddingRequests(payload).filter(request => request.state === 'held').length === 1, 'recovered indexing to reach the held provider');
    const recovered = await savedCapture(page, payload), recoveredJob = await processing(page, payload.url);
    requireRecoveryIdentity(recoveredJob.payload.captureId, 'Recovered indexing admission ID');
    assert.equal(recovered.versionId, admitted.versionId); assert.equal(recoveredJob.payload.captureId, job.payload.captureId);
    assert.equal(recoveredJob.status, 'processing'); await searchable(page, payload);
    provider.setMode('ready'); provider.release();
    const result = await indexedCapture(page, payload, admitted);
    assert.equal(embeddingRequests(payload).length, 2, 'One interrupted request must lead to one recovered request');
    return { ...result, termination, requests: 2 };
  });
  await phase('offline-provider-cannot-prevent-saving', async () => {
    const previous = recoveryPayload('interrupted-indexing');
    await until(async () => (await pages(page)).find(record => record.url === previous.url)?.summary, 'the previous synthetic summary to finish before the outage');
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(server.listening, false, 'The provider must actually be offline, not merely return an error response');
    const payload = recoveryPayload('offline-provider'), start = performance.now();
    assert.equal((await rpc(page, { type: 'SAVE_PAGE', ...payload })).status, 'queued');
    const acknowledgmentMs = performance.now() - start;
    const admitted = await savedCapture(page, payload); await searchable(page, payload);
    const failed = await until(async () => { const job = await processing(page, payload.url); return job?.status === 'failed' ? job : null; }, 'network failure to remain an actionable indexing error');
    assert.equal(failed.textSaved, true); assert.ok(failed.error?.trim());
    const failures = networkFailures.filter(request => request.phase === 'offline-provider-cannot-prevent-saving' && request.url === `${serverOrigin}/api/embed`);
    assert.equal(failures.length, 3, 'Only the existing three transient attempts may run while the listener is closed');
    for (const request of failures) assert.deepEqual(JSON.parse(request.body).input, payload.chunks);
    assert.equal(embeddingRequests(payload).length, 0, 'No HTTP server may have accepted the offline attempts');
    await savedCapture(page, payload); await searchable(page, payload);
    await new Promise((resolve, reject) => {
      const fail = error => { server.off('error', fail); reject(error); };
      server.once('error', fail);
      server.listen(Number(new URL(serverOrigin).port), '127.0.0.1', () => { server.off('error', fail); resolve(); });
    });
    assert.equal((await rpc(page, { type: 'RETRY_PROCESSING', url: payload.url })).retried, 1);
    const result = await indexedCapture(page, payload, admitted);
    assert.equal(embeddingRequests(payload).length, 1);
    return { ...result, acknowledgmentMs, failedAttempts: failures.length, error: failed.error, listenerRestored: server.listening, explicitRetryRequests: 1 };
  });
  await phase('provider-failure-retains-text-and-explicit-retry', async () => {
    const payload = recoveryPayload('provider-failure');
    provider.setMode('fail');
    assert.equal((await rpc(page, { type: 'SAVE_PAGE', ...payload })).status, 'queued');
    const failed = await until(async () => { const job = await processing(page, payload.url); return job?.status === 'failed' ? job : null; }, 'an actionable failed indexing entry');
    assert.ok(failed.error.includes(provider.failure)); assert.equal(failed.textSaved, true);
    const admitted = await savedCapture(page, payload); await searchable(page, payload);
    assert.ok(admitted.chunks.every(chunk => !chunk.embedding.length));
    const attemptsBeforeRestart = embeddingRequests(payload).length;
    assert.equal(attemptsBeforeRestart, 1, 'A non-retryable provider failure must not loop');
    provider.setMode('ready'); await close(); page = await open(recoveryProfile, packaged, { requireInstalled: true });
    assert.equal((await processing(page, payload.url)).status, 'failed');
    assert.equal(embeddingRequests(payload).length, attemptsBeforeRestart, 'Restart must not retry a failed job without an explicit request');
    await page.locator('details.view-control > summary').filter({ hasText: 'Tools' }).click();
    await page.locator('details.tool-disclosure > summary').filter({ hasText: 'Capture queue' }).click();
    const queueRow = page.locator('#manage-queue > div').filter({ hasText: payload.title });
    await queueRow.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.ok((await queueRow.textContent()).includes(provider.failure), 'The packaged UI must show the actual provider error');
    provider.setMode('hold');
    await queueRow.getByRole('button', { name: 'Retry', exact: true }).click();
    const held = await until(() => embeddingRequests(payload).find(request => request.state === 'held'), 'the explicit retry to reach the controlled provider');
    const retryJob = await processing(page, payload.url);
    assert.equal(retryJob.status, 'processing'); requireRecoveryIdentity(retryJob.payload.captureId, 'Explicit retry admission ID');
    assert.notEqual(retryJob.payload.captureId, failed.payload.captureId, 'Explicit retry must have its own indexing admission');
    const termination = await crash();
    await until(() => held.state === 'disconnected', 'the interrupted retry connection to close');
    page = await open(recoveryProfile, packaged, { requireInstalled: true });
    await until(() => embeddingRequests(payload).filter(request => request.state === 'held').length === 1, 'the explicit retry to recover after the crash');
    const recoveredRetryId = (await processing(page, payload.url)).payload.captureId;
    requireRecoveryIdentity(recoveredRetryId, 'Recovered retry admission ID');
    assert.equal(recoveredRetryId, retryJob.payload.captureId);
    provider.setMode('ready'); provider.release();
    const result = await indexedCapture(page, payload, admitted);
    assert.equal(embeddingRequests(payload).length, attemptsBeforeRestart + 2);
    return { ...result, error: failed.error, attemptsBeforeRestart, explicitRetryAdmissions: 1, interruptedRetryCaptureId: retryJob.payload.captureId, recoveredRetryRequests: 1, termination };
  });
  await phase('deleted-outstanding-work-cannot-resurrect', async () => {
    const payload = recoveryPayload('deleted-work');
    provider.setMode('hold');
    assert.equal((await rpc(page, { type: 'SAVE_PAGE', ...payload })).status, 'queued');
    const held = await until(() => embeddingRequests(payload).find(request => request.state === 'held'), 'the soon-deleted capture to reach the provider');
    assert.deepEqual(held.body.input, payload.chunks);
    await savedCapture(page, payload);
    assert.equal((await rpc(page, { type: 'DELETE_PAGE', url: payload.url })).deleted, 1);
    await until(() => held.state === 'disconnected', 'committed deletion to cancel the HTTP request');
    provider.setMode('ready'); provider.release();
    assert.equal((await pages(page)).some(record => record.url === payload.url), false);
    assert.equal(await processing(page, payload.url), undefined);
    await close(); page = await open(recoveryProfile, packaged, { requireInstalled: true });
    assert.equal((await rpc(page, { type: 'RETRY_PROCESSING', url: payload.url })).retried, 0);
    assert.equal((await rpc(page, { type: 'RETRY_FAILED_CAPTURES' })).retried, 0);
    assert.equal((await pages(page)).some(record => record.url === payload.url), false);
    assert.equal(await processing(page, payload.url), undefined); await searchable(page, payload, false);
    assert.equal(embeddingRequests(payload).length, 1, 'Neither late responses, restart nor retries may request forgotten text again');
    return { url: payload.url, requests: 1, observedCancellation: true, restoredAfterRestart: false };
  });
  await rpc(page, { type: 'SET_SETTINGS', payload: { automaticAi: false } });
  await close();
  const isolated = {
    open: (profile, options) => open(profile, packaged, options), close, directory, rpc,
    async openLegacySource(profile) {
      const manifest = await unpack(stagedBaseline);
      return { page: await open(profile, manifest), version: manifest.version };
    },
    async upgradeLegacySource(previous) {
      await previous.page.close();
      await unpack(stagedCandidate);
      return reloadCutover(previous.version, packaged);
    }
  };
  await phase('streaming-backup-clean-profile-restore', entry => qualifyBackup(isolated, entry));
  await close();
  await phase('recoverable-model-cache-loss', () => qualifyModelCacheRecovery(isolated));
  }
  }
} catch (error) { report.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  report.network = network; report.networkFailures = networkFailures; report.providerRequests = provider.requests; report.assetFailures = assetFailures; report.cleanupErrors = [];
  try { await close(); } catch (error) { report.cleanupErrors.push(String(error)); }
  provider.close();
  for (const socket of sockets) socket.destroy();
  try { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } catch (error) { report.cleanupErrors.push(String(error)); }
  try { if (directory && !context) await rm(directory, { recursive: true, force: true }); } catch (error) { report.cleanupErrors.push(String(error)); }
  report.sourceDrift = (await Promise.all(provenanceFiles.map(async file => { try { return fingerprint(await readFile(file)) === report.provenance[file] ? null : file; } catch { return file; } }))).filter(Boolean);
  try {
    assert.deepEqual(network.filter(request => new URL(request.url).origin !== serverOrigin), [], 'No requests outside the owned source/provider fixture are allowed');
    assert.deepEqual(network.filter(request => ['streaming-backup-clean-profile-restore', 'recoverable-model-cache-loss'].includes(request.phase)), [], 'Playwright must observe no HTTP during backup or cache status checks');
    assert.deepEqual(provider.requests.filter(request => request.state === 'invalid'), [], 'Invalid fixture requests must fail qualification');
    assert.ok(provider.requests.every(request => [SQLITE_PROVIDER_PHASE, SUSTAINED_PHASE, 'interrupted-indexing-recovers-acknowledged-text', 'offline-provider-cannot-prevent-saving', 'provider-failure-retains-text-and-explicit-retry', 'deleted-outstanding-work-cannot-resurrect'].includes(request.phase)), 'Model-free phases must not request a provider');
    assert.deepEqual(assetFailures, [], 'The packaged UI must load its runtime assets');
  } catch (error) { report.validationError = String(error); }
  report.finishedAt = new Date().toISOString();
  if (sustained) report.providerRequests = provider.requests.map(({ body, ...rest }) => ({ ...rest, ...(body ? { bodyHash: fingerprint(JSON.stringify(body)), bodyBytes: Buffer.byteLength(JSON.stringify(body)) } : {}) }));
  report.passed = !report.error && !report.validationError && report.phases.length === (sqliteJournalReplay ? 5 : sqliteCutover ? 3 : sustained || keyboard ? 1 : restartStudy ? 3 : 11) && report.phases.every(phase => phase.passed) && !report.cleanupErrors.length && !report.sourceDrift.length;
  if (!report.passed) process.exitCode = 1;
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.info(`Report: ${reportFile}`);
}
