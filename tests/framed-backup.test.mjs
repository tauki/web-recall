import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';
import { loadSource, plain, waitFor, tick } from './helpers.mjs';
import { installRuntimePorts } from './runtime-ports.mjs';

const url = 'https://backup.test/article';
const original = { url, title: 'Original', versionId: 'current', text: 'Current complete evidence.', timestamp: 300, firstCapturedAt: 290, kept: false, manual: true, summary: 'Current overview.', chunks: [{ text: 'Current complete evidence.', embedding: [1, 0], embeddingKey: 'retained-model', position: 0 }], createdAt: 0, lastVisitedAt: 310, lastEmbeddedAt: 301, futureMetadata: { nil: null, enabled: false, empty: [], zero: 0 }, captureInfo: { source: 'article', warnings: [], extractorVersion: 'future' }, versions: [{ title: '', versionId: 'old', text: 'Older preserved evidence.', timestamp: 0, firstCapturedAt: 0, lastVisitedAt: 0, lastEmbeddedAt: 0, manual: false, kept: true, chunks: [{ text: 'Older preserved evidence.', embedding: [0, 1], embeddingKey: 'old-model', note: { heading: '' } }], summary: '', futureVersionMetadata: ['retained'] }] };
const encode = value => JSON.stringify(value);
const v2 = pages => ['{"format":"web-recall","schemaVersion":2}', ...pages.map(page => encode({ type: 'page', page })), encode({ type: 'end', pages: pages.length })];
const v3 = (page = original) => [
  '{"format":"web-recall","schemaVersion":3}',
  encode({ type: 'page', page: Object.fromEntries(Object.entries(page).filter(([key]) => key !== 'versions')), versionCount: page.versions?.length || 0 }),
  ...(page.versions || []).map((version, index) => encode({ type: 'version', url: page.url, index, version })),
  encode({ type: 'page-end', url: page.url, versionCount: page.versions?.length || 0 }),
  '{"type":"end","pages":1}'
];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(testContext, overrides = {}) {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts', overrides);
  const runtime = await backend.load('src/background/orchestration/index.ts', overrides);
  runtime.orchestrateLifecycle();
  const clients = [];
  const { BackupTransfer } = await loadSource('src/ui/shared/backupTransfer.ts', '', {}, { chrome: { runtime: backend.runtime } });
  const client = mode => { const connection = new BackupTransfer(mode); clients.push(connection); return connection; };
  testContext.after(async () => { clients.forEach(connection => connection.close()); await tick(); (await db.openDatabase()).close(); });
  return { backend, db, client };
}

async function exportAll(client) {
  const lines = [];
  while (true) { const reply = await client.next(); lines.push(reply.line); if (reply.complete) return lines; }
}
async function importAll(client, lines) {
  let reply;
  for (const line of lines) reply = await client.next(line);
  assert.equal(reply.complete, true);
  return reply.pages;
}

test('late Stop reports a completed library restore rather than claiming it was stopped', async context => {
  const entered = deferred(), commit = deferred();
  const runtime = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', getURL: name => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${name}` };
  installRuntimePorts(runtime);
  const connect = runtime.connect;
  runtime.connect = options => connect(options, { id: runtime.id, url: runtime.getURL('dist/beta/ui/sidepanel/index.html#settings-restore') });
  const mocks = {
    '../storage/manager': { storageManager: {} }, './restore': { restorePage: () => assert.fail('Recovery cannot import into the old library') },
    './recents': { invalidateRecentPages: async () => {} }, '../lifetime': { beginWorkerLease: () => () => {} },
    '../storage/libraryRecovery': { async beginLibraryRecovery() {
      return { async stage() {}, async publish() { entered.resolve(); await commit.promise; }, async discard() { assert.fail('Stop cannot discard a published authority'); } };
    } }
  };
  const { bindBackupTransfers } = await loadSource('src/background/manage/backup.ts', '', mocks, { chrome: { runtime } });
  bindBackupTransfers();
  const { BackupTransfer } = await loadSource('src/ui/shared/backupTransfer.ts', '', {}, { chrome: { runtime } });
  const importer = new BackupTransfer('import', true);
  context.after(() => importer.close());
  for (const line of v3()) assert.equal((await importer.next(line)).pages, 0);
  const pending = importer.publishRestore();
  await entered.promise;
  const stopping = importer.cancel();
  await tick();
  commit.resolve();
  assert.equal((await pending).complete, true);
  const reply = await stopping;
  assert.equal(reply.complete, true);
  assert.equal(reply.stopped, undefined);
  assert.equal(reply.pages, 1);
});

