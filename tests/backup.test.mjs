import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain, waitFor, chromeFixture, automaticAiEnabled } from './helpers.mjs';

const header = '{"format":"web-recall","schemaVersion":2}\n';
const trailer = count => `{"type":"end","pages":${count}}\n`;
const line = page => JSON.stringify({ type: 'page', page }) + '\n';
const page = { url: 'https://backup.test/article', title: 'Saved article', text: 'Original passage', timestamp: 10, manual: true, chunks: [{ text: 'Original passage', embedding: [0.25, 0.75], embeddingKey: 'original-model' }], createdAt: 5, updatedAt: 10 };
const codec = () => loadSource('src/shared/backup.ts', '', {}, { TextEncoder });

async function captureRestoreFixture(t, { beforeQueue = async () => {}, afterLookup = async () => {}, shouldCapture = async () => true, embed = async () => [[1, 0]] } = {}) {
  const source = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(async () => (await source.openDatabase()).close());
  const processor = await loadSource('src/background/capture/processor.ts', '', {
    '../processing/automaticAi': automaticAiEnabled,
    '../summaries/index': { queuePageSummary: async () => false },
    '../storage/manager': { storageManager: source }, '../storage/index': { whenStorageReady: async () => {} },
    '../embeddings/index': { getEmbeddingConfig: () => ({}), embedPayloadChunks: embed },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  }, { console: { info() {} } });
  const processing = await loadSource('src/background/processing/index.ts', '', { '../storage/manager': { storageManager: source } }, { chrome: chromeFixture });
  let listener;
  const capture = await loadSource('src/background/capture/index.ts', '', {
    './processor': processor,
    '../processing/index': { ...processing,
      markQueued: async (...args) => { await beforeQueue(...args); return processing.markQueued(...args); },
      getProcessingEntryByUrl: async url => { const entry = await processing.getProcessingEntryByUrl(url); await afterLookup(url); return entry; }
    },
    '../settings/index': { shouldCaptureUrl: shouldCapture, getCachedSettingsSnapshot: () => ({}) }, '../../shared/logger/index': { log: async () => {} }
  }, { console: { info() {} }, chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } } });
  const queue = capture.createCaptureQueue();
  queue.bindRuntimeListener();
  await queue.ready;
  const api = await loadSource('src/background/manage/index.ts', '', {
    '../storage/manager': { storageManager: source }, '../capture/index': capture,
    '../embeddings/index': { getEmbeddingConfig: () => ({}) }, '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  }, { TextEncoder });
  const send = message => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`No response to ${message.type}`)), 5000);
    listener(message, {}, response => { clearTimeout(timer); resolve(response); });
  });
  return { source, queue, api, send };
}

