import assert from 'node:assert/strict';
import { copyFile, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { assertRetainedPages, withObservationDeadline } from './capture-qualification.mjs';
import { auditOffscreenHttp, inspectSqliteFrames, inspectSqliteAuthority } from './sqlite-capture-qualification.mjs';

const smallUrl = 'https://backup.qualification.test/first';
const historyUrl = 'https://backup.qualification.test/history#observation';

function authoredLibrary({ smallUrl, historyUrl }) {
  const date = Date.UTC(2024, 1, 6, 12);
  const snapshot = (index, large) => {
    const phrase = index === 0 ? 'black spruce current chronicle' : index === 10 ? 'opal kettle early field notes' : 'tamarack intermediate field notes';
    const text = `${phrase}\nSnow and ice: "quoted" \\ evidence for version ${index} — café 🌲.\nFinal note.`;
    return {
      title: large ? `Historical report ${index}` : 'A second saved page',
      text, timestamp: date - index * 86400000, firstCapturedAt: index ? date - index * 86400000 : date - 10 * 86400000,
      versionId: large ? `saved-report-${index}` : 'saved-short-page', kept: index > 4,
      manual: index % 2 === 0, lastEmbeddedAt: date + index,
      ...(large ? { summary: `Independent overview of report ${index}.` } : {}),
      captureInfo: { source: 'article', warnings: ['Excluded embedded media.'], extractor: 'fixture-v1' },
      annotationMetadata: { nil: null, empty: [], enabled: false, ordinal: index },
      chunks: Array.from({ length: large ? 480 : 1 }, (_, chunk) => ({
        text: `${phrase} — passage ${chunk}`, embeddingKey: 'portable-fixture-space', position: chunk,
        embedding: Array.from({ length: large ? 768 : 2 }, (_, dimension) => ((index * 1201 + chunk * 43 + dimension * 31) % 1009) / 1013)
      }))
    };
  };
  return [
    { ...snapshot(0, false), url: smallUrl, text: 'The small bell tower register is a separate saved page.', createdAt: date, updatedAt: date, versions: [] },
    { ...snapshot(0, true), url: historyUrl, createdAt: date - 10 * 86400000, updatedAt: date, lastVisitedAt: date + 5, versions: Array.from({ length: 10 }, (_, index) => snapshot(index + 1, true)) }
  ];
}

export function assertBackupEvidence(expected, actual) {
  assert.deepEqual(actual.map(record => record.url).sort(), expected.map(record => record.url).sort(), 'Restored URLs must match the expected library');
  for (const record of expected) {
    const restored = actual.find(candidate => candidate.url === record.url);
    assert.deepEqual(restored.snapshots.map(snapshot => snapshot.id).sort(), record.snapshots.map(snapshot => snapshot.id).sort(), `${record.url}: version identities changed`);
    for (const snapshot of record.snapshots) {
      const compared = restored.snapshots.find(candidate => candidate.id === snapshot.id);
      assert.deepEqual(compared, snapshot, `${record.url} version ${snapshot.id}: saved evidence or version relationship changed`);
    }
  }
}

export async function backupEvidence(records) {
  const project = async (snapshot, current) => {
    const { versions: _versions, ...fields } = snapshot;
    if (current) delete fields.updatedAt;
    const json = JSON.stringify(fields, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
    return {
      current, timestamp: snapshot.timestamp, hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
      ...(snapshot.versionId === undefined ? {} : { id: snapshot.versionId }),
      ...(snapshot.kept === undefined ? {} : { kept: snapshot.kept })
    };
  };
  const evidence = [];
  for (const record of records) {
    const snapshots = [await project(record, true)];
    for (const version of record.versions || []) snapshots.push(await project(version, false));
    evidence.push({ url: record.url, snapshots });
  }
  return evidence;
}

async function seedLegacyBackup(fixture, describe) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('webRecallBeta');
    open.onupgradeneeded = () => open.transaction.abort();
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('pages', 'readwrite', { durability: 'strict' });
      for (const record of fixture) tx.objectStore('pages').add(record);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
  return describe(fixture);
}

async function readBackupFrames(describe) {
  const evidence = [];
  let after, revision;
  do {
    const batch = await globalThis.qualificationReadSavedFrames({ op: 'pages', after, limit: 1 });
    if (!Number.isSafeInteger(batch.revision) || (revision !== undefined && batch.revision !== revision)) throw Error('Saved backup evidence changed during the scan');
    if (batch.after !== null && (batch.after !== batch.records.at(-1)?.url || (after !== undefined && batch.after <= after))) throw Error('Saved backup evidence cursor did not advance');
    after = batch.after;
    revision = batch.revision;
    evidence.push(...await describe(batch.records));
  } while (after !== null);
  return evidence;
}

async function readEvidence(page) {
  const seal = await inspectSqliteAuthority(page);
  const evidence = await inspectSqliteFrames(page, '(' + readBackupFrames.toString() + ')(' + backupEvidence.toString() + ')');
  assert.equal(evidence.length, seal.pages, 'The complete framed scan must agree with the authority page count');
  return evidence;
}
const done = (page, pattern) => page.locator('#manage-status').filter({ hasText: pattern }).waitFor({ timeout: 60000 });

async function backupControls(page) {
  await page.locator('details.view-control > summary').filter({ hasText: /^Tools$/u }).click();
  await page.locator('details.tool-disclosure > summary').filter({ hasText: /^Backup & restore$/u }).click();
}

async function installExportHandle(page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = globalThis.qualificationBackupHandle = await root.getFileHandle('qualification-backup.jsonl', { create: true });
    const initial = await handle.createWritable();
    await initial.write('Previous complete file');
    await initial.close();
    const harness = globalThis.qualificationExport = { hold: true, writes: 0, aborted: false };
    window.showSaveFilePicker = async () => ({ createWritable: async () => {
      const writer = await handle.createWritable();
      return {
        write: async value => {
          await writer.write(value);
          harness.writes++;
          if (harness.hold) await new Promise(resolve => { harness.resume = resolve; });
        },
        close: () => writer.close(),
        abort: async () => {
          try { await writer.abort(); harness.aborted = true; }
          finally { harness.resume?.(); }
        }
      };
    } });
  });
}