test('framed runtime backup round-trips five large vector snapshots and unknown metadata beyond the old whole-page wire budget', async testContext => {
  const state = await fixture(testContext);
  const snapshot = index => ({ title: `Reference ${index}`, versionId: `version-${index}`, timestamp: index, firstCapturedAt: index, kept: index === 0, manual: false, text: `Version ${index} ` + 'science '.repeat(100_000), summary: `Overview ${index}`, chunks: Array.from({ length: 400 }, (_, chunk) => ({ text: `Passage ${index}:${chunk}`, embedding: Array.from({ length: 768 }, (_, dimension) => ((dimension + chunk) % 37) / 37), embeddingKey: 'preserved-model' })) });
  const large = { ...original, ...snapshot(4), versions: [snapshot(3), snapshot(2), snapshot(1), { ...original.versions[0], ...snapshot(0) }] };
  await state.db.savePageRecord(large);
  const before = plain(await state.db.getPageRecord(url));
  const lines = await exportAll(state.client('export'));
  assert.ok(new TextEncoder().encode(lines.join('\n')).length > 16 * 1024 * 1024, 'The fixture must exercise history that the previous whole-page record could not export');
  for (const connection of state.backend.ports) for (const frame of connection.sent) assert.ok(frame.bytes < 64 * 1024 * 1024, 'Chrome JSON messages must remain below its documented 64 MiB message limit');
  await state.db.deletePages([url]);
  assert.equal(await importAll(state.client('import'), lines), 1);
  const restored = plain(await state.db.getPageRecord(url));
  assert.deepEqual({ ...restored, updatedAt: before.updatedAt }, before);
  assert.ok(restored.updatedAt >= before.updatedAt);
});

test('export holds one immutable page snapshot while a new capture replaces it between history frames', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(original);
  const exporter = state.client('export'); const lines = [(await exporter.next()).line, (await exporter.next()).line];
  await state.db.savePageRecord({ ...original, title: 'Changed during export', text: 'Different source', versions: [] }, { replace: true });
  while (true) { const reply = await exporter.next(); lines.push(reply.line); if (reply.complete) break; }
  assert.equal(JSON.parse(lines[1]).page.title, 'Original');
  assert.equal(JSON.parse(lines[2]).version.text, 'Older preserved evidence.');
  assert.equal(await importAll(state.client('import'), lines), 1);
  assert.equal((await state.db.getPageRecord(url)).text, original.text);
  assert.equal((await state.db.getPageRecord(url)).versions[0].summary, '');
});

test('handcrafted schema-2 and legacy JSON still restore independent of new framing and page ordering', async testContext => {
  const state = await fixture(testContext);
  const other = { ...original, url: 'https://backup.test/aaa', summary: undefined, versions: [] };
  assert.equal(await importAll(state.client('import'), v2([original, other])), 2);
  assert.equal((await state.db.getPageRecord(url)).versions[0].futureVersionMetadata[0], 'retained');
  assert.equal((await state.db.getPageRecord(other.url)).summary, undefined);
  const legacy = state.client('import');
  assert.equal((await legacy.importLegacy([{ url, title: 'Legacy', timestamp: 0, items: [{ text: 'Legacy item', embedding: [0.3] }] }], 1)).pages, 1);
  assert.equal((await state.db.getPageRecord(url)).text, 'Legacy item');
  assert.equal((await state.db.getPageRecord(url)).timestamp, 0);
});