test('malformed supplied backup fields fail preflight without replacing saved content', async t => {
  const source = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(async () => (await source.openDatabase()).close());
  await source.savePageRecord(page);
  const api = await loadSource('src/background/manage/index.ts', '', {
    '../storage/manager': { storageManager: source }, '../capture/index': { cancelCaptureJobs: async () => [] },
    '../embeddings/index': { getEmbeddingConfig: () => ({}) }, '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  }, { TextEncoder });
  const backup = await codec();
  for (const invalid of [
    { text: 42 }, { chunks: {} }, { versions: 'invalid' }, { title: null }, { manual: 'false' }, { timestamp: '10' },
    { chunks: [{ text: 42, embedding: [] }] }, { chunks: [{ text: 'X', embedding: 'invalid' }] },
    { chunks: [{ text: 'X', embedding: [], embeddingKey: 42 }] },
    { versions: [{ text: 42, chunks: [] }] }, { versions: [{ text: 'X', chunks: 'invalid' }] },
    { versions: [{ text: 'X', chunks: [{ text: 'X', embedding: {} }] }] }
  ]) {
    const encoded = line({ ...page, ...invalid });
    await assert.rejects(async () => { for await (const _record of backup.readBackupPages(new Blob([header, encoded, trailer(1)]).stream())) {} }, /backup|field|invalid/i);
    await assert.rejects(api.importBackupPage(encoded), /backup|field|invalid/i);
    const saved = await source.getPageRecord(page.url);
    assert.equal(saved.text, page.text);
    assert.deepEqual(plain(saved.chunks), page.chunks);
  }
  const empty = { ...page, text: '', chunks: [], versions: [{ timestamp: 1, text: '', chunks: [] }] };
  await api.importBackupPage(line(empty));
  assert.equal((await source.getPageRecord(page.url)).text, '');
  assert.deepEqual(plain((await source.getPageRecord(page.url)).chunks), []);
});

test('restoring backup or legacy JSON cancels active and queued captures without losing restored data', async t => {
  for (const format of ['backup', 'legacy']) {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const { source, queue, api } = await captureRestoreFixture(t, { embed: async () => { started(); await gate; return [[1, 0]]; } });
    const live = { url: page.url, title: 'Live', text: 'Live content', chunks: ['Live content'], timestamp: 20 };
    await queue.enqueue(live); await ready;
    await queue.enqueue({ ...live, text: 'Queued content', chunks: ['Queued content'], timestamp: 30 });
    if (format === 'backup') await api.importBackupPage(line(page));
    else await api.importManagePages({ schemaVersion: 1, pages: [page] });
    const pending = await source.getProcessingEntry(page.url);
    release();
    await waitFor(() => !queue.isProcessing(), 'cancelled capture to finish');
    assert.equal(pending, undefined, `${format}: old jobs must not survive restore`);
    assert.equal(queue.peekQueue().length, 0);
    assert.equal((await source.getPageRecord(page.url)).text, page.text);
    assert.deepEqual(plain((await source.getPageRecord(page.url)).chunks), page.chunks);
  }
});

test('restore and deletion cancel capture requests still waiting behind another enqueue, but accept later captures', async t => {
  for (const action of ['backup', 'legacy', 'delete']) {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const precedingUrl = 'https://backup.test/preceding';
    const { source, queue, api } = await captureRestoreFixture(t, { beforeQueue: async payload => {
      if (payload.url === precedingUrl) { started(); await gate; }
    } });
    const preceding = { url: precedingUrl, title: 'Unrelated', timestamp: 1, text: 'Unrelated content', chunks: ['Unrelated content'] };
    const first = queue.enqueue(preceding); await ready;
    const pending = queue.enqueue({ ...preceding, url: page.url, text: 'Old pending capture', chunks: ['Old pending capture'] });
    const maintenance = action === 'backup' ? api.importBackupPage(line(page))
      : action === 'legacy' ? api.importManagePages({ schemaVersion: 1, pages: [page] }) : api.deleteManagePages([page.url]);
    release();
    await Promise.all([first, pending, maintenance]);
    await waitFor(() => !queue.isProcessing() && !queue.peekQueue().length, 'pre-maintenance captures to drain');
    assert.equal((await source.getPageRecord(page.url))?.text, action === 'delete' ? undefined : page.text, action);
    assert.equal(await source.getProcessingEntry(page.url), undefined);
    assert.equal((await source.getPageRecord(precedingUrl)).text, preceding.text);
    const fresh = { ...preceding, url: page.url, text: 'New capture after maintenance', chunks: ['New capture after maintenance'], timestamp: 50 };
    await queue.enqueue(fresh);
    await waitFor(() => !queue.isProcessing() && !queue.peekQueue().length, 'new capture to finish');
    assert.equal((await source.getPageRecord(page.url)).text, fresh.text);
    assert.equal((await source.getPageRecord(page.url)).timestamp, 50);
  }
});

test('backup restore replaces destination metadata, clearing omitted fields while preserving explicit values', async t => {
  const source = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(async () => (await source.openDatabase()).close());
  const api = await loadSource('src/background/manage/index.ts', '', {
    '../storage/manager': { storageManager: source }, '../capture/index': { cancelCaptureJobs: async () => [] },
    '../embeddings/index': { getEmbeddingConfig: () => ({}) }, '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  }, { TextEncoder });
  const explicit = { summary: 'Backup summary', versions: [{ timestamp: 2, text: 'Backup history', chunks: [] }], lastEmbeddedAt: 7 };
  for (const metadata of [{}, { title: '', timestamp: 0, summary: '', versions: [], lastEmbeddedAt: 0 }, explicit]) {
    await source.savePageRecord({ ...page, text: 'Destination text', createdAt: 999, summary: 'Stale destination summary', versions: [{ timestamp: 1, text: 'Stale history', chunks: [] }], lastEmbeddedAt: 123 });
    await api.importBackupPage(line({ ...page, ...metadata }));
    const restored = await source.getPageRecord(page.url);
    assert.deepEqual(plain({ ...restored, updatedAt: 0 }), { ...page, ...metadata, updatedAt: 0 });
    assert.deepEqual(plain(JSON.parse((await api.exportBackupPage()).line).page), plain(restored));
  }
  await source.savePageRecord({ ...page, text: 'Ordinary capture update' });
  const captured = await source.getPageRecord(page.url);
  assert.equal(captured.summary, undefined, 'a changed capture invalidates the restored summary, not the preserved backup metadata');
  assert.equal(captured.lastEmbeddedAt, explicit.lastEmbeddedAt);
  assert.deepEqual(plain(captured.versions), explicit.versions);
});

test('restore fences runtime capture and retry requests whose asynchronous admission is still pending', async t => {
  for (const type of ['SAVE_PAGE', 'RETRY_PROCESSING']) {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const pendingCheck = async () => { started(); await gate; return true; };
    const { source, queue, api, send } = await captureRestoreFixture(t, {
      shouldCapture: type === 'SAVE_PAGE' ? pendingCheck : async () => true,
      afterLookup: type === 'RETRY_PROCESSING' ? pendingCheck : async () => {}
    });
    const old = { url: page.url, title: 'Old', text: 'Pre-restore content', chunks: ['Pre-restore content'], timestamp: 1, manual: true };
    if (type === 'RETRY_PROCESSING') await source.updateProcessingEntry({ url: page.url, title: old.title, status: 'failed', attempts: 1, createdAt: 1, updatedAt: 1, lastAttemptAt: 1, payload: old }, true);
    const pending = send({ ...old, type });
    await ready;
    const restored = api.importBackupPage(line(page));
    release();
    await Promise.all([pending, restored]);
    await waitFor(() => !queue.isProcessing() && !queue.peekQueue().length, 'runtime capture admission to finish');
    assert.equal((await source.getPageRecord(page.url)).text, page.text, type);
    assert.deepEqual(plain((await source.getPageRecord(page.url)).chunks), page.chunks);
    assert.equal(await source.getProcessingEntry(page.url), undefined);
  }
});

test('streamed backups round-trip a library beyond legacy file, page and record limits', async t => {
  const source = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(async () => (await source.openDatabase()).close());
  const large = { ...page, text: 'é'.repeat(600_000), chunks: [{ text: 'Historical passage', embedding: Array(4097).fill(0.25), embeddingKey: 'historical-model' }], versions: [{ timestamp: 1, text: 'v'.repeat(500_001), chunks: [] }] };
  const urls = Array.from({ length: 8 }, (_, index) => `${page.url}/${index}`);
  for (const url of urls) await source.savePageRecord({ ...large, url });
  const api = await loadSource('src/background/manage/index.ts', '', {
    '../storage/manager': { storageManager: source }, '../capture/index': { cancelCaptureJobs: async () => [] },
    '../embeddings/index': { getEmbeddingConfig: () => ({}) }, '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  }, { TextEncoder });
  const backup = await codec();
  const exported = [];
  let afterUrl;
  while (true) {
    const next = await api.exportBackupPage(afterUrl);
    if (!next.line) break;
    exported.push(next.line);
    afterUrl = next.url;
  }
  assert.deepEqual(exported.map(encoded => JSON.parse(encoded).page.url), urls);
  const parts = [header, ...exported.map(encoded => encoded + '\n'), trailer(8)];
  const file = new Blob(parts);
  assert.ok(file.size > 10 * 1024 * 1024);
  let count = 0;
  for await (const encoded of backup.readBackupPages(file.stream())) {
    const restored = backup.decodeBackupPage(encoded);
    assert.equal(restored.text, large.text);
    assert.deepEqual(plain(restored.chunks), large.chunks);
    assert.deepEqual(plain(restored.versions), large.versions);
    count++;
  }
  assert.equal(count, 8);
  await source.deletePages(urls);
  for await (const encoded of backup.readBackupPages(file.stream())) await api.importBackupPage(encoded);
  for (const url of urls) {
    const restored = await source.getPageRecord(url);
    assert.equal(restored.text, large.text);
    assert.equal(restored.timestamp, 10);
    assert.equal(restored.createdAt, 5);
    assert.deepEqual(plain(restored.chunks), large.chunks);
  }
  const many = new Blob([header, ...Array.from({ length: 2001 }, (_, index) => line({ ...page, url: `${page.url}/${index}` })), trailer(2001)]);
  let pages = 0;
  for await (const _encoded of backup.readBackupPages(many.stream())) pages++;
  assert.equal(pages, 2001);
});

test('backup decoding validates framing, UTF-8, URLs and vectors regardless of the backup label', async () => {
  const backup = await codec();
  for (const [contents, diagnostic] of [
    [header + line(page), /incomplete/i],
    [header + line(page) + trailer(2), /count/i],
    [header.replace(':2', ':99') + trailer(0), /format/i],
    [header + line({ ...page, url: 'javascript:alert(1)' }) + trailer(1), /http/i],
    [header + line({ ...page, chunks: [{ text: 'Invalid', embedding: ['not-a-number'] }] }) + trailer(1), /non-numeric/i],
    [header + trailer(0) + line(page), /after/i]
  ]) {
    await assert.rejects(async () => { for await (const _encoded of backup.readBackupPages(new Blob([contents]).stream())) {} }, diagnostic);
  }
  const unicode = new TextEncoder().encode(header + line({ ...page, text: '猫' }) + trailer(1));
  let position = 0;
  const stream = new ReadableStream({ pull(controller) { if (position < unicode.length) controller.enqueue(unicode.slice(position, ++position)); else controller.close(); } });
  const texts = [];
  for await (const encoded of backup.readBackupPages(stream)) texts.push(backup.decodeBackupPage(encoded).text);
  assert.deepEqual(texts, ['猫']);
  await assert.rejects(async () => { for await (const _encoded of backup.readBackupPages(new Blob([header, new Uint8Array([255]), '\n']).stream())) {} }, /encoded|encoding/i);
});

test('oversized backup records are rejected symmetrically and the stream is released', async () => {
  const backup = await codec();
  const large = { ...page, text: 'x'.repeat(16 * 1024 * 1024) };
  assert.throws(() => backup.encodeBackupPage(large), /record.*16.*MB/i);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(header + line(large))); }, cancel() { cancelled = true; } });
  await assert.rejects(async () => { for await (const _encoded of backup.readBackupPages(stream)) {} }, /record.*16.*MB/i);
  assert.equal(stream.locked, false);
  assert.equal(cancelled, true);
});