async function installImportStopGate(page) {
  await page.evaluate(historyUrl => {
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = options => {
      const port = connect(options);
      if (options?.name !== 'web-recall-backup') return port;
      const add = port.onMessage.addListener.bind(port.onMessage);
      const remove = port.onMessage.removeListener.bind(port.onMessage);
      const post = port.postMessage.bind(port);
      const gate = globalThis.qualificationImportGate = { paused: false };
      const listeners = new Map();
      let blockedId;
      port.postMessage = request => {
        if (request.action === 'import' && !blockedId) {
          const frame = JSON.parse(request.line);
          if (frame.type === 'page' && frame.page.url === historyUrl) blockedId = request.id;
        }
        post(request);
        if (request.action === 'cancel') gate.deliver?.();
      };
      port.onMessage.addListener = listener => {
        const wrapped = reply => {
          if (reply.id === blockedId && !reply.error && reply.pages === 1) {
            gate.paused = true; gate.deliver = () => listener(reply);
          } else listener(reply);
        };
        listeners.set(listener, wrapped); add(wrapped);
      };
      port.onMessage.removeListener = listener => remove(listeners.get(listener) || listener);
      return port;
    };
  }, historyUrl);
}

export async function qualifyBackup({ open, close, directory, rpc, openLegacySource, upgradeLegacySource }, entry) {
  entry.backupEvidence = [];
  const verify = async (stage, page, expected) => {
    const checkpoint = { stage, passed: false };
    entry.backupEvidence.push(checkpoint);
    const count = page.locator('#manage-count').filter({ hasText: new RegExp(`^${expected.length} pages?$`, 'u') });
    try { await count.waitFor(); }
    catch (cause) {
      const status = await page.locator('#manage-status').textContent();
      throw Error(`Memory did not show ${expected.length} saved pages at ${stage}: ${status}`, { cause });
    }
    const listing = await withObservationDeadline(() => rpc(page, { type: 'GET_PAGE_LIST' }), 'read public Memory after ' + stage);
    assert.deepEqual(listing.pages.map(record => record.url).sort(), expected.map(record => record.url).sort(), `Unexpected public Memory URLs at ${stage}`);
    checkpoint.publicPageCount = listing.pages.length;
    assertBackupEvidence(expected, await readEvidence(page));
    checkpoint.passed = true;
  };
  const previous = await openLegacySource(path.join(directory, 'backup-source'));
  const fixture = '(' + authoredLibrary.toString() + ')(' + JSON.stringify({ smallUrl, historyUrl }) + ')';
  const expected = await withObservationDeadline(() => previous.page.evaluate('(' + seedLegacyBackup.toString() + ')(' + fixture + ', ' + backupEvidence.toString() + ')'),
    'seed the published library with independent authored snapshots', 60000);
  const source = await upgradeLegacySource(previous);
  await verify('migrated source', source, expected);
  assert.equal(expected.find(record => record.url === historyUrl).snapshots.length, 11);
  await backupControls(source);
  await installExportHandle(source);
  await source.locator('#manage-export').click();
  await source.waitForFunction(() => globalThis.qualificationExport.writes > 0 && Boolean(globalThis.qualificationExport.resume));
  await source.locator('#manage-transfer-stop').click();
  await done(source, /^Export cancelled$/u);
  assert.equal(await source.evaluate(async () => (await globalThis.qualificationBackupHandle.getFile()).text()), 'Previous complete file', 'Stop must not replace the previous file with partial output');
  assert.equal(await source.evaluate(() => globalThis.qualificationExport.aborted), true);
  await source.evaluate(() => { globalThis.qualificationExport.hold = false; });
  await source.locator('#manage-export').click();
  await done(source, /^Export complete: 2 pages$/u);
  const exported = source.waitForEvent('download');
  await source.evaluate(async () => {
    const handle = globalThis.qualificationBackupHandle;
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(await handle.getFile());
    anchor.download = handle.name;
    anchor.click();
  });
  const backupFile = path.join(directory, 'exported.jsonl');
  await (await exported).saveAs(backupFile);
  const bytes = (await stat(backupFile)).size;
  assert.ok(bytes > 64 * 1024 * 1024 && bytes < 128 * 1024 * 1024, 'The backup must exceed a whole Chrome message without exceeding the authored page budget');
  await verify('source after export', source, expected);
  await close();

  const targetProfile = path.join(directory, 'backup-target');
  let target = await open(targetProfile);
  await verify('empty stop-test profile', target, []);
  await backupControls(target);
  const damaged = path.join(directory, 'truncated.jsonl');
  await copyFile(backupFile, damaged);
  await truncate(damaged, bytes - 50);
  await target.locator('#manage-import').setInputFiles(damaged);
  await done(target, /^Import failed:/u);
  await verify('after truncated restore', target, []);
  await installImportStopGate(target);
  await target.locator('#manage-import').setInputFiles(backupFile);
  await target.waitForFunction(() => globalThis.qualificationImportGate?.paused, undefined, { timeout: 60000 });
  await target.locator('#manage-transfer-stop').click();
  await done(target, /^Import stopped: 1 pages restored$/u);
  const partial = expected.filter(record => record.url === smallUrl);
  await verify('after Stop', target, partial);
  await close();

  target = await open(targetProfile, { requireInstalled: true });
  await verify('after reopening stopped restore', target, partial);
  await close();

  const cleanProfile = path.join(directory, 'backup-clean-restore');
  target = await open(cleanProfile);
  await verify('empty clean restore profile', target, []);
  await backupControls(target);
  await target.locator('#manage-import').setInputFiles(backupFile);
  await done(target, /^Import complete: 2 pages$/u);
  await verify('after full restore', target, expected);

  const old = { url: historyUrl, title: 'Stale destination', text: 'This destination is replaced by the framed backup.', timestamp: 1, manual: false, summary: 'Stale overview', chunks: [], versions: [] };
  const legacy = { url: smallUrl, title: 'Legacy conflict', text: 'A conflicting small page.', timestamp: 2, summary: 'Not in the backup', chunks: [] };
  assert.equal((await rpc(target, { type: 'IMPORT_PAGES', schemaVersion: 1, pages: [old, legacy] })).imported, 2);
  assertRetainedPages([old, legacy], (await rpc(target, { type: 'GET_ALL_PAGES' })).pages);
  await target.locator('#manage-import').setInputFiles(backupFile);
  await done(target, /^Import complete: 2 pages$/u);
  await verify('after restoring over conflicts', target, expected);
  await close();

  target = await open(cleanProfile, { requireInstalled: true });
  await verify('after reopening full restore', target, expected);
  const query = 'opal kettle early field notes';
  const found = await rpc(target, { type: 'SEARCH_QUERY', query: `"${query}"`, requestId: 'restored-snapshot-search' });
  const match = found.results.find(result => result.url === historyUrl);
  assert.equal(match?.versionId, 'saved-report-10', 'Search must find the saved historical version, not its current replacement');
  const history = (await rpc(target, { type: 'GET_SAVED_HISTORY', url: historyUrl })).versions;
  assert.equal(history.length, 11);
  const older = history.find(version => version.versionId === 'saved-report-10');
  assert.equal(older?.kept, true);
  assert.equal(older.timestamp, Date.UTC(2024, 1, 6, 12) - 10 * 86400000);
  const saved = (await rpc(target, { type: 'GET_SAVED_PAGE', url: historyUrl, versionId: older.versionId, query })).page;
  assert.equal(saved.versionId, older.versionId);
  assert.equal(saved.current, false);
  assert.equal(saved.text, `${query}\nSnow and ice: "quoted" \\ evidence for version 10 — café 🌲.\nFinal note.`);
  return { bytes, cleanRestorePages: expected.length, replacedConflicts: 2, historicalVersions: 10, truncatedRestoreWrites: 0, stoppedRestorePages: 1, checkedHistoricalVersion: saved.versionId };
}