test('preflight rejects corrupt, truncated, reordered, duplicate and mismatched frames and releases its stream', async () => {
  const { validateBackup } = await loadSource('src/shared/backupFrames.ts');
  const valid = v3();
  const bad = [
    valid.slice(0, -1), [...valid, '{}'], [valid[0], valid[2], ...valid.slice(1)],
    valid.map((line, index) => index === 2 ? encode({ ...JSON.parse(line), index: 1 }) : line),
    valid.map((line, index) => index === 2 ? encode({ ...JSON.parse(line), url: 'https://different.test/' }) : line),
    valid.map((line, index) => index === 2 ? encode({ ...JSON.parse(line), version: { ...original.versions[0], versionId: 'current' } }) : line),
    valid.map((line, index) => index === 3 ? encode({ ...JSON.parse(line), versionCount: 2 }) : line),
    valid.map((line, index) => index === 4 ? '{"type":"end","pages":2}' : line),
    [valid[0], ...valid.slice(1, -1), ...valid.slice(1)],
    valid.map((line, index) => index === 2 ? encode({ ...JSON.parse(line), version: { ...original.versions[0], chunks: [{ text: 'x', embedding: ['bad'] }] } }) : line)
  ];
  assert.equal(await validateBackup(new Blob([valid.join('\n')]).stream()), 1);
  for (const lines of bad) {
    const stream = new Blob([lines.join('\n')]).stream();
    await assert.rejects(validateBackup(stream), /backup|version|frame|count|identit/i);
    assert.equal(stream.locked, false);
  }
  const bytes = new Uint8Array([...new TextEncoder().encode(valid[0] + '\n'), 0xc3, 0x28]);
  await assert.rejects(validateBackup(new Blob([bytes]).stream()), /encoded|encoding/i);
});

test('Stop and disconnected imports discard incomplete history without overwriting destination and release transfer ownership', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(original);
  const before = plain(await state.db.getPageRecord(url));
  for (const stop of ['cancel', 'disconnect']) {
    const importer = state.client('import');
    for (const line of v3({ ...original, text: 'Replacement' }).slice(0, 3)) await importer.next(line);
    if (stop === 'cancel') assert.equal((await importer.cancel()).pages, 0);
    else importer.close();
    await tick();
    assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
    const retry = state.client('import');
    assert.equal(await importAll(retry, v3(original)), 1);
    before.updatedAt = (await state.db.getPageRecord(url)).updatedAt;
  }
});

test('Stop aborts an in-flight strict page transaction and reports only confirmed earlier pages', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(original);
  const before = plain(await state.db.getPageRecord(url)), importer = state.client('import');
  const connection = await state.db.openDatabase(), prototype = Object.getPrototypeOf(connection), originalTransaction = prototype.transaction;
  let stopped, injected = false;
  prototype.transaction = function (...args) {
    const transaction = originalTransaction.apply(this, args);
    if (!injected && transaction.mode === 'readwrite' && transaction.objectStoreNames.contains('pages')) {
      const store = transaction.objectStore('pages'), put = store.put.bind(store);
      store.put = value => { const request = put(value); injected = true; request.addEventListener('success', () => { stopped = importer.cancel(); }, { once: true }); return request; };
    }
    return transaction;
  };
  testContext.after(() => { prototype.transaction = originalTransaction; });
  const lines = v3({ ...original, text: 'Must not commit' });
  for (const line of lines.slice(0, 3)) await importer.next(line);
  await assert.rejects(importer.next(lines[3]), /Stopped/);
  assert.equal(injected, true); assert.equal((await stopped).pages, 0);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), before);
});

test('a transfer cannot steal another snapshot and a non-extension sender cannot start one', async testContext => {
  const state = await fixture(testContext); await state.db.savePageRecord(original);
  const exporter = state.client('export'); await exporter.next();
  await assert.rejects(state.client('export').next(), /Another backup/);
  assert.equal(JSON.parse((await exporter.next()).line).page.title, 'Original');
  await exporter.cancel();
  assert.ok((await exportAll(state.client('export'))).some(line => JSON.parse(line).type === 'end'));
  const foreign = state.backend.runtime.connect({ name: 'web-recall-backup' }, { id: state.backend.runtime.id, url: 'https://backup.test/' });
  let disconnected = false; foreign.onDisconnect.addListener(() => { disconnected = true; });
  await waitFor(() => disconnected, 'untrusted connection rejection');
  for (const type of ['GET_BACKUP_PAGE', 'IMPORT_BACKUP_PAGE', 'IMPORT_PAGES', 'GET_ALL_PAGES']) assert.ok((await state.backend.send({ type }, { id: state.backend.runtime.id, url: 'https://backup.test/' })).error);
});

