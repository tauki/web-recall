import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFixture } from './provider-fixture.mjs';
import { loadSource, plain, waitFor, tick } from './helpers.mjs';

const record = (url, timestamp = 150) => ({ url, title: `Saved ${url}`, timestamp, manual: true, text: 'Saved evidence.', summary: 'An existing summary.', chunks: [{ text: 'Saved evidence.', embedding: [1, 0] }] });

test('quick exclusion preserves saved data and other policy choices while blocking the site and subdomains even manually', async () => {
  const backend = providerFixture(); await backend.connect();
  const settings = await backend.load('src/background/settings/index.ts');
  await settings.updateSettings({ paused: true, allowlist: ['example.test'], denylist: ['private.test'], theme: 'dark' });
  const db = await backend.load('src/shared/db/index.ts'); const page = record('https://example.test/article');
  await db.savePageRecord(page); const before = plain(await db.getPageRecord(page.url));
  backend.setActiveTab('https://EXAMPLE.TEST./article');
  const response = await backend.send({ type: 'EXCLUDE_ACTIVE_SITE' });
  assert.equal(response.domain, 'example.test');
  assert.equal(response.settings.paused, true); assert.equal(response.settings.theme, 'dark');
  assert.deepEqual(plain(response.settings.allowlist), ['example.test']);
  assert.deepEqual(plain(response.settings.denylist), ['private.test', 'example.test']);
  assert.deepEqual(plain(await db.getPageRecord(page.url)), before);
  for (const url of ['https://example.test/article', 'https://sub.example.test/', 'https://example.test./']) assert.equal(await settings.shouldCaptureUrl(url, { ignorePaused: true }), false);
  assert.equal(backend.requests.length, 0);
});

test('concurrent quick exclusions and pause toggles do not lose independent settings choices', async () => {
  const backend = providerFixture();
  const settings = await backend.load('src/background/settings/index.ts');
  await Promise.all([settings.excludeCaptureSite('https://one.test'), settings.excludeCaptureSite('https://two.test'), settings.updateSettings({ theme: 'dark' })]);
  await Promise.all([settings.toggleCapturePause(), settings.toggleCapturePause()]);
  const saved = await settings.getSettings();
  assert.deepEqual(plain(saved.denylist).sort(), ['one.test', 'two.test']);
  assert.equal(saved.theme, 'dark'); assert.equal(saved.paused, true); assert.equal(saved.captureSetupComplete, true);
});

test('failed quick exclusion never changes the saved capture policy or claims success', async () => {
  const backend = providerFixture(); await backend.connect();
  const settings = await backend.load('src/background/settings/index.ts'), before = plain(await settings.getSettings());
  backend.failNextWrite('betaSettings');
  const result = await backend.send({ type: 'EXCLUDE_ACTIVE_SITE' });
  assert.match(result.error, /Storage write failed/);
  assert.deepEqual(plain(await settings.getSettings()), before);
  backend.setActiveTab('chrome://extensions');
  assert.match((await backend.send({ type: 'EXCLUDE_ACTIVE_SITE' })).error, /regular web page/);
});

test('forget preview covers the whole library with exact site boundaries and capture-date intersection', async () => {
  const backend = providerFixture(); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  const expected = Array.from({ length: 31 }, (_, index) => `https://${index % 2 ? 'sub.' : ''}example.test/page-${index}`);
  for (const url of expected) await db.savePageRecord(record(url));
  for (const [url, time] of [['https://notexample.test/page', 150], ['https://example.test/older', 99], ['https://example.test/boundary', 200], ['https://unrelated.test/page', 150]]) await db.savePageRecord(record(url, time));
  const response = await backend.send({ type: 'PREVIEW_FORGET_PAGES', filters: { domain: 'example.test', from: 100, before: 200 } });
  assert.equal(response.versionCount, expected.length); assert.deepEqual(plain(response.selection.map(page => page.url)).sort(), expected.sort());
  assert.equal((await db.listAllPages()).length, 35); assert.equal(backend.requests.length, 0);
});