export async function qualifyModelCacheRecovery({ open, close, directory, rpc }) {
  const profile = path.join(directory, 'model-cache-recovery');
  let page = await open(profile, { observeOffscreen: true });
  const record = { url: smallUrl, title: 'Independent saved evidence', text: 'Cached model files are not my saved library.', timestamp: 1700000000000, manual: true, summary: 'My local evidence.', chunks: [{ text: 'Cached model files are not my saved library.', embedding: [2, 3], embeddingKey: 'original-space' }] };
  assert.equal((await rpc(page, { type: 'IMPORT_PAGES', pages: [record], schemaVersion: 1 })).imported, 1);
  assertRetainedPages([record], (await rpc(page, { type: 'GET_ALL_PAGES' })).pages);
  const expected = await readEvidence(page);
  const initial = await auditOffscreenHttp(page, profile, async () => {
    const { config } = await rpc(page, { type: 'SET_EMBEDDING_CONFIG', payload: { provider: 'browser' } });
    assert.ok(config.browserModel && config.browserRevision);
    const asset = 'https://huggingface.co/' + config.browserModel + '/resolve/' + config.browserRevision + '/config.json';
    await page.evaluate(async asset => {
      const cache = await caches.open('transformers-cache');
      await cache.put(asset, new Response('{}'));
      await chrome.storage.local.set({ browserEmbedReady: true });
    }, asset);
    const { status: cached } = await rpc(page, { type: 'GET_BROWSER_EMBED_STATUS', probe: true });
    assert.equal(cached.ready, false, 'An incomplete cache must not claim inference readiness');
    assert.equal(cached.state, 'cached');
    const lost = await page.evaluate(async asset => (await caches.open('transformers-cache')).delete(asset), asset);
    assert.equal(lost, true);
    return { config, cached: cached.state };
  });
  await close();
  page = await open(profile, { requireInstalled: true, observeOffscreen: true });
  const missing = await auditOffscreenHttp(page, profile, async () => {
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('browserEmbedReady')).browserEmbedReady), true, 'The stale marker must survive to test startup readiness');
    const observed = (await rpc(page, { type: 'GET_EMBEDDING_CONFIG' })).config;
    assert.equal(observed.provider, 'browser');
    assert.equal(observed.browserModel, initial.config.browserModel);
    assert.equal(observed.browserRevision, initial.config.browserRevision);
    const { status: startup } = await rpc(page, { type: 'GET_BROWSER_EMBED_STATUS' });
    assert.equal(startup.ready, false, 'Startup must ignore the stale marker before any probing can correct it');
    const { status } = await rpc(page, { type: 'GET_BROWSER_EMBED_STATUS', probe: true });
    assert.equal(status.runtimeAvailable, true);
    assert.equal(status.ready, false, 'A previous ready marker must not hide missing files after restart');
    assert.equal(status.state, 'idle');
    const { models } = await rpc(page, { type: 'LIST_BROWSER_MODELS' });
    assert.deepEqual(models, [], 'An evicted model must not appear as a saved download');
    const { download } = await rpc(page, { type: 'GET_BROWSER_MODEL_DOWNLOAD' });
    assert.equal(download, null, 'No model download may have been started by startup or the status probe');
    return status.state;
  });
  assertBackupEvidence(expected, await readEvidence(page));
  return { cachedBeforeLoss: initial.cached, missingAfterRestart: missing, observedOffscreenHttpRequestsDuringProbes: 0, savedPagesRetained: expected.length };
}