test('lost acknowledgement never becomes successful EOF and explicitly reports uncertain restore completion', async testContext => {
  const state = await fixture(testContext);
  const importer = state.client('import'); const lines = v3();
  for (const line of lines.slice(0, 3)) await importer.next(line);
  const port = state.backend.ports.at(-1); port.dropResponses = true;
  const pending = importer.next(lines[3]); const failure = assert.rejects(pending, /connection lost; 0 pages confirmed.*last page may have completed/i);
  const lastRequest = port.sent.at(-1).id;
  await waitFor(() => port.sent.some(frame => frame.direction === 'response' && frame.id === lastRequest), 'committed-page acknowledgement to be dropped');
  port.worker.disconnect(); await failure;
  assert.equal((await state.db.getPageRecord(url)).text, original.text);
  await tick(); assert.equal(await importAll(state.client('import'), v3()), 1);
});

for (const operation of ['REGENERATE_PAGE_SUMMARY', 'BACKFILL_EMBEDDINGS']) test(`same-ID restore fences active ${operation} without an inference timeout and later work still succeeds`, async testContext => {
  const gate = deferred(), signals = []; let blocked = true;
  const state = await fixture(testContext, { Date: class extends Date { static now() { return 500; } }, fetch: async (input, options = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 8192 }] });
    if (path === '/api/chat' || path === '/api/embed') { signals.push(options.signal); if (blocked) await gate.promise; return path === '/api/chat' ? Response.json({ message: { content: 'Later overview.' } }) : Response.json({ embeddings: [[0, 1]] }); }
    throw Error(`Unexpected request ${path}`);
  } });
  await state.db.savePageRecord(original); const before = plain(await state.db.getPageRecord(url));
  const pending = state.backend.send({ type: operation, requestId: 'pre-restore', url, urls: [url], force: true });
  await waitFor(() => signals.length === 1, 'active saved inference');
  try {
    assert.equal(await importAll(state.client('import'), v3(before)), 1);
    assert.equal(signals[0].aborted, true);
    const response = await pending;
    if (operation === 'REGENERATE_PAGE_SUMMARY') assert.match(response.error, /restore/);
    else { assert.equal(response.result.updated, 0); assert.equal(response.result.failed, 1); }
    blocked = false; gate.resolve(); await tick();
    const restored = plain(await state.db.getPageRecord(url));
    assert.ok(restored.updatedAt > before.updatedAt); assert.deepEqual({ ...restored, updatedAt: before.updatedAt }, before);
    const later = await state.backend.send({ type: operation, requestId: 'post-restore', url, urls: [url], force: true });
    assert.equal(later.error, undefined);
    if (operation === 'REGENERATE_PAGE_SUMMARY') assert.equal((await state.db.getPageRecord(url)).summary, 'Later overview.');
    else assert.deepEqual(plain((await state.db.getPageRecord(url)).chunks[0].embedding), [0, 1]);
  } finally { blocked = false; gate.resolve(); await pending; }
});

test('a pending bulk target and its later summary phase cannot adopt an identically restored version', async testContext => {
  const gate = deferred(), sent = [];
  const state = await fixture(testContext, { fetch: async (input, options = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 8192 }] });
    const body = JSON.parse(options.body); sent.push(body);
    if (path === '/api/embed') { if (body.input[0] === 'Blocker') await gate.promise; return Response.json({ embeddings: [[0, 1]] }); }
    if (path === '/api/chat') return Response.json({ message: { content: 'Blocker overview.' } });
    throw Error(`Unexpected request ${path}`);
  } });
  const target = { ...original, summary: undefined };
  await state.db.savePageRecord(target); await state.db.savePageRecord({ ...original, url: 'https://backup.test/aaa', text: 'Blocker', chunks: [{ text: 'Blocker', embedding: [] }], summary: undefined });
  const before = plain(await state.db.getPageRecord(url));
  const pending = state.backend.send({ type: 'BACKFILL_EMBEDDINGS', requestId: 'pending-target', force: true, createSummaries: true, urls: ['https://backup.test/aaa', url] });
  await waitFor(() => sent.some(body => body.input?.[0] === 'Blocker'), 'preceding bulk target');
  try { await importAll(state.client('import'), v3(before)); } finally { gate.resolve(); }
  const response = await pending;
  assert.equal(response.result.updated, 1); assert.equal(response.result.failed, 1); assert.equal(response.result.summariesFailed, 1);
  assert.equal(sent.filter(body => body.input).length, 1);
  assert.ok(sent.filter(body => body.messages).every(body => !JSON.stringify(body).includes(original.text)));
  const after = plain(await state.db.getPageRecord(url)); assert.deepEqual({ ...after, updatedAt: before.updatedAt }, before);
});

