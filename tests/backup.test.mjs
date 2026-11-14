import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain } from './helpers.mjs';

const header = '{"format":"web-recall","schemaVersion":2}\n';
const trailer = count => `{"type":"end","pages":${count}}\n`;
const line = page => JSON.stringify({ type: 'page', page }) + '\n';
const page = { url: 'https://backup.test/article', title: 'Saved article', text: 'Original passage', timestamp: 10, manual: true, chunks: [{ text: 'Original passage', embedding: [0.25, 0.75], embeddingKey: 'original-model' }], createdAt: 5, updatedAt: 10 };
const codec = () => loadSource('src/shared/backup.ts', '', {}, { TextEncoder });

test('streamed backups round-trip a library beyond legacy file, page and record limits', async t => {
  const source = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(async () => (await source.openDatabase()).close());
  const large = { ...page, text: 'é'.repeat(600_000), chunks: [{ text: 'Historical passage', embedding: Array(4097).fill(0.25), embeddingKey: 'historical-model' }], versions: [{ timestamp: 1, text: 'v'.repeat(500_001), chunks: [] }] };
  const urls = Array.from({ length: 8 }, (_, index) => `${page.url}/${index}`);
  for (const url of urls) await source.savePageRecord({ ...large, url });
  const api = await loadSource('src/background/manage/index.ts', '', {
    '../storage/manager': { storageManager: source }, '../capture/index': { cancelCaptureJobs() {} },
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