test('forget deletes only reviewed URLs that still match, preserving new or recaptured out-of-scope pages and jobs', async () => {
  const backend = providerFixture(); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  const first = record('https://example.test/first'), changed = record('https://example.test/changed');
  await db.savePageRecord(first); await db.savePageRecord(changed);
  const filters = { domain: 'example.test', from: 100, before: 200 };
  const preview = await backend.send({ type: 'PREVIEW_FORGET_PAGES', filters });
  await db.savePageRecord({ ...changed, timestamp: 300 });
  const job = { url: changed.url, title: changed.title, status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, lastAttemptAt: 1, payload: { ...changed, timestamp: 300, chunks: ['Saved evidence.'], captureId: 'newer-capture' } };
  await db.appendProcessing(job);
  const added = record('https://example.test/added-after-review'); await db.savePageRecord(added);
  const response = await backend.send({ type: 'FORGET_PAGES', filters, selection: preview.selection });
  assert.deepEqual(plain(response), { pages: 1, versions: 1 }); assert.equal(await db.getPageRecord(first.url), undefined);
  assert.equal((await db.getPageRecord(changed.url)).timestamp, 300);
  assert.deepEqual(plain(await db.getProcessingEntry(changed.url)), job);
  assert.ok(await db.getPageRecord(added.url));
});

test('forget rejects missing or invalid scope and an empty reviewed selection never means the whole library', async () => {
  const backend = providerFixture(); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'), page = record('https://example.test/page'); await db.savePageRecord(page);
  for (const filters of [undefined, {}, { domain: '.' }, { from: 200, before: 100 }]) {
    assert.ok((await backend.send({ type: 'PREVIEW_FORGET_PAGES', filters })).error);
    assert.ok((await backend.send({ type: 'FORGET_PAGES', filters, urls: [page.url] })).error);
  }
  assert.deepEqual(plain(await backend.send({ type: 'FORGET_PAGES', filters: { domain: 'example.test' }, selection: [] })), { pages: 0, versions: 0 });
  assert.ok(await db.getPageRecord(page.url));
});

test('capture controls reject page-origin messages before changing policy or saved data', async () => {
  const backend = providerFixture(); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'), page = record('https://example.test/page'); await db.savePageRecord(page);
  const beforeSettings = plain((await backend.send({ type: 'GET_SETTINGS' })).settings), beforePage = plain(await db.getPageRecord(page.url));
  const sender = { id: backend.runtime.id, url: page.url };
  for (const type of ['EXCLUDE_ACTIVE_SITE', 'TOGGLE_CAPTURE_PAUSE', 'PREVIEW_FORGET_PAGES', 'FORGET_PAGES']) assert.match((await backend.send({ type, filters: { domain: 'example.test' }, urls: [page.url] }, sender)).error, /extension pages/);
  assert.deepEqual(plain(await db.getPageRecord(page.url)), beforePage); assert.deepEqual(plain((await backend.send({ type: 'GET_SETTINGS' })).settings), beforeSettings);
});

test('scoped forgetting aborts an in-flight matching capture and cannot restore its saved text', async t => {
  const backend = providerFixture(), db = await backend.load('src/shared/db/index.ts');
  const processing = await backend.load('src/background/processing/index.ts');
  const capture = await loadSource('src/background/capture/index.ts', '', {
    './processor': { processCapturePayload: async () => {} },
    '../processing/index': processing,
    '../settings/index': { shouldCaptureUrl: async () => true, getCachedSettingsSnapshot: () => ({}) },
    '../../shared/logger/index': { log: async () => {} }
  }, { indexedDB: undefined, chrome: { runtime: { sendMessage() {} } } });
  let signal;
  const queue = capture.createCaptureQueue((_payload, _continue, active) => new Promise((resolve, reject) => { signal = active; active.addEventListener('abort', () => reject(active.reason), { once: true }); }));
  await queue.ready;
  const page = record('https://example.test/active');
  await queue.enqueue({ ...page, chunks: ['Saved evidence.'] }); await waitFor(() => Boolean(signal), 'capture model request');
  t.after(async () => { await capture.cancelCaptureJobs([page.url]); await tick(); });
  const manage = await loadSource('src/background/manage/index.ts', '', {
    '../capture/index': capture, '../storage/manager': { storageManager: db },
    '../embeddings/index': { getEmbeddingConfig: () => ({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' }) },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }, './recents': { invalidateRecentPages: async () => {} }
  });
  const filters = { domain: 'example.test', from: 100, before: 200 };
  const review = await manage.previewForgetPages(filters);
  assert.deepEqual(plain(await manage.forgetManagePages(review.selection, filters)), { pages: 1, versions: 1 });
  await waitFor(() => !queue.isProcessing(), 'cancelled capture');
  assert.equal(signal.aborted, true); assert.equal(await db.getPageRecord(page.url), undefined); assert.equal(await db.getProcessingEntry(page.url), undefined);
});