for (const identity of ['same-ID', 'ID-less']) test(`a summary queued before ${identity} restore cannot generate from or mutate that restored source`, async testContext => {
  const gate = deferred(), bodies = [];
  const state = await fixture(testContext, { fetch: async (input, options = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 8192 }] });
    if (path === '/api/chat') { const body = JSON.parse(options.body); bodies.push(body); if (bodies.length === 1) await gate.promise; return Response.json({ message: { content: 'Completed overview.' } }); }
    throw Error(`Unexpected request ${path}`);
  } });
  await state.db.savePageRecord(original);
  await state.db.savePageRecord({ ...original, url: 'https://backup.test/blocker', title: 'Blocker' });
  const first = state.backend.send({ type: 'REGENERATE_PAGE_SUMMARY', requestId: 'first-summary', url: 'https://backup.test/blocker' });
  await waitFor(() => bodies.length === 1, 'preceding summary');
  const second = state.backend.send({ type: 'REGENERATE_PAGE_SUMMARY', requestId: 'queued-summary', url });
  await tick();
  const replacement = identity === 'same-ID' ? original : { ...original, versionId: undefined, kept: undefined, versions: original.versions.map(version => ({ ...version, versionId: undefined, kept: undefined })) };
  let restored;
  try { await importAll(state.client('import'), v3(replacement)); restored = plain(await state.db.getPageRecord(url)); } finally { gate.resolve(); }
  assert.equal((await first).error, undefined);
  assert.match((await second).error, /restore/);
  assert.equal(bodies.length, 1);
  assert.deepEqual(plain(await state.db.getPageRecord(url)), restored, 'An obsolete summary must not assign new IDs, change Keep flags, or alter the restored content');
});

test('an aborted replacement leaves active model work and its original source usable', async testContext => {
  const gate = deferred(), signals = [];
  const state = await fixture(testContext, { fetch: async (input, options = {}) => {
    const path = new URL(input).pathname;
    if (path === '/api/tags') return Response.json({ models: [{ name: 'chosen-model' }] });
    if (path === '/api/ps') return Response.json({ models: [{ name: 'chosen-model', context_length: 8192 }] });
    if (path === '/api/chat') { signals.push(options.signal); await gate.promise; return Response.json({ message: { content: 'Original completed overview.' } }); }
    throw Error(`Unexpected request ${path}`);
  } });
  await state.db.savePageRecord(original);
  const pending = state.backend.send({ type: 'REGENERATE_PAGE_SUMMARY', requestId: 'failed-restore', url });
  await waitFor(() => signals.length === 1, 'original summary inference');
  const connection = await state.db.openDatabase(), prototype = Object.getPrototypeOf(connection), transaction = prototype.transaction;
  let injected = false;
  prototype.transaction = function (...args) {
    const current = transaction.apply(this, args);
    if (!injected && current.mode === 'readwrite' && current.objectStoreNames.contains('pages')) {
      const store = current.objectStore('pages'), put = store.put.bind(store);
      store.put = value => { const request = put(value); injected = true; request.addEventListener('success', () => current.abort(), { once: true }); return request; };
    }
    return current;
  };
  testContext.after(() => { prototype.transaction = transaction; });
  try {
    const importer = state.client('import');
    for (const line of v3().slice(0, 3)) await importer.next(line);
    await assert.rejects(importer.next(v3()[3]), /abort/i);
    assert.equal(injected, true); assert.equal(signals[0].aborted, false);
  } finally { gate.resolve(); }
  assert.equal((await pending).error, undefined);
  assert.equal((await state.db.getPageRecord(url)).summary, 'Original completed overview.');
});

test('restore aborts delayed legacy identity materialization before it can alter the replacement', async testContext => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts'); testContext.after(async () => (await db.openDatabase()).close());
  const savedWork = await loadSource('src/background/processing/savedWork.ts');
  const gate = deferred(), started = deferred(); let inferenceCalls = 0;
  const summaries = await loadSource('src/background/summaries/index.ts', '', {
    '../storage/manager': { storageManager: { ...db, listPageVersions: async (...args) => { started.resolve(); await gate.promise; return db.listPageVersions(...args); } } },
    '../processing/savedWork': savedWork,
    '../providers/chat': { getChatConfig: async () => ({ model: 'chosen-model' }), callChat: async () => { inferenceCalls++; return { message: { content: 'Obsolete overview.' } }; } }
  }, { chrome: { runtime: backend.runtime } });
  const restore = await loadSource('src/background/manage/restore.ts', '', {
    '../storage/manager': { storageManager: db }, '../processing/savedWork': savedWork,
    '../capture/index': { cancelCaptureJobs: async () => [] }, '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  });
  const legacy = { ...original, versionId: undefined, kept: undefined, versions: original.versions.map(version => ({ ...version, versionId: undefined, kept: undefined })) };
  await db.savePageRecord(legacy);
  const pending = summaries.queuePageSummary(url, new AbortController().signal, true);
  const rejected = assert.rejects(pending, /restore/);
  await started.promise;
  let before;
  try { await restore.restorePage(legacy); before = plain(await db.getPageRecord(url)); }
  finally { gate.resolve(); }
  await rejected; await tick();
  assert.equal(inferenceCalls, 0);
  assert.deepEqual(plain(await db.getPageRecord(url)), before);
});

test('backup transfer leases stop after completion, cancellation, failure and owner disconnect', async testContext => {
  const timers = new Set();
  const backend = providerFixture('http://localhost:11434'); backend.runtime.getPlatformInfo = async () => ({});
  const runtime = await backend.load('src/background/orchestration/index.ts', { setInterval: callback => { timers.add(callback); return callback; }, clearInterval: timer => timers.delete(timer) });
  runtime.orchestrateLifecycle();
  const db = await backend.load('src/shared/db/index.ts'); testContext.after(async () => (await db.openDatabase()).close());
  const { BackupTransfer } = await loadSource('src/ui/shared/backupTransfer.ts', '', {}, { chrome: { runtime: backend.runtime } });
  const exporter = new BackupTransfer('export'); testContext.after(() => exporter.close());
  await exporter.next(); assert.equal(timers.size, 1);
  await exporter.next(); assert.equal(timers.size, 0);
  for (const action of ['cancel', 'failure', 'disconnect']) {
    const importer = new BackupTransfer('import'); testContext.after(() => importer.close());
    await importer.next(v3()[0]); assert.equal(timers.size, 1);
    if (action === 'cancel') await importer.cancel();
    else if (action === 'failure') await assert.rejects(importer.next('{}'), /backup/i);
    else { importer.close(); await tick(); }
    assert.equal(timers.size, 0, action);
  }
});

test('frame and aggregate history guards reject visibly without silently pruning saved snapshots', async () => {
  const { encodePageFrames, validateBackup } = await loadSource('src/shared/backupFrames.ts');
  const text = 'x'.repeat(15 * 1024 * 1024);
  const page = { ...original, text, chunks: [], versions: Array.from({ length: 8 }, (_, index) => ({ text, timestamp: index, chunks: [], versionId: `large-${index}`, kept: true })) };
  assert.throws(() => [...encodePageFrames(page)], /128 MB.*No versions were dropped/);
  assert.equal(page.versions.length, 8);
  assert.throws(() => [...encodePageFrames({ ...original, text: 'x'.repeat(17 * 1024 * 1024) })], /16 MB/);
  let frame = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (frame === 0) controller.enqueue(new TextEncoder().encode(v3()[0] + '\n'));
    else if (frame === 1) controller.enqueue(new TextEncoder().encode(encode({ type: 'page', page: { url, title: 'large', text, chunks: [] }, versionCount: 8 }) + '\n'));
    else if (frame <= 9) controller.enqueue(new TextEncoder().encode(encode({ type: 'version', url, index: frame - 2, version: { text, timestamp: frame, chunks: [] } }) + '\n'));
    else controller.close();
    frame++;
  } });
  await assert.rejects(validateBackup(stream), /128 MB/);
  assert.equal(stream.locked, false);
});
