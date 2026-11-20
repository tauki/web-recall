import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadSource, tick, waitFor } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { recallFixture, recallPage } from './recall-fixture.mjs';

const { DEFAULT_SETTINGS, DEFAULT_EMBEDDING_CONFIG } = await loadSource('src/shared/config/index.ts');
const pages = [{ url: 'https://example.test/cats', title: 'Cats', timestamp: Date.now(), manual: false, embeddingStatus: 'Present', chunkCount: 3 }];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function ui(view, overrides = {}, backend, context = {}) {
  const dom = new JSDOM(`<div id="app-root" data-view="${view}"></div>`, { url: 'https://extension.test/' });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  const listeners = [], requests = [], polls = [];
  let pendingMessages = 0;
  const ports = [];
  const responses = {
    GET_SETTINGS: () => ({ settings: { ...DEFAULT_SETTINGS, activeProviderId: 'ollama', captureSetupComplete: true, recallSetupComplete: true, automaticAi: true } }),
    GET_EMBEDDING_CONFIG: () => ({ config: { ...DEFAULT_EMBEDDING_CONFIG } }),
    GET_PROVIDERS: () => ({ providers: [] }),
    GET_PROVIDER_CONFIG: () => ({ baseUrl: 'http://localhost:11434' }),
    GET_BROWSER_EMBED_STATUS: () => ({ status: { ready: false, state: 'idle', runtimeAvailable: true } }),
    GET_PROCESSING: () => ({ queue: [] }),
    GET_BACKUP_RESTORE_MODE: () => ({ recover: false }),
    GET_PAGE_LIST: () => ({ pages }),
    GET_RECENT_PAGES: () => ({ ...responses.GET_PAGE_LIST(), nextCursor: null }),
    ...overrides
  };
  const chrome = {
    permissions: { allowed: true, requests: [], async request(request) { this.requests.push(request); return this.allowed; } },
    runtime: {
      connect(options) { const port = backend.runtime.connect(options); ports.push(port); return port; },
      getURL: path => 'https://extension.test/' + path,
      onMessage: { addListener: listener => listeners.push(listener), removeListener: listener => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); } },
      sendMessage(message, callback) {
        requests.push(message);
        pendingMessages++;
        const failed = error => {
          chrome.runtime.lastError = { message: error.message };
          try { callback(); } finally { delete chrome.runtime.lastError; }
        };
        let result;
        try { result = backend ? backend.send(message) : responses[message.type]?.(message) ?? {}; }
        catch (error) { failed(error); pendingMessages--; return; }
        Promise.resolve(result).then(callback, failed).finally(() => { pendingMessages--; });
      }
    },
    tabs: { create() {} }
  };
  await loadSource(`src/ui/${view}/index.ts`, '', {
    '../shared/polling': { startPolling: task => { polls.push(task); void task(); return () => {}; } }
  }, {
    window, document: window.document, HTMLElement: window.HTMLElement, TextEncoder,
    chrome, navigator: window.navigator, ...context
  });
  await tick(); await tick();
  const q = selector => window.document.querySelector(selector);
  const change = (selector, value) => { q(selector).value = value; q(selector).dispatchEvent(new window.Event('change', { bubbles: true })); };
  return { window, q, change, requests, listenerCount: () => listeners.length, permissions: chrome.permissions, poll: async () => { polls.forEach(task => task()); await tick(); await tick(); }, emit: message => listeners.forEach(f => f(message)), close: () => { for (const port of ports) port.disconnect(); window.close(); },
    settle: () => waitFor(() => pendingMessages === 0, 'UI requests to finish'),
    submit: selector => q(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) };
}

async function openModels(fixture) {
  fixture.q('a[data-view="settings"]').click();
  const models = fixture.q('#settings-models');
  if (!models.open) await new Promise(resolve => { models.addEventListener('toggle', resolve, { once: true }); models.open = true; });
  await tick();
}

async function openStorage(fixture) {
  fixture.q('a[data-view="settings"]').click();
  const disclosure = fixture.q('#settings-storage');
  if (!disclosure.open) await new Promise(resolve => {
    disclosure.addEventListener('toggle', resolve, { once: true });
    disclosure.querySelector('summary').click();
  });
  await tick();
}

test('Memory never claims zero pages before a successful library read, even if the queue responds first', async testContext => {
  const first = deferred(), queue = deferred();
  let result = first.promise;
  const fixture = await ui('manage', { GET_PAGE_LIST: () => result, GET_PROCESSING: () => queue.promise });
  testContext.after(fixture.close);
  const count = fixture.q('#manage-count'), rows = fixture.q('#manage-rows'), status = fixture.q('#manage-status');
  queue.resolve({ queue: [] }); await tick();
  assert.match(count.textContent, /loading/i);
  assert.doesNotMatch(rows.textContent, /No saved pages yet/);
  first.resolve({ error: 'The previously opened local library is missing. Restore a backup.' }); await fixture.settle();
  assert.match(status.textContent, /library is missing.*restore a backup/i);
  const recovery = fixture.q('#manage-library-recovery');
  assert.equal(recovery.hidden, false);
  assert.match(recovery.querySelector('a').href, /\/sidepanel\/index\.html#settings-restore$/u);
  assert.doesNotMatch(count.textContent, /0 pages/);
  assert.doesNotMatch(rows.textContent, /No saved pages yet/);
  result = Promise.resolve({ pages: [] });
  fixture.q('#manage-refresh').click(); await fixture.settle();
  assert.equal(count.textContent, '0 pages');
  assert.match(rows.textContent, /No saved pages yet/);
  assert.equal(status.textContent, '');
  assert.equal(recovery.hidden, true);
  result = Promise.resolve({ error: 'Storage is unavailable' });
  fixture.q('#manage-refresh').click(); await fixture.settle();
  assert.match(status.textContent, /Storage is unavailable/);
  assert.equal(recovery.hidden, true, 'An unrelated storage failure must not suggest recovery');
  assert.doesNotMatch(count.textContent, /0 pages/);
  assert.doesNotMatch(rows.textContent, /No saved pages yet/);
});

test('folder backup settings autosave ordered changes, and Back up now uses the committed count', async testContext => {
  const firstWrite = deferred();
  const writes = [], manual = [];
  let settings = { automatic: false, keep: 3 };
  let folder = '/test-backups';
  const fixture = await ui('sidepanel', {
    GET_FOLDER_BACKUP: ({ probe }) => ({ ...settings, ...(probe ? { folder } : {}) }),
    SET_FOLDER_BACKUP: async ({ automatic, keep }) => {
      writes.push({ automatic, keep });
      if (writes.length === 1) await firstWrite.promise;
      settings = { automatic, keep };
      return { ok: true };
    },
    RUN_FOLDER_BACKUP: () => { manual.push({ ...settings }); return {}; }
  });
  testContext.after(fixture.close);
  await openStorage(fixture);
  const disclosure = fixture.q('#manage-folder-backup');
  const auto = fixture.q('#manage-backup-automatic');
  const keep = fixture.q('#manage-backup-keep');
  disclosure.open = true;
  await waitFor(() => !keep.disabled, 'folder settings to load');
  assert.doesNotMatch(disclosure.textContent, /Save settings/);
  keep.value = '7';
  keep.dispatchEvent(new fixture.window.Event('input', { bubbles: true }));
  assert.equal(writes.length, 0, 'An unfinished number edit must not apply retention');
  fixture.change('#manage-backup-keep', '7');
  auto.click();
  await waitFor(() => writes.length === 1, 'retention to save first');
  assert.deepEqual(writes[0], { automatic: false, keep: 7 });
  assert.equal(manual.length, 0);
  firstWrite.resolve();
  await waitFor(() => writes.length === 2, 'the enabled toggle to save without another click');
  assert.deepEqual(writes[1], { automatic: true, keep: 7 });
  await fixture.settle();

  folder = undefined;
  auto.click();
  await waitFor(() => !settings.automatic, 'the toggle to turn off without connecting to the companion');
  assert.equal(fixture.permissions.requests.length, 1);
  fixture.change('#manage-backup-keep', '31');
  assert.equal(keep.value, '7');
  assert.equal(writes.length, 3);
  fixture.change('#manage-backup-keep', '5');
  fixture.q('#manage-backup-run').click();
  await waitFor(() => manual.length === 1, 'manual backup to wait for the latest retention');
  assert.deepEqual(manual[0], { automatic: false, keep: 5 });
  await fixture.settle();
  auto.click();
  await waitFor(() => !auto.checked && /Choose a folder/.test(fixture.q('#manage-backup-report').textContent), 'unavailable folder to revert the setting');
  assert.deepEqual(settings, { automatic: false, keep: 5 });
});

test('a malformed Memory reply leaves the last readable library on screen and shows an error', async testContext => {
  let result = { pages };
  const fixture = await ui('manage', { GET_PAGE_LIST: () => result });
  testContext.after(fixture.close);
  await fixture.settle();
  const rows = fixture.q('#manage-rows');
  for (const page of pages) assert.ok(rows.textContent.includes(page.title));
  result = { pages: [null] };
  fixture.q('#manage-refresh').click(); await fixture.settle();
  for (const page of pages) assert.ok(rows.textContent.includes(page.title), 'A failed refresh must not hide previously read evidence');
  assert.match(fixture.q('#manage-status').textContent, /failed to load pages/i);
});

test('Memory Backups opens Settings and reads storage only on demand', async testContext => {
  let estimates = 0;
  const fixture = await ui('sidepanel', {}, undefined, { navigator: { storage: { estimate: async () => { estimates++; return { usage: 134217728, quota: 9999999999 }; } } } });
  testContext.after(fixture.close);
  assert.equal(estimates, 0, 'Loading saved pages must not start a hidden storage check');
  assert.ok(fixture.q('#settings-storage-summary').textContent.trim(), 'Storage and backups is described before it opens');
  fixture.q('a[data-view="manage"]').click();
  const memory = fixture.q('#beta-view-manage');
  assert.equal(memory.querySelector('#manage-import'), null, 'Memory Manager must not duplicate the file picker');
  [...memory.querySelectorAll('a')].find(link => link.textContent === 'Backups').click();
  await waitFor(() => estimates === 1, 'Settings storage estimate');
  assert.equal(fixture.q('#beta-view-settings').hidden, false);
  assert.equal(fixture.q('#settings-storage').open, true);
  assert.equal(estimates, 1);
  assert.match(fixture.q('#manage-storage-usage').textContent, /128 MiB/);
  assert.match(fixture.q('#settings-storage').textContent, /downloaded browser models/);
  assert.match(fixture.q('#settings-storage').textContent, /Clearing Chrome history won’t delete saved pages/);
});

test('missing library shortcuts lead directly to the restore picker without starting a transfer', async testContext => {
  const error = { error: 'The previously activated saved library is missing.' };
  const fixture = await ui('sidepanel', { GET_PAGE_LIST: () => error, GET_RECENT_PAGES: () => error });
  testContext.after(fixture.close);
  const searchLink = fixture.q('#beta-library-recovery a');
  assert.equal(searchLink.parentElement.hidden, false);
  searchLink.click();
  const picker = fixture.q('input[type=file]');
  assert.equal(fixture.window.document.activeElement, picker);
  fixture.q('a[data-view="manage"]').click();
  await fixture.settle();
  const memoryLink = fixture.q('#manage-library-recovery a');
  assert.equal(memoryLink.parentElement.hidden, false);
  memoryLink.click();
  assert.equal(fixture.q('#settings-storage').open, true);
  assert.equal(fixture.window.document.activeElement, picker);
  assert.ok(!fixture.requests.some(message => message.type === 'GET_BACKUP_RESTORE_MODE'));
});

test('Stop releases Restore while the library check is pending and ignores a late reply', async testContext => {
  const check = deferred();
  let fileReads = 0;
  const fixture = await ui('sidepanel', { GET_BACKUP_RESTORE_MODE: () => check.promise });
  testContext.after(fixture.close);
  await openStorage(fixture);
  const input = fixture.q('input[type=file]');
  Object.defineProperty(input, 'files', { value: [{ name: 'backup.json', size: 2, text: async () => { fileReads++; return '[]'; } }] });
  input.dispatchEvent(new fixture.window.Event('change'));
  assert.equal(input.disabled, true);
  fixture.q('#settings-transfer-stop').click();
  await waitFor(() => !input.disabled, 'Stop to release Restore before the check returns');
  assert.match(fixture.q('#settings-backup-status').textContent, /Import stopped/);
  check.resolve({ recover: true });
  await fixture.settle();
  assert.equal(fileReads, 0);
});

test('storage errors and missing estimates never become zero or replace Memory operation status; refresh recovers', async testContext => {
  for (const failure of [undefined, {}, { estimate: async () => ({ quota: 200 }) }, { estimate: async () => ({ usage: NaN }) }, { estimate: async () => ({ usage: -1 }) }, { estimate: async () => { throw Error('Unavailable'); } }]) {
    const navigator = { storage: failure };
    const fixture = await ui('sidepanel', {}, undefined, { navigator }); testContext.after(fixture.close);
    fixture.q('#settings-backup-status').textContent = 'Backup saved.';
    await openStorage(fixture);
    assert.match(fixture.q('#manage-storage-usage').textContent, /unavailable/i);
    assert.doesNotMatch(fixture.q('#manage-storage-usage').textContent, /0 B|NaN/);
    assert.equal(fixture.q('#settings-backup-status').textContent, 'Backup saved.');
    assert.equal(fixture.q('#manage-storage-refresh').disabled, false);
    navigator.storage = { estimate: async () => ({ usage: 0 }) };
    fixture.q('#manage-storage-refresh').click(); await tick();
    assert.match(fixture.q('#manage-storage-usage').textContent, /0 B/);
  }
});

test('storage refresh follows deletion and ignores an older estimate that finishes afterward', async testContext => {
  const first = deferred(); let estimates = 0; let saved = pages;
  const fixture = await ui('sidepanel', {
    GET_PAGE_LIST: () => ({ pages: saved }),
    DELETE_PAGE: () => { saved = []; return { deleted: 1 }; }
  }, undefined, { navigator: { storage: { estimate: () => ++estimates === 1 ? first.promise : Promise.resolve({ usage: 2048 }) } } });
  testContext.after(fixture.close);
  await openStorage(fixture);
  assert.equal(fixture.q('#manage-storage-usage').getAttribute('aria-busy'), 'true');
  fixture.q('a[data-view="manage"]').click(); await fixture.settle();
  fixture.q('#manage-select').click(); fixture.q('#manage-select-all').checked = true; fixture.change('#manage-select-all', '');
  fixture.q('#manage-delete').click(); await fixture.settle(); await tick();
  fixture.q('a[data-view="settings"]').click(); await tick();
  assert.match(fixture.q('#manage-storage-usage').textContent, /2 KiB/);
  first.resolve({ usage: 536870912 }); await tick();
  assert.match(fixture.q('#manage-storage-usage').textContent, /2 KiB/);
  assert.equal(fixture.q('#manage-storage-usage').getAttribute('aria-busy'), 'false');
  assert.equal(fixture.q('#manage-count').textContent, '0 pages');
  fixture.q('#settings-storage').open = false; await tick();
  const before = estimates;
  fixture.window.dispatchEvent(new fixture.window.CustomEvent('wr-memory-changed')); await tick();
  assert.equal(estimates, before, 'Closed storage controls must not poll after library changes');
});

test('storage checks pause when the section or Settings closes, then refresh when shown again', async testContext => {
  let estimates = 0;
  const fixture = await ui('sidepanel', {}, undefined, { navigator: { storage: { estimate: async () => ({ usage: ++estimates * 1024 }) } } });
  testContext.after(fixture.close);
  await openStorage(fixture);
  const storage = fixture.q('#settings-storage');
  storage.open = false; await tick(); await tick();
  const before = estimates;
  fixture.window.dispatchEvent(new fixture.window.CustomEvent('wr-memory-changed')); await tick();
  assert.equal(estimates, before);
  storage.open = true; await waitFor(() => estimates > before, 'fresh estimate after reopening storage settings');
  assert.match(fixture.q('#manage-storage-usage').textContent, /2 KiB/);
  fixture.q('#beta-view-settings .utility-back').click();
  fixture.window.dispatchEvent(new fixture.window.CustomEvent('wr-memory-changed')); await tick();
  assert.equal(estimates, 2);
  fixture.q('a[data-view="settings"]').click(); await fixture.settle(); await tick();
  assert.match(fixture.q('#manage-storage-usage').textContent, /3 KiB/);
});

test('the inline first-run guide follows a real saved capture, unquoted search and successful saved reading before optional AI', async testContext => {
  const backend = await recallFixture(testContext), fixture = await ui('sidepanel', {}, backend); testContext.after(fixture.close); await fixture.settle();
  assert.match(fixture.q('.wr-empty-memory').textContent, /No model setup needed/);
  assert.equal(fixture.q('#beta-optional-ai').hidden, true);
  assert.ok(!fixture.requests.some(message => message.type === 'GET_PROVIDERS'));
  const manual = fixture.q('#beta-keep-manual-capture'), capture = fixture.q('.wr-empty-memory .primary-button');
  manual.focus(); manual.click(); await fixture.settle();
  assert.equal(fixture.q('#beta-capture-setup').hidden, true);
  assert.equal(fixture.window.document.activeElement, capture, 'Choosing manual saving moves focus to Capture current tab');
  capture.click(); await fixture.settle(); await backend.drain();
  assert.equal(fixture.q('#beta-recall-setup').hidden, false); assert.equal(fixture.q('#beta-recall-heading').textContent, 'Find your saved page');
  assert.equal(fixture.window.document.activeElement, fixture.q('#beta-recall-next'), 'Replacing the empty library moves focus to Try a search');
  fixture.q('#beta-recall-next').click(); assert.equal(fixture.window.document.activeElement.id, 'beta-search-input');
  fixture.q('#beta-search-input').value = 'Copper terns'; fixture.submit('#beta-search-form'); await fixture.settle();
  assert.equal(fixture.q('#beta-recall-heading').textContent, 'Read what you saved');
  assert.equal(backend.stored.betaSettings.recallSetupComplete, false);
  fixture.q('#beta-recall-next').click(); await fixture.settle(); await tick();
  assert.equal(fixture.q('.saved-reader-text').textContent, recallPage.text);
  assert.equal(fixture.q('.saved-reader-text mark').textContent, 'Copper terns');
  assert.equal(backend.stored.betaSettings.recallSetupComplete, true); assert.equal(backend.stored.betaSettings.automaticAi, false);
  assert.equal(fixture.q('#beta-recall-setup').hidden, true); assert.equal(fixture.q('#beta-optional-ai').hidden, false);
  assert.equal(backend.requests.length, 0); assert.equal(backend.nativeCalls(), 0);
  fixture.q('#beta-setup-ai').click(); await tick(); await fixture.settle();
  await waitFor(() => fixture.requests.some(message => message.type === 'GET_PROVIDERS'), 'optional model discovery after opening Models'); await fixture.settle();
  assert.equal(fixture.q('#beta-view-settings').hidden, false); assert.equal(fixture.q('#settings-models').open, true);
  assert.ok(fixture.requests.some(message => message.type === 'GET_PROVIDERS'));
  assert.equal(fixture.q('#beta-automatic-ai').checked, false);
  assert.match(fixture.q('a[href="https://github.com/tauki/web-recall#setup"]').textContent, /Ollama setup/);
  const reopened = await ui('sidepanel', {}, backend); testContext.after(reopened.close); await reopened.settle();
  assert.equal(reopened.q('#beta-recall-setup').hidden, true); assert.equal(reopened.q('#beta-optional-ai').hidden, true);
});

test('delayed capture setup and first-save updates leave focus on work the user moved to', async testContext => {
  const settings = { ...DEFAULT_SETTINGS, paused: true, captureSetupComplete: false, recallSetupComplete: false };
  const choice = deferred(), capture = deferred();
  let recents = [];
  const fixture = await ui('sidepanel', {
    GET_SETTINGS: () => ({ settings }), SET_SETTINGS: () => choice.promise,
    GET_RECENT_PAGES: () => ({ pages: recents, nextCursor: null }), CAPTURE_ACTIVE_TAB: () => capture.promise
  });
  testContext.after(fixture.close);
  await fixture.settle();
  const input = fixture.q('#beta-search-input'), manual = fixture.q('#beta-keep-manual-capture');
  manual.focus(); manual.click(); input.focus();
  const savedSettings = { ...settings, captureSetupComplete: true };
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings: savedSettings });
  choice.resolve({ settings: savedSettings }); await fixture.settle();
  assert.equal(fixture.q('#beta-capture-setup').hidden, true);
  assert.equal(fixture.window.document.activeElement, input, 'Saving the capture choice does not reclaim focus');
  const captureButton = fixture.q('.wr-empty-memory .primary-button');
  captureButton.focus(); captureButton.click(); input.focus();
  recents = pages;
  fixture.emit({ type: 'CAPTURE_QUEUE_UPDATED' });
  capture.resolve({ ok: true, received: true }); await fixture.settle();
  assert.equal(fixture.q('.wr-empty-memory'), null);
  assert.equal(fixture.q('#beta-recall-setup').hidden, false);
  assert.equal(fixture.window.document.activeElement, input, 'Rendering the saved page does not reclaim focus');
});

test('an unavailable saved result cannot finish onboarding or prompt for AI setup', async testContext => {
  const backend = await recallFixture(testContext), fixture = await ui('sidepanel', {}, backend); testContext.after(fixture.close); await fixture.settle();
  fixture.q('.wr-empty-memory .primary-button').click(); await fixture.settle(); await backend.drain();
  fixture.q('#beta-search-input').value = 'Copper terns'; fixture.submit('#beta-search-form'); await fixture.settle();
  await backend.db.deletePages([recallPage.url]);
  fixture.q('#beta-recall-next').click(); await fixture.settle();
  assert.match(fixture.q('.saved-reader-host').textContent, /Saved capture unavailable/);
  assert.equal(backend.stored.betaSettings.recallSetupComplete, false); assert.equal(fixture.q('#beta-optional-ai').hidden, true);
});

test('Skip guide persists without changing capture policy, contacting models or repeating on reopening', async testContext => {
  const backend = await recallFixture(testContext), fixture = await ui('sidepanel', {}, backend); testContext.after(fixture.close); await fixture.settle();
  backend.failNextWrite('betaSettings'); fixture.q('.wr-skip-recall').click(); await fixture.settle();
  assert.match(fixture.q('#beta-search-status').textContent, /Unable to save guide progress/);
  assert.equal(backend.stored.betaSettings.recallSetupComplete, false); assert.equal(fixture.q('.wr-skip-recall').hidden, false);
  fixture.q('.wr-skip-recall').click(); await fixture.settle();
  assert.equal(backend.stored.betaSettings.recallSetupComplete, true); assert.equal(backend.stored.betaSettings.captureSetupComplete, false);
  assert.equal(backend.stored.betaSettings.paused, true); assert.equal(backend.stored.betaSettings.automaticAi, false);
  const reopened = await ui('sidepanel', {}, backend); testContext.after(reopened.close); await reopened.settle();
  assert.equal(reopened.q('.wr-skip-recall').hidden, true); assert.equal(reopened.q('#beta-optional-ai').hidden, true); assert.equal(backend.requests.length, 0);
});

test('opening capture or appearance settings never discovers providers, and automatic AI is a separate explicit saved choice', async testContext => {
  const backend = await recallFixture(testContext), fixture = await ui('sidepanel', {}, backend); testContext.after(fixture.close); await fixture.settle();
  fixture.q('a[data-view="settings"]').click(); fixture.q('#settings-capture').open = true; await tick(); await fixture.settle();
  fixture.q('#settings-appearance').open = true; await tick(); await fixture.settle();
  assert.equal(backend.requests.length, 0); assert.ok(!fixture.requests.some(message => message.type === 'GET_PROVIDERS'));
  await openModels(fixture); await fixture.settle();
  assert.ok(fixture.requests.some(message => message.type === 'GET_PROVIDERS'));
  assert.equal(backend.requests.length, 0, 'Listing provider choices must not probe the disabled chat provider');
  fixture.q('#beta-automatic-ai').checked = true; fixture.change('#beta-automatic-ai', ''); await fixture.settle();
  assert.equal(backend.stored.betaSettings.automaticAi, true); assert.equal(backend.requests.length, 0);
  backend.failNextWrite('betaSettings'); fixture.q('#beta-automatic-ai').checked = false; fixture.change('#beta-automatic-ai', ''); await fixture.settle();
  assert.equal(backend.stored.betaSettings.automaticAi, true); assert.equal(fixture.q('#beta-automatic-ai').checked, true);
  assert.match(fixture.q('#beta-settings-status').textContent, /Unable to update automatic AI/);
  fixture.q('#beta-automatic-ai').checked = false; fixture.change('#beta-automatic-ai', ''); await fixture.settle();
  assert.equal(backend.stored.betaSettings.automaticAi, false); assert.equal(backend.stored.betaSettings.queryRewrite, true); assert.equal(backend.stored.betaSettings.searchRerank, true);
  assert.equal(backend.requests.length, 0);
  assert.ok(!fixture.requests.some(message => ['BACKFILL_EMBEDDINGS', 'DOWNLOAD_BROWSER_EMBED', 'REGENERATE_PAGE_SUMMARY'].includes(message.type)));
});

test('a failed optional-provider discovery is retryable when Models is reopened', async testContext => {
  let attempts = 0;
  const fixture = await ui('sidepanel', { GET_PROVIDERS: () => { if (++attempts === 1) throw Error('Worker temporarily unavailable'); return { providers: [{ id: 'ollama', name: 'Ollama', settings: [], actions: [], models: ['local-model'], status: { online: true }, selectedModel: 'local-model' }] }; } }); testContext.after(fixture.close);
  await openModels(fixture); await fixture.settle();
  assert.match(fixture.q('#beta-provider-status').textContent, /Worker temporarily unavailable/);
  const models = fixture.q('#settings-models');
  await new Promise(resolve => { models.addEventListener('toggle', resolve, { once: true }); models.open = false; });
  await openModels(fixture); await fixture.settle();
  assert.equal(fixture.q('#beta-chat-model').value, 'local-model'); assert.match(fixture.q('#beta-provider-status').textContent, /Ollama online/);
});

for (const view of ['sidepanel', 'manage']) {
  for (const [status, expected] of [['queued', /Saved · waiting for indexing/], ['processing', /Saved · indexing/], ['failed', /Saved text is searchable · indexing failed: Model unavailable/]]) {
    test(`${view} distinguishes ${status} indexing from safe saved text and offers Retry only on failure`, async t => {
      const f = await ui(view, { GET_PROCESSING: () => ({ queue: [{ ...pages[0], status, textSaved: true, attempts: 1, error: status === 'failed' ? 'Model unavailable' : undefined }] }) }); t.after(f.close); await f.settle();
      const queue = f.q(view === 'sidepanel' ? '#beta-capture-status' : '#manage-queue');
      assert.match(queue.textContent, expected);
      const retry = [...queue.querySelectorAll('button')].find(button => button.textContent === 'Retry');
      assert.equal(retry.disabled, status !== 'failed');
      if (view === 'manage') assert.match(f.q('#manage-rows').textContent, expected);
    });
  }
}

for (const view of ['sidepanel', 'manage']) test(`${view} does not promise searchable text for a legacy capture that failed its storage write`, async t => {
  const f = await ui(view, { GET_PAGE_LIST: () => ({ pages: [] }), GET_PROCESSING: () => ({ queue: [{ ...pages[0], status: 'failed', error: 'Disk full while saving capture' }] }) }); t.after(f.close); await f.settle();
  const queue = f.q(view === 'sidepanel' ? '#beta-capture-status' : '#manage-queue');
  assert.match(queue.textContent, /Capture or indexing failed: Disk full/);
  assert.doesNotMatch(queue.textContent, /Saved|searchable/);
  assert.equal(queue.querySelector('button').disabled, false);
});

test('Memory Manager refreshes saved index facts when an admitted job completes', async t => {
  let hasEmbeddings = false;
  const f = await ui('manage', {
    GET_PAGE_LIST: () => ({ pages: [{ ...pages[0], hasEmbeddings, embeddingStatus: '' }] }),
    GET_PROCESSING: () => ({ queue: hasEmbeddings ? [] : [{ ...pages[0], status: 'processing', textSaved: true }] })
  }); t.after(f.close); await f.settle();
  assert.match(f.q('#manage-rows').textContent, /Saved · indexing/);
  hasEmbeddings = true; f.emit({ type: 'CAPTURE_QUEUE_UPDATED' }); await f.settle();
  assert.match(f.q('#manage-rows').textContent, /Indexed/);
  assert.doesNotMatch(f.q('#manage-rows').textContent, /Missing|waiting for indexing/);
});

test('Memory Manager reads current queue status after an invalidation and ignores a late older result', async t => {
  const running = { ...pages[0], status: 'processing', textSaved: true };
  const failed = { ...running, status: 'failed', error: 'Model is offline.' };
  const delayed = deferred();
  let response = { queue: [running] };
  const f = await ui('manage', { GET_PROCESSING: () => response });
  t.after(f.close); await f.settle();
  const queue = f.q('#manage-queue');
  assert.match(queue.textContent, /Saved · indexing/);
  response = delayed.promise;
  f.emit({ type: 'CAPTURE_QUEUE_UPDATED' });
  try {
    assert.match(queue.textContent, /Saved · indexing/, 'A pending fetch must not clear the last known status');
    response = { queue: [failed] };
    f.emit({ type: 'CAPTURE_QUEUE_UPDATED' });
    await waitFor(() => queue.textContent.includes('Model is offline.'), 'new queue failure to appear');
  } finally { delayed.resolve({ queue: [running] }); }
  await f.settle();
  assert.match(queue.textContent, /Saved text is searchable · indexing failed: Model is offline/);
  assert.equal([...queue.querySelectorAll('button')].find(button => button.textContent === 'Retry')?.disabled, false);
});

test('a hidden Memory view does not enumerate saved page bodies on indexing events and refreshes when reopened', async t => {
  const f = await ui('sidepanel'); t.after(f.close);
  f.q('a[data-view="manage"]').click(); await f.settle();
  f.q('a[data-view="sidepanel"]').click(); await f.settle();
  const reads = f.requests.filter(message => message.type === 'GET_PAGE_LIST').length;
  f.emit({ type: 'CAPTURE_QUEUE_UPDATED', queue: [{ ...pages[0], status: 'processing' }] }); await f.settle();
  assert.equal(f.requests.filter(message => message.type === 'GET_PAGE_LIST').length, reads);
  f.q('a[data-view="manage"]').click(); await f.settle();
  assert.ok(f.requests.filter(message => message.type === 'GET_PAGE_LIST').length > reads);
});

for (const failed of [false, true]) test(`manual saving shows its pending state and ${failed ? 'does not acknowledge a failed write' : 'confirms text only after acknowledgement'}`, async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { CAPTURE_ACTIVE_TAB: () => pending.promise }); t.after(f.close);
  f.q('#beta-capture-now').click();
  assert.match(f.q('#beta-search-status').textContent, /Saving page/);
  assert.equal(f.q('#beta-capture-now').disabled, true);
  await f.poll();
  assert.match(f.q('#beta-search-status').textContent, /Saving page/, 'recents refresh must not hide an unacknowledged save');
  pending.resolve(failed ? { error: 'Storage is unavailable' } : { ok: true }); await f.settle();
  assert.match(f.q('#beta-search-status').textContent, failed ? /Request failed: Storage is unavailable/ : /Page saved · text-searchable/);
  assert.equal(f.q('#beta-capture-now').disabled, false);
});

test('the first manual save visibly confirms durable text and later indexing refreshes do not erase the confirmation', async t => {
  const pending = deferred();
  let recents = [];
  const f = await ui('sidepanel', {
    CAPTURE_ACTIVE_TAB: () => pending.promise,
    GET_RECENT_PAGES: () => ({ pages: recents, nextCursor: null }),
    SEARCH_QUERY: () => ({ results: [] })
  });
  t.after(f.close);
  await f.settle();
  const feedback = f.q('#beta-search-status');
  f.q('.wr-empty-memory button').click();
  assert.match(feedback.textContent, /Saving page/);
  assert.equal(feedback.closest('[hidden]'), null, 'An empty library must still announce a pending save');
  pending.resolve({ ok: true, received: true });
  await f.settle();
  assert.match(feedback.textContent, /Page saved · text-searchable/);
  assert.equal(feedback.closest('[hidden]'), null, 'Confirmation must be visible even before recents catch up');
  recents = pages;
  f.emit({ type: 'CAPTURE_QUEUE_UPDATED', queue: [] });
  await f.settle();
  assert.match(feedback.textContent, /Page saved · text-searchable/, 'Delayed indexing/recents updates are not user feedback');
  f.q('#beta-search-input').value = 'Different work';
  f.submit('#beta-search-form');
  await f.settle();
  assert.equal(feedback.textContent, '0 pages');
});

test('a first-save error is visible and survives an unrelated queue refresh', async t => {
  const f = await ui('sidepanel', {
    CAPTURE_ACTIVE_TAB: () => ({ error: 'Storage could not persist the page' }),
    GET_RECENT_PAGES: () => ({ pages: [], nextCursor: null })
  });
  t.after(f.close);
  await f.settle();
  f.q('.wr-empty-memory button').click();
  await f.settle();
  f.emit({ type: 'CAPTURE_QUEUE_UPDATED', queue: [] });
  await f.settle();
  const feedback = f.q('#beta-search-status');
  assert.equal(feedback.closest('[hidden]'), null);
  assert.match(feedback.textContent, /Storage could not persist the page/);
  assert.doesNotMatch(feedback.textContent, /Page saved/);
});

test('a late manual save does not replace a newer completed search message', async t => {
  const capture = deferred();
  const f = await ui('sidepanel', {
    CAPTURE_ACTIVE_TAB: () => capture.promise,
    SEARCH_QUERY: () => ({ results: [] })
  });
  t.after(f.close);
  f.q('#beta-capture-now').click();
  f.q('#beta-search-input').value = 'Different work';
  f.submit('#beta-search-form');
  await waitFor(() => f.q('#beta-search-stop').hidden, 'the newer search to finish');
  capture.resolve({ ok: true, received: true });
  await f.settle();
  assert.equal(f.q('#beta-search-status').textContent, '0 pages');
});

test('background pagination retains capture feedback while appending older recents', async t => {
  const next = deferred();
  const oldPage = { ...pages[0], url: 'https://example.test/older', title: 'Earlier report', timestamp: 1 };
  const cursor = { timestamp: pages[0].timestamp, url: pages[0].url, title: pages[0].title };
  const f = await ui('sidepanel', {
    CAPTURE_ACTIVE_TAB: () => ({ ok: true, received: true }),
    GET_RECENT_PAGES: message => message.after ? next.promise : { pages, nextCursor: cursor }
  });
  t.after(f.close);
  f.q('#beta-load-more-recents').click();
  f.q('#beta-capture-now').click();
  await waitFor(() => /Page saved/u.test(f.q('#beta-search-status').textContent), 'capture confirmation');
  next.resolve({ pages: [oldPage], nextCursor: null });
  await f.settle();
  assert.match(f.q('#beta-recents-list').textContent, /Earlier report/u);
  assert.match(f.q('#beta-search-status').textContent, /Page saved · text-searchable/u);
});

test('Manual only completes capture setup without enabling automatic collection or model inference', async t => {
  const backend = providerFixture('http://localhost:11434'); backend.stored.betaSettings.captureSetupComplete = false; await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  f.q('#beta-keep-manual-capture').click(); await f.settle();
  assert.equal(backend.stored.betaSettings.paused, true); assert.equal(backend.stored.betaSettings.captureSetupComplete, true);
  assert.equal(f.q('#beta-capture-setup').hidden, true);
  assert.equal(backend.requests.some(request => /\/api\/(chat|embed)$/.test(new URL(request.url).pathname)), false);
});

for (const selector of ['#beta-enable-broad-capture', '#settings-enable-broad-capture']) test(`${selector} enables all non-excluded sites rather than retaining a selected-site restriction`, async t => {
  const backend = providerFixture('http://localhost:11434');
  Object.assign(backend.stored.betaSettings, { allowlist: ['previous.test'], denylist: ['private.test'], captureSetupComplete: false }); await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  if (selector.startsWith('#settings-')) f.q('a[data-view="settings"]').click();
  f.q(selector).click(); await f.settle();
  assert.equal(backend.stored.betaSettings.paused, false);
  assert.deepEqual(backend.stored.betaSettings.allowlist, []); assert.deepEqual(backend.stored.betaSettings.denylist, ['private.test']);
});

test('panel capture controls toggle current policy and exclude the active site without deleting existing pages', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect(); backend.setActiveTab(pages[0].url);
  const db = await backend.load('src/shared/db/index.ts'); await db.savePageRecord({ ...pages[0], text: 'Saved evidence.', chunks: [] });
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  f.q('#beta-pause-capture-menu').click(); await f.settle(); assert.equal(backend.stored.betaSettings.paused, false);
  f.q('.app-menu-button').click(); await tick(); assert.match(f.q('#beta-pause-capture-menu').textContent, /Pause automatic/);
  [...f.window.document.querySelectorAll('.panel-menu button')].find(button => button.textContent === 'Never save current site').click(); await f.settle();
  assert.deepEqual(backend.stored.betaSettings.denylist, ['example.test']); assert.ok(await db.getPageRecord(pages[0].url));
  assert.match(f.q('#beta-search-status').textContent, /example.test excluded.*Existing saves remain/);
});

test('Memory reviews the full site-and-date scope, then forgets only the confirmed pages through the real handlers', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  const target = { ...pages[0], timestamp: new Date(2026, 0, 2, 12).getTime(), text: 'Saved evidence.', chunks: [] };
  const later = { ...target, url: 'https://example.test/later', timestamp: new Date(2026, 0, 3, 12).getTime() };
  const elsewhere = { ...target, url: 'https://notexample.test/elsewhere' };
  for (const page of [target, later, elsewhere]) await db.savePageRecord(page);
  const f = await ui('manage', {}, backend); t.after(f.close); await f.settle();
  f.change('#manage-forget-site', 'example.test'); f.change('#manage-forget-from', '2026-01-02'); f.change('#manage-forget-through', '2026-01-02');
  f.submit('#manage-forget-form'); await f.settle();
  assert.equal(f.q('#manage-forget-confirmation').hidden, false);
  assert.match(f.q('#manage-forget-review').textContent, /1 saved version across 1 page.*example.test.*2026-01-02.*cannot be undone/);
  assert.ok(await db.getPageRecord(target.url), 'Review must not delete anything');
  f.q('#manage-forget-confirm').click(); await f.settle();
  assert.equal(await db.getPageRecord(target.url), undefined); assert.ok(await db.getPageRecord(later.url)); assert.ok(await db.getPageRecord(elsewhere.url));
  assert.match(f.q('#manage-forget-status').textContent, /Forgot 1 saved version across 1 page/);
  assert.equal(f.q('#manage-forget-confirmation').hidden, true);
});

test('changing or cancelling a forget scope invalidates both ready and late confirmations', async t => {
  const pending = deferred(); let reads = 0;
  const f = await ui('manage', { PREVIEW_FORGET_PAGES: () => ++reads <= 2 ? { selection: [{ url: pages[0].url, versionIds: ['reviewed'] }] } : pending.promise }); t.after(f.close);
  f.change('#manage-forget-site', 'example.test'); f.submit('#manage-forget-form'); await f.settle();
  assert.equal(f.q('#manage-forget-confirmation').hidden, false);
  f.q('#manage-forget-cancel').click(); assert.equal(f.q('#manage-forget-confirmation').hidden, true);
  f.submit('#manage-forget-form'); await f.settle();
  f.change('#manage-forget-site', 'other.test'); assert.equal(f.q('#manage-forget-confirmation').hidden, true);
  f.q('#manage-forget-confirm').click(); assert.equal(f.requests.some(message => message.type === 'FORGET_PAGES'), false);
  f.submit('#manage-forget-form'); await tick(); f.change('#manage-forget-site', 'third.test');
  pending.resolve({ selection: [{ url: 'https://other.test/page', versionIds: ['other'] }] }); await f.settle();
  assert.equal(f.q('#manage-forget-confirmation').hidden, true);
  assert.equal(f.q('#manage-forget-preview').disabled, false);
});

test('Memory date forgetting preserves another version of the same page and refreshes its promoted content', async testContext => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts');
  const recent = new Date(2026, 0, 3, 12).getTime(), earlier = new Date(2026, 0, 2, 12).getTime();
  await db.savePageRecord({ ...pages[0], title: 'Current removed article', versionId: 'remove-current', text: 'Current content.', chunks: [], timestamp: recent, versions: [{ versionId: 'keep-earlier', title: 'Earlier preserved article', text: 'Earlier evidence.', chunks: [], timestamp: earlier, kept: true }] });
  await backend.connect();
  const f = await ui('manage', {}, backend); testContext.after(f.close); await f.settle();
  f.change('#manage-forget-site', 'example.test'); f.change('#manage-forget-from', '2026-01-03'); f.change('#manage-forget-through', '2026-01-03');
  f.submit('#manage-forget-form'); await f.settle();
  assert.match(f.q('#manage-forget-review').textContent, /1 saved version across 1 page/);
  assert.match(f.q('#manage-forget-review').textContent, /Only these matching versions.*Others stay/);
  assert.equal((await db.getPageRecord(pages[0].url)).versionId, 'remove-current');
  f.q('#manage-forget-confirm').click(); await f.settle();
  const request = f.requests.find(message => message.type === 'FORGET_PAGES');
  assert.deepEqual(Array.from(request.selection, page => ({ url: page.url, versionIds: Array.from(page.versionIds) })), [{ url: pages[0].url, versionIds: ['remove-current'] }]);
  assert.equal((await db.getPageRecord(pages[0].url)).versionId, 'keep-earlier');
  assert.match(f.q('#manage-rows').textContent, /Earlier preserved article/);
  assert.doesNotMatch(f.q('#manage-rows').textContent, /Current removed article/);
  assert.match(f.q('#manage-forget-status').textContent, /Forgot 1 saved version across 1 page/);
});

test('a confirmed forget is submitted once and cannot change its scope while the transaction is pending', async t => {
  const pending = deferred();
  const f = await ui('manage', { PREVIEW_FORGET_PAGES: () => ({ selection: [{ url: pages[0].url, versionIds: ['reviewed'] }] }), FORGET_PAGES: () => pending.promise }); t.after(f.close);
  f.change('#manage-forget-site', 'example.test'); f.submit('#manage-forget-form'); await f.settle();
  f.q('#manage-forget-confirm').click(); f.q('#manage-forget-confirm').click();
  assert.equal(f.requests.filter(message => message.type === 'FORGET_PAGES').length, 1);
  assert.equal(f.q('#manage-forget-site').disabled, true); assert.equal(f.q('#manage-forget-cancel').disabled, true);
  pending.resolve({ pages: 1, versions: 1 }); await f.settle();
  assert.equal(f.q('#manage-forget-site').disabled, false); assert.equal(f.q('#manage-forget-cancel').disabled, false);
});

test('forget requires a scope, handles no matches, and retains its retryable confirmation after a storage failure', async t => {
  let matching = false;
  const f = await ui('manage', { PREVIEW_FORGET_PAGES: () => ({ selection: matching ? [{ url: pages[0].url, versionIds: ['reviewed'] }] : [] }), FORGET_PAGES: () => ({ error: 'Storage write aborted' }) }); t.after(f.close);
  f.submit('#manage-forget-form'); await f.settle(); assert.match(f.q('#manage-forget-status').textContent, /Choose a site or capture date/);
  assert.equal(f.requests.some(message => message.type === 'PREVIEW_FORGET_PAGES'), false);
  f.change('#manage-forget-site', 'example.test'); f.submit('#manage-forget-form'); await f.settle();
  assert.match(f.q('#manage-forget-status').textContent, /No saved versions match/); assert.equal(f.q('#manage-forget-confirmation').hidden, true);
  matching = true; f.submit('#manage-forget-form'); await f.settle(); f.q('#manage-forget-confirm').click(); await f.settle();
  assert.match(f.q('#manage-forget-status').textContent, /Forget failed: Storage write aborted/);
  assert.equal(f.q('#manage-forget-confirmation').hidden, false); assert.equal(f.q('#manage-forget-confirm').disabled, false);
  assert.ok(f.q('#manage-rows').textContent.includes('Cats'));
});

test('successful individual re-embedding clears a retired capture failure from Memory immediately', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  const page = { ...pages[0], text: 'Saved evidence.', summary: 'Saved overview.', chunks: [{ text: 'Saved evidence.', embedding: [] }] };
  await db.savePageRecord(page); await db.appendProcessing({ url: page.url, title: page.title, status: 'failed', textSaved: true, attempts: 1, updatedAt: 10, createdAt: 1, lastAttemptAt: 1, error: 'Original indexing failure', payload: { ...page, chunks: ['Saved evidence.'], captureId: 'captured-page' } });
  const f = await ui('manage', {}, backend); t.after(f.close); await f.settle();
  assert.match(f.q('#manage-queue').textContent, /Original indexing failure/);
  [...f.window.document.querySelectorAll('#manage-rows button')].find(button => button.textContent === 'Re-embed').click(); await f.settle();
  assert.equal(await db.getProcessingEntry(page.url), undefined);
  assert.doesNotMatch(f.q('#manage-queue').textContent, /Original indexing failure/); assert.match(f.q('#manage-rows').textContent, /Indexed/);
});

test('Memory opens saved history without a model and can keep or explicitly remove an earlier version', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'), processing = await backend.load('src/background/processing/index.ts');
  const base = { url: pages[0].url, title: 'A saved guide', manual: true };
  await processing.markQueued({ ...base, text: 'Original evidence.', chunks: ['Original evidence.'], timestamp: 10, captureId: 'first' }, 0);
  const first = await db.getPageRecord(base.url);
  await processing.markQueued({ ...base, text: 'Current evidence.', chunks: ['Current evidence.'], timestamp: 20, captureId: 'second' }, 0); await processing.markDone(base.url);
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  f.q('a[data-view="manage"]').click(); await f.settle();
  f.q('#manage-rows a[href*="#history="]').click();
  await waitFor(() => f.q('select[aria-label="Saved version"]'), 'saved history to open from Memory'); await f.settle();
  assert.equal(f.q('.saved-reader-text').textContent, 'Current evidence.');
  f.change('select[aria-label="Saved version"]', first.versionId); await f.settle();
  await waitFor(() => f.q('.saved-reader-text')?.textContent === 'Original evidence.', 'earlier saved evidence');
  await waitFor(() => [...f.window.document.querySelectorAll('.saved-reader-history button')].some(button => button.textContent === 'Keep this version'), 'earlier version tools');
  const button = text => [...f.window.document.querySelectorAll('.saved-reader-history button')].find(control => control.textContent === text);
  button('Keep this version').click(); await f.settle();
  assert.equal((await db.getPageRecord(base.url)).versions.find(version => version.versionId === first.versionId).kept, true);
  button('Remove this version').click(); assert.equal(f.q('.saved-version-confirm').hidden, false);
  button('Cancel').click(); assert.equal(f.q('.saved-version-confirm').hidden, true);
  assert.equal((await db.getPageRecord(base.url)).versions.length, 1);
  button('Remove this version').click(); button('Remove version').click(); await f.settle();
  await waitFor(() => f.q('.saved-reader-text')?.textContent === 'Current evidence.', 'current capture after removing earlier version');
  assert.equal((await db.getPageRecord(base.url)).versions.length, 0);
  assert.equal(backend.requests.some(request => /\/api\/(chat|embed)$/.test(new URL(request.url).pathname)), false);
});

test('partial capture warnings stay visible and inert in Memory, previews and the saved reader', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  const warning = 'Embedded content is not included. <img src=x onerror="alert(1)">';
  await db.savePageRecord({ ...pages[0], text: 'Visible saved evidence.', chunks: [], captureInfo: { source: 'main', warnings: [warning] } });
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  f.q('#beta-recents-list details').open = true; await waitFor(() => f.q('#beta-recents-list .capture-notice'), 'capture limitation preview');
  assert.ok(f.q('#beta-recents-list .capture-notice').textContent.includes(warning));
  f.q('#beta-recents-list .read-saved-page').click(); await f.settle();
  assert.ok(f.q('.saved-reader-host .capture-notice').textContent.includes(warning));
  f.q('a[data-view="manage"]').click(); await f.settle();
  assert.ok(f.q('#manage-rows .capture-notice').textContent.includes(warning));
  assert.equal(f.window.document.querySelector('img'), null);
});

test('recent-page reading explicitly opens the latest saved text even if cached metadata predates an unchanged revisit', async t => {
  const f = await ui('sidepanel', { GET_SAVED_PAGE: () => ({ page: { ...pages[0], timestamp: 30, firstCapturedAt: 10, text: 'Current saved evidence.', current: true } }) }); t.after(f.close);
  f.q('#beta-recents-list details').open = true; f.q('#beta-recents-list .read-saved-page').click(); await f.settle();
  const request = f.requests.find(message => message.type === 'GET_SAVED_PAGE');
  assert.equal(request.timestamp, undefined); assert.equal(f.q('.saved-reader-text').textContent, 'Current saved evidence.');
});

test('search navigation carries the matched version identity instead of substituting the current recapture', async t => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts'), processing = await backend.load('src/background/processing/index.ts');
  const base = { url: pages[0].url, title: 'Saved guide', manual: true };
  await processing.markQueued({ ...base, text: 'Original copper tern evidence.', chunks: ['Original copper tern evidence.'], timestamp: 10, captureId: 'first', captureInfo: { source: 'main', warnings: ['Collapsed replies were not captured.'] } }, 0);
  const first = await db.getPageRecord(base.url);
  await db.savePageRecord({ ...first, summary: 'Overview of the earlier copper tern evidence.' });
  await processing.markQueued({ ...base, text: 'Unrelated replacement.', chunks: ['Unrelated replacement.'], timestamp: 10, captureId: 'second' }, 0); await processing.markDone(base.url);
  await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  const beforeSearch = backend.requests.length;
  f.q('#beta-search-input').value = '"copper tern"'; f.submit('#beta-search-form'); await f.settle();
  f.q('#beta-search-results details').open = true;
  await waitFor(() => f.requests.some(message => message.type === 'GET_PAGE_PREVIEW'), 'matched version preview'); await f.settle();
  assert.equal(f.q('#beta-search-results .content-entry-body > p').textContent, 'Overview of the earlier copper tern evidence.');
  assert.match(f.q('#beta-search-results .capture-notice').textContent, /Collapsed replies/);
  f.q('#beta-search-results .read-saved-page').click(); await f.settle();
  assert.equal(f.requests.find(message => message.type === 'GET_SAVED_PAGE').versionId, first.versionId);
  assert.equal(f.q('.saved-reader-text').textContent, first.text);
  assert.deepEqual(backend.requests.slice(beforeSearch).map(request => new URL(request.url).pathname), []);
});

test('a late Keep response cannot replace another selected version or mislabel its retention', async t => {
  const pending = deferred(), first = { ...pages[0], versionId: 'one', timestamp: 10, firstCapturedAt: 10, text: 'First evidence.', current: true, kept: false };
  const second = { ...first, versionId: 'two', timestamp: 5, text: 'Second evidence.', current: false };
  const f = await ui('sidepanel', {
    GET_SAVED_PAGE: message => ({ page: message.versionId === 'two' ? second : first }),
    GET_SAVED_HISTORY: () => ({ versions: [first, second] }), UPDATE_SAVED_VERSION: () => pending.promise
  }); t.after(f.close);
  f.q('#beta-recents-list details').open = true; f.q('#beta-recents-list .read-saved-page').click(); await f.settle();
  f.q('.saved-reader-history').open = true; await waitFor(() => f.q('select[aria-label="Saved version"]'), 'history controls');
  [...f.window.document.querySelectorAll('.saved-reader-history button')].find(button => button.textContent === 'Keep this version').click();
  f.change('select[aria-label="Saved version"]', 'two'); await waitFor(() => f.q('.saved-reader-text')?.textContent === second.text, 'another version while Keep is pending');
  pending.resolve({ ok: true }); await f.settle();
  assert.equal(f.q('.saved-reader-text').textContent, second.text);
  assert.ok([...f.window.document.querySelectorAll('.saved-reader-history button')].some(button => button.textContent === 'Keep this version'));
  assert.doesNotMatch(f.q('.saved-reader-history').textContent, /Kept until you release/);
});

test('repeated sidepanel banner refreshes read configuration without health or model probes', async t => {
  const f = await ui('sidepanel', { GET_PROVIDER_CONFIG: () => ({ baseUrl: 'https://provider.example.test' }) });
  t.after(f.close);
  const providerReads = f.requests.filter(message => message.type === 'GET_PROVIDERS').length;
  await f.poll(); await f.poll();
  assert.equal(f.requests.filter(message => message.type === 'GET_PROVIDERS').length, providerReads);
  assert.ok(f.requests.some(message => message.type === 'GET_PROVIDER_CONFIG'));
  assert.equal(f.q('#beta-remote-provider-banner').hidden, false);
  assert.match(f.q('#beta-remote-provider-banner').textContent, /provider.example.test/);
});

test('chat provider cancellation preserves settings and accepting consent makes the saved provider usable', async t => {
  const origin = 'https://models.example.test';
  let confirmations = 0;
  const backend = providerFixture(origin);
  await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  await openModels(f);
  await waitFor(() => f.q('#beta-provider-base')?.value === origin, 'the saved remote provider to appear in Settings');
  const initial = JSON.stringify(backend.stored);
  f.window.confirm = () => { confirmations++; return false; };
  f.q('#beta-provider-save').click();
  assert.equal(JSON.stringify(backend.stored), initial);
  assert.equal(backend.requests.length, 0, 'Cancelling consent must not contact the provider');
  f.window.confirm = () => { confirmations++; return true; };
  f.q('#beta-provider-save').click();
  await waitFor(() => f.q('#beta-settings-status')?.textContent.includes('Provider settings saved'), 'the provider save to finish');
  assert.equal(backend.stored.betaProviderSettings.ollama.baseUrl, origin);
  assert.deepEqual(backend.stored.betaSettings.acknowledgedRemoteProviderOrigins, [origin]);
  assert.equal(backend.stored.betaSettings.paused, true);
  assert.ok(backend.requests.length > 0);
  for (const request of backend.requests) assert.ok(request.acknowledged.includes(new URL(request.url).origin));
  f.q('#beta-provider-save').click();
  await f.settle();
  assert.equal(confirmations, 2);
});

test('embedding consent cancellation preserves the endpoint and acceptance persists the approved endpoint', async t => {
  const origin = 'https://embeddings.example.test';
  const backend = providerFixture('http://localhost:11434');
  await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  await openModels(f);
  await waitFor(() => f.q('#beta-provider-base')?.value === 'http://localhost:11434', 'initial Settings to load');
  f.q('#beta-embedding-base').value = origin;
  const initial = JSON.stringify(backend.stored);
  f.window.confirm = () => false;
  f.q('#beta-save-embedding').click();
  assert.equal(JSON.stringify(backend.stored), initial);
  f.window.confirm = () => true;
  f.q('#beta-save-embedding').click();
  await waitFor(() => f.q('#beta-settings-status')?.textContent.includes('Embedding settings saved'), 'the embedding save to finish');
  assert.equal(backend.stored.embeddingConfig.baseUrl, origin);
  assert.deepEqual(backend.stored.betaSettings.acknowledgedRemoteProviderOrigins, [origin]);
  assert.equal(backend.stored.betaSettings.paused, true);
});

test('backend save and restore errors reach UI failure states rather than success states', async t => {
  const backend = providerFixture('http://localhost:11434');
  await backend.connect();
  const settings = await ui('sidepanel', {}, backend); t.after(settings.close);
  await openModels(settings);
  await waitFor(() => settings.q('#beta-provider-base')?.value === 'http://localhost:11434', 'Settings to load');
  backend.failNextWrite('betaProviderSettings');
  settings.q('#beta-provider-save').click();
  await settings.settle();
  assert.match(settings.q('#beta-settings-status').textContent, /Storage write failed/);
  assert.doesNotMatch(settings.q('#beta-settings-status').textContent, /settings saved/i);
  const db = await backend.load('src/shared/db/index.ts');
  t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ ...pages[0], text: 'Saved text', chunks: [{ text: 'Saved text', embedding: [1, 0] }] });
  const memory = await ui('sidepanel', {}, backend); t.after(memory.close);
  await openStorage(memory);
  const input = memory.q('#manage-import');
  const invalid = new File([JSON.stringify({ schemaVersion: 1, pages: [{ url: pages[0].url, title: 'No supported content' }] })], 'invalid.json');
  Object.defineProperty(input, 'files', { value: [invalid] });
  input.dispatchEvent(new memory.window.Event('change'));
  await waitFor(() => !input.disabled, 'failed import to finish');
  assert.match(memory.q('#settings-backup-status').textContent, /Import failed:.*content/i);
  assert.equal((await db.getPageRecord(pages[0].url)).text, 'Saved text');
});

test('text retrieval results do not display term scores as semantic similarity', async t => {
  const f = await ui('sidepanel', { SEARCH_QUERY: () => ({ results: [{ ...pages[0], snippet: 'Exact match', score: 6.5, textMatch: true }] }) });
  t.after(f.close);
  f.q('#beta-search-input').value = 'Cats';
  f.submit('#beta-search-form'); await tick();
  assert.match(f.q('#beta-search-results').textContent, /Text match/);
  assert.doesNotMatch(f.q('#beta-search-results').textContent, /sim .*%/);
});

test('Search renders early text results and retains them when refinement is stopped', async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { SEARCH_QUERY: () => pending.promise }); t.after(f.close);
  f.q('#beta-search-input').value = 'cats'; f.submit('#beta-search-form');
  const request = f.requests.find(message => message.type === 'SEARCH_QUERY');
  f.emit({ type: 'SEARCH_RESULTS_UPDATE', requestId: request.requestId, results: [{ ...pages[0], snippet: 'Saved feline observation', score: 2, textMatch: true }] });
  assert.match(f.q('#beta-search-results').textContent, /Saved feline observation/);
  assert.match(f.q('#beta-search-status').textContent, /Refining/);
  f.q('#beta-search-stop').click();
  pending.resolve({ results: [] }); await tick(); await tick();
  assert.match(f.q('#beta-search-results').textContent, /Saved feline observation/);
  assert.match(f.q('#beta-search-status').textContent, /Stopped/);
  f.emit({ type: 'SEARCH_RESULTS_UPDATE', requestId: request.requestId, results: [] });
  assert.match(f.q('#beta-search-results').textContent, /Saved feline observation/);
});

test('finishing search refinement preserves a page conversation and its working Stop control', async t => {
  const search = deferred(), answer = deferred();
  const f = await ui('sidepanel', { SEARCH_QUERY: () => search.promise, ASK_QUESTION: () => answer.promise }); t.after(f.close);
  f.q('#beta-search-input').value = 'cats'; f.submit('#beta-search-form');
  const request = f.requests.find(message => message.type === 'SEARCH_QUERY');
  const hit = { ...pages[0], snippet: 'A saved cat fact', score: 2, textMatch: true };
  f.emit({ type: 'SEARCH_RESULTS_UPDATE', requestId: request.requestId, results: [hit] });
  f.q('#beta-search-results details').open = true;
  f.q('#beta-search-results .ask-this-page').click();
  f.q('#beta-ask-input').value = 'Explain the saved observation'; f.submit('#beta-ask-form');
  const askId = f.requests.find(message => message.type === 'ASK_QUESTION').options.requestId;
  f.emit({ type: 'ASK_ANSWER_UPDATE', requestId: askId, chunk: 'Answer survives refinement.' });
  search.resolve({ results: [] }); await tick(); await tick();
  assert.match(f.q('#beta-search-results').textContent, /Explain the saved observation/);
  assert.match(f.q('#beta-ask-answer').textContent, /Answer survives refinement/);
  assert.equal(f.q('#beta-ask-stop').hidden, false);
  f.q('#beta-ask-stop').click();
  assert.equal(f.requests.find(message => message.type === 'CANCEL_ASK').requestId, askId);
  answer.resolve({ answer: 'Late reply', sources: [] }); await tick();
});

test('site and local-day filters browse only matching saved records without a model or keywords', async t => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts');
  const selectedDay = new Date(2026, 10, 1, 12).getTime();
  for (const page of [
    { url: 'https://archive.test/wanted', title: 'Selected article', timestamp: selectedDay },
    { url: 'https://archive.test/old', title: 'Outside the date range', timestamp: new Date(2026, 9, 31, 23, 59).getTime() },
    { url: 'https://other.test/wrong', title: 'Outside the site', timestamp: selectedDay },
    { url: 'https://archive.test/next', title: 'After the selected day', timestamp: new Date(2026, 10, 2, 0).getTime() }
  ]) await db.savePageRecord({ ...page, text: 'Saved reading.', chunks: [], manual: true });
  await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  f.q('#beta-filter-domain').value = 'archive.test';
  f.q('#beta-filter-from').value = '2026-11-01'; f.q('#beta-filter-to').value = '2026-11-01';
  f.submit('#beta-search-filter-form');
  await waitFor(() => f.q('#beta-search-results').textContent.includes('Selected article'), 'the filtered saved record');
  assert.doesNotMatch(f.q('#beta-search-results').textContent, /Outside|After the selected day/);
  assert.equal(backend.requests.filter(request => /\/api\/(chat|embed)$/.test(new URL(request.url).pathname)).length, 0, 'Filtered browsing must not run model inference');
  f.q('#beta-filter-from').value = '2026-11-03'; f.submit('#beta-search-filter-form');
  assert.match(f.q('#beta-search-status').textContent, /end date/);
  assert.match(f.q('#beta-search-results').textContent, /Selected article/);
  f.q('#beta-filter-clear').click();
  assert.equal(f.q('#beta-recents-section').hidden, false);
});

test('saved search results open complete stored evidence and return to the same search without a model', async t => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts');
  const text = 'Opening paragraph.\n'.repeat(160) + 'The copper tern breeds on the shore.\nIts saved context is still here.';
  await db.savePageRecord({ ...pages[0], text, summary: 'A compact overview.', chunks: [], manual: true });
  await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  f.q('#beta-search-input').value = '"copper tern"'; f.submit('#beta-search-form');
  await waitFor(() => f.q('#beta-search-results .read-saved-page'), 'the saved search result');
  f.q('#beta-search-results details').open = true;
  f.q('#beta-search-results .read-saved-page').click();
  await waitFor(() => f.q('.saved-reader-text'), 'the full saved capture');
  assert.equal(f.q('.saved-reader-text').textContent, text);
  assert.equal(f.q('.saved-reader-text mark').textContent, 'copper tern');
  assert.match(f.q('.saved-reader-text').textContent, /Its saved context is still here/);
  assert.equal(backend.requests.filter(request => /\/api\/(chat|embed)$/.test(new URL(request.url).pathname)).length, 0);
  f.q('.saved-reader-back').click();
  assert.equal(f.q('#beta-search-input').value, '"copper tern"');
  assert.equal(f.q('#beta-search-results details').open, true);
  assert.equal(f.q('.saved-reader-host').hidden, true);
});

test('invalid filter Apply cancels an active broader search and retains the visible text results', async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { SEARCH_QUERY: () => pending.promise }); t.after(f.close);
  f.q('#beta-search-input').value = 'cats'; f.submit('#beta-search-form');
  const requestId = f.requests.find(message => message.type === 'SEARCH_QUERY').requestId;
  f.emit({ type: 'SEARCH_RESULTS_UPDATE', requestId, results: [{ ...pages[0], score: 2, snippet: 'Already visible evidence', textMatch: true }] });
  f.q('#beta-filter-domain').value = '.'; f.submit('#beta-search-filter-form');
  assert.equal(f.requests.find(message => message.type === 'CANCEL_SEARCH').requestId, requestId);
  pending.resolve({ results: [{ ...pages[0], title: 'A broader result', score: 1 }] }); await tick(); await tick();
  f.emit({ type: 'SEARCH_RESULTS_UPDATE', requestId, results: [] });
  assert.match(f.q('#beta-search-results').textContent, /Already visible evidence/);
  assert.doesNotMatch(f.q('#beta-search-results').textContent, /A broader result/);
  assert.match(f.q('#beta-search-status').textContent, /site domain/);
});

test('invalid filter Apply also prevents a queued typing debounce from dispatching a broader search', async t => {
  const timers = new Map(); let next = 0;
  const f = await ui('sidepanel', {}, undefined, { setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id) }); t.after(f.close);
  f.q('#beta-search-input').value = 'cats'; f.q('#beta-search-input').dispatchEvent(new f.window.Event('input'));
  f.q('#beta-filter-domain').value = '.'; f.submit('#beta-search-filter-form');
  for (const callback of [...timers.values()]) callback();
  assert.equal(f.requests.filter(message => message.type === 'SEARCH_QUERY').length, 0);
  assert.match(f.q('#beta-search-status').textContent, /site domain/);
});

test('a semantic result forwards its stored passage so the reader reaches evidence absent from the query words', async t => {
  const backend = providerFixture('http://localhost:11434');
  const db = await backend.load('src/shared/db/index.ts');
  const opening = 'Unrelated background.\n'.repeat(180), evidence = 'The birds stay on remote islands throughout the colder months.';
  await db.savePageRecord({ ...pages[0], text: opening + '\n' + evidence, chunks: [{ text: opening.trim().replace(/\s+/g, ' '), embedding: [] }, { text: evidence, embedding: [] }], manual: true });
  await backend.connect();
  const send = backend.send;
  const f = await ui('sidepanel', {}, { ...backend, send: message => message.type === 'SEARCH_QUERY' ? Promise.resolve({ results: [{ ...pages[0], snippet: evidence, score: 0.9, chunkIndex: 1 }] }) : send(message) }); t.after(f.close);
  f.q('#beta-search-input').value = 'wintering habitat'; f.submit('#beta-search-form');
  await waitFor(() => f.q('#beta-search-results .read-saved-page'), 'a semantic-only result');
  f.q('#beta-search-results details').open = true; f.q('#beta-search-results .read-saved-page').click();
  await waitFor(() => f.q('.saved-reader-text'), 'semantic evidence in the saved reader');
  assert.equal(f.q('.saved-reader-text mark')?.textContent, evidence);
});

test('Search does not announce no results while semantic retrieval is pending', async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { SEARCH_QUERY: () => pending.promise }); t.after(f.close);
  f.q('#beta-search-input').value = 'a vague recollection'; f.submit('#beta-search-form');
  const request = f.requests.find(message => message.type === 'SEARCH_QUERY');
  f.emit({ type: 'SEARCH_RESULTS_UPDATE', requestId: request.requestId, results: [] });
  assert.doesNotMatch(f.q('#beta-search-results').textContent, /No matching pages/);
  assert.match(f.q('#beta-search-status').textContent, /Searching by meaning/);
  pending.resolve({ results: [] }); await tick(); await tick();
  assert.match(f.q('#beta-search-results').textContent, /No matching pages/);
});

test('Search preserves early matches after refinement fails and ignores updates after Clear', async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { SEARCH_QUERY: () => pending.promise }); t.after(f.close);
  f.q('#beta-search-input').value = 'cats'; f.submit('#beta-search-form');
  const request = f.requests.find(message => message.type === 'SEARCH_QUERY');
  const update = { type: 'SEARCH_RESULTS_UPDATE', requestId: request.requestId, results: [{ ...pages[0], snippet: 'Evidence retained after failure', score: 2, textMatch: true }] };
  f.emit(update);
  pending.resolve({ error: 'Provider disconnected' }); await tick(); await tick();
  assert.match(f.q('#beta-search-results').textContent, /Evidence retained after failure/);
  assert.match(f.q('#beta-search-status').textContent, /Showing text matches.*Provider disconnected/);
  f.q('#beta-search-clear').click(); f.emit(update);
  assert.equal(f.q('#beta-search-results').children.length, 0);
});

test('sidepanel menu preserves unique IDs and keyboard focus across Settings and Ask', async t => {
  const f = await ui('sidepanel'); t.after(f.close);
  const ids = [...f.window.document.querySelectorAll('[id]')].map(el => el.id);
  assert.equal(ids.length, new Set(ids).size);
  f.q('a[data-view="settings"]').click();
  assert.equal(f.q('#beta-view-settings').hidden, false);
  f.window.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  assert.equal(f.window.document.activeElement.id, 'beta-search-input');
  assert.equal(f.q('#beta-view-search').hidden, false);
  assert.equal(f.q('#settings-ask-sources').labels.length, 1);
  f.change('#beta-embedding-provider', 'browser');
  assert.equal(f.q('#embedding-ollama-fields').hidden, true);
  assert.equal(f.q('#embedding-browser-fields').hidden, false);
  f.change('#beta-embedding-provider', 'ollama');
  assert.equal(f.q('#embedding-ollama-fields').hidden, false);
  assert.equal(f.q('#embedding-browser-fields').hidden, true);
});

test('browser model selection saves the chosen pin without downloading or re-embedding pages', async t => {
  let config = { ...DEFAULT_EMBEDDING_CONFIG };
  const f = await ui('sidepanel', {
    SET_EMBEDDING_CONFIG: message => ({ config: config = { ...config, ...message.payload } })
  }); t.after(f.close);
  f.change('#beta-embedding-provider', 'browser');
  assert.equal(f.q('#beta-browser-model-select').value, DEFAULT_EMBEDDING_CONFIG.browserModel);
  f.change('#beta-browser-model-select', 'onnx-community/embeddinggemma-2-ONNX');
  assert.equal(f.q('#beta-embedding-browser-rev').value, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0');
  f.q('#beta-save-embedding').click(); await tick();
  assert.equal(config.browserModel, 'onnx-community/embeddinggemma-2-ONNX');
  assert.equal(config.browserRevision, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0');
  assert.ok(!f.requests.some(m => ['DOWNLOAD_BROWSER_EMBED', 'BACKFILL_EMBEDDINGS'].includes(m.type)));
  f.change('#beta-browser-model-select', DEFAULT_EMBEDDING_CONFIG.browserModel);
  f.q('#beta-save-embedding').click(); await tick();
  assert.equal(config.browserRevision, DEFAULT_EMBEDDING_CONFIG.browserRevision);
});

test('cached browser files do not claim inference readiness or silently start downloads', async t => {
  const f = await ui('sidepanel', {
    GET_EMBEDDING_CONFIG: () => ({ config: { ...DEFAULT_EMBEDDING_CONFIG, provider: 'browser' } }),
    GET_BROWSER_EMBED_STATUS: () => ({ status: { ready: false, runtimeAvailable: true, state: 'cached', model: DEFAULT_EMBEDDING_CONFIG.browserModel, revision: DEFAULT_EMBEDDING_CONFIG.browserRevision } })
  }); t.after(f.close);
  assert.match(f.q('#beta-embedding-browser-status').textContent, /cached model files/i);
  assert.match(f.q('#beta-embedding-browser-status').textContent, /verified when next used/i);
  assert.doesNotMatch(f.q('#beta-embedding-browser-status').textContent, /model ready|ready to download/i);
  assert.ok(!f.requests.some(message => ['DOWNLOAD_BROWSER_EMBED', 'BACKFILL_EMBEDDINGS'].includes(message.type)));
});

test('a pending browser capability check is not reported as a runtime failure', async t => {
  const f = await ui('sidepanel', {
    GET_EMBEDDING_CONFIG: () => ({ config: { ...DEFAULT_EMBEDDING_CONFIG, provider: 'browser' } }),
    GET_BROWSER_EMBED_STATUS: () => ({ status: { ready: false, runtimeAvailable: false, state: 'checking', model: DEFAULT_EMBEDDING_CONFIG.browserModel, revision: DEFAULT_EMBEDDING_CONFIG.browserRevision } })
  }); t.after(f.close);
  assert.match(f.q('#beta-embedding-browser-status').textContent, /checking browser embedding runtime/i);
  assert.doesNotMatch(f.q('#beta-embedding-browser-status').textContent, /unavailable|failed/i);
});

test('custom browser revisions remain selectable and stale model status is ignored', async t => {
  const f = await ui('sidepanel', {
    GET_EMBEDDING_CONFIG: () => ({ config: { ...DEFAULT_EMBEDDING_CONFIG, provider: 'browser', browserRevision: 'custom-revision' } })
  }); t.after(f.close);
  assert.equal(f.q('#beta-browser-model-select').value, 'custom');
  assert.equal(f.q('#beta-embedding-browser-rev').value, 'custom-revision');
  f.change('#beta-browser-model-select', 'onnx-community/embeddinggemma-2-ONNX');
  f.emit({ type: 'BROWSER_EMBED_STATUS', status: { ready: true, runtimeAvailable: true, state: 'ready', model: DEFAULT_EMBEDDING_CONFIG.browserModel, revision: DEFAULT_EMBEDDING_CONFIG.browserRevision } });
  assert.doesNotMatch(f.q('#beta-embedding-browser-status').textContent, /Model ready/);
  f.q('#beta-download-browser-model').click(); await tick();
  const saved = f.requests.find(m => m.type === 'SET_EMBEDDING_CONFIG');
  assert.equal(saved.payload.browserModel, 'onnx-community/embeddinggemma-2-ONNX');
  assert.equal(saved.payload.browserRevision, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0');
  assert.ok(f.requests.some(m => m.type === 'DOWNLOAD_BROWSER_EMBED'));
  assert.ok(!f.requests.some(m => m.type === 'BACKFILL_EMBEDDINGS'));
});

test('model downloads show per-file progress, cancel, and retry with a fresh identity', async t => {
  const attempts = [deferred(), deferred()]; let call = 0;
  const f = await ui('sidepanel', {
    DOWNLOAD_BROWSER_EMBED: () => attempts[call++].promise,
    CANCEL_BROWSER_MODEL_DOWNLOAD: () => ({ cancelled: true })
  }); t.after(f.close);
  f.change('#beta-embedding-provider', 'browser');
  f.q('#beta-download-browser-model').click(); await tick();
  const first = f.requests.find(message => message.type === 'DOWNLOAD_BROWSER_EMBED');
  const status = { ...first, startedAt: Date.now(), state: 'downloading', file: 'onnx/model.onnx', loadedBytes: 250, totalBytes: 1000 };
  f.emit({ type: 'BROWSER_MODEL_DOWNLOAD_UPDATE', download: status });
  assert.equal(f.q('#beta-browser-transfer-progress').value, 25);
  assert.match(f.q('#beta-browser-transfer-file').textContent, /25% of this file/);
  assert.equal(f.q('#beta-download-browser-model').disabled, true);
  f.q('#beta-browser-transfer-cancel').click(); await tick();
  assert.equal(f.requests.find(message => message.type === 'CANCEL_BROWSER_MODEL_DOWNLOAD').requestId, first.requestId);
  assert.match(f.q('#beta-browser-transfer-status').textContent, /Stopping/);
  attempts[0].reject(Error('Download cancelled')); await tick();
  assert.match(f.q('#beta-browser-transfer-status').textContent, /Completed files are kept/);
  assert.equal(f.q('#beta-browser-transfer-retry').hidden, false);
  f.change('#beta-browser-model-select', 'onnx-community/embeddinggemma-2-ONNX');
  const saves = f.requests.filter(message => message.type === 'SET_EMBEDDING_CONFIG').length;
  f.q('#beta-browser-transfer-retry').click(); await tick();
  const second = f.requests.filter(message => message.type === 'DOWNLOAD_BROWSER_EMBED').at(-1);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(second.model, first.model, 'retry uses the original model');
  assert.equal(second.revision, first.revision);
  assert.equal(f.requests.filter(message => message.type === 'SET_EMBEDDING_CONFIG').length, saves);
  f.emit({ type: 'BROWSER_MODEL_DOWNLOAD_UPDATE', download: { ...status, state: 'error', error: 'stale' } });
  assert.doesNotMatch(f.q('#beta-browser-transfer-status').textContent, /stale/);
  f.emit({ type: 'BROWSER_MODEL_DOWNLOAD_UPDATE', download: { ...status, requestId: second.requestId, state: 'preparing' } });
  assert.equal(f.q('#beta-browser-transfer-progress').hasAttribute('value'), false);
  assert.match(f.q('#beta-browser-transfer-status').textContent, /Preparing/);
  attempts[1].resolve({ ok: true }); await f.settle();
  assert.equal(f.q('#beta-browser-transfer').hidden, true);
  assert.equal(f.q('#beta-download-browser-model').disabled, false);
});

test('cancelling while settings save prevents a download from starting later', async t => {
  const saving = deferred();
  const f = await ui('sidepanel', { SET_EMBEDDING_CONFIG: () => saving.promise }); t.after(f.close);
  f.q('#beta-download-browser-model').click();
  f.q('#beta-browser-transfer-cancel').click();
  saving.resolve({ config: DEFAULT_EMBEDDING_CONFIG }); await f.settle();
  assert.ok(!f.requests.some(message => message.type === 'DOWNLOAD_BROWSER_EMBED'));
  assert.ok(!f.requests.some(message => message.type === 'CANCEL_BROWSER_MODEL_DOWNLOAD'));
  assert.match(f.q('#beta-browser-transfer-status').textContent, /Download cancelled/);
});

test('opening Models restores active transfers, unknown sizes and failures remain retryable', async t => {
  const download = { requestId: 'restored', model: 'owner/model', revision: 'pin', startedAt: Date.now(), state: 'downloading', file: 'weights.onnx', loadedBytes: 1048576 };
  const f = await ui('sidepanel', { GET_BROWSER_MODEL_DOWNLOAD: () => ({ download }), DOWNLOAD_BROWSER_EMBED: () => ({ error: 'Connection lost' }) }); t.after(f.close);
  f.q('#settings-models').open = true;
  await waitFor(() => !f.q('#beta-browser-transfer').hidden, 'restored transfer');
  assert.equal(f.q('#beta-browser-transfer-progress').hasAttribute('value'), false);
  assert.match(f.q('#beta-browser-transfer-file').textContent, /1 MB/);
  f.emit({ type: 'BROWSER_MODEL_DOWNLOAD_UPDATE', download: { ...download, state: 'error', error: 'Connection lost' } });
  assert.match(f.q('#beta-browser-transfer-status').textContent, /Connection lost/);
  assert.equal(f.q('#beta-browser-transfer-progress').hidden, true);
  f.q('#beta-browser-transfer-retry').click(); await f.settle();
  assert.equal(f.q('#beta-browser-transfer-retry').hidden, false);
  assert.match(f.q('#beta-browser-transfer-status').textContent, /Connection lost/);
});

test('a delayed model status refresh cannot replace a newer completion update', async t => {
  const snapshot = deferred();
  const f = await ui('sidepanel', { GET_BROWSER_MODEL_DOWNLOAD: () => snapshot.promise }); t.after(f.close);
  f.q('#settings-models').open = true;
  await waitFor(() => f.requests.some(message => message.type === 'GET_BROWSER_MODEL_DOWNLOAD'), 'status read');
  const download = { requestId: 'finished', model: 'owner/model', revision: 'pin', startedAt: Date.now(), state: 'downloading', loadedBytes: 10 };
  f.emit({ type: 'BROWSER_MODEL_DOWNLOAD_UPDATE', download: { ...download, state: 'ready' } });
  snapshot.resolve({ download }); await f.settle();
  assert.equal(f.q('#beta-browser-transfer').hidden, true);
  assert.equal(f.q('#beta-download-browser-model').disabled, false);
});

test('Ask prevents duplicate submissions, stops, and ignores all stale replies', async t => {
  const pending = [deferred(), deferred()]; let call = 0;
  const f = await ui('sidepanel', { ASK_QUESTION: () => pending[call++].promise, CANCEL_ASK: () => ({ cancelled: true }) }); t.after(f.close);
  f.q('#beta-ask-memory').click();
  f.q('#beta-ask-input').value = 'First question'; f.submit('#beta-ask-form'); f.submit('#beta-ask-form');
  assert.equal(call, 1); assert.equal(f.q('#beta-ask-submit').disabled, true);
  const first = f.requests.find(m => m.type === 'ASK_QUESTION').options.requestId;
  f.emit({ type: 'ASK_ANSWER_UPDATE', requestId: first, chunk: 'Partial answer' });
  assert.equal(f.q('#beta-ask-answer').textContent, 'Partial answer');
  f.q('#beta-ask-stop').click();
  assert.equal(f.requests.find(m => m.type === 'CANCEL_ASK').requestId, first);
  assert.match(f.q('#beta-ask-status').textContent, /Stopped/);
  f.q('#beta-ask-input').value = 'Second question'; f.submit('#beta-ask-form');
  f.emit({ type: 'ASK_PROGRESS', requestId: first, message: 'Stale activity' });
  f.emit({ type: 'ASK_ANSWER_UPDATE', requestId: first, chunk: 'Stale stream' });
  pending[0].resolve({ answer: 'Old final answer', sources: [] }); await tick();
  assert.equal(f.q('#beta-ask-answer').hidden, true);
  assert.doesNotMatch(f.q('#beta-ask-log').textContent, /Stale/);
  const second = f.requests.filter(m => m.type === 'ASK_QUESTION').at(-1).options.requestId;
  f.emit({ type: 'ASK_PROGRESS', requestId: second, message: 'Read the saved passage' });
  pending[1].resolve({ answer: '**New answer** [1]', sources: [{ ...pages[0], index: 1, domain: 'example.test' }] }); await tick();
  assert.equal(f.q('#beta-ask-answer strong').textContent, 'New answer');
  assert.equal(f.q('#beta-ask-activity').hidden, false);
  assert.match(f.q('#beta-ask-log').textContent, /Read the saved passage/);
  f.q('#beta-ask-answer a').click();
  assert.equal(f.window.document.activeElement.id, 'ask-source-1');
  assert.equal(f.q('#beta-ask-submit').disabled, true);
  f.q('#beta-ask-clear').click();
  assert.equal(f.q('#beta-ask-input').value, '');
  assert.equal(f.q('#beta-ask-answer').hidden, true);
  assert.equal(f.q('#beta-ask-sources').children.length, 0);
  assert.equal(f.q('#beta-ask-activity').hidden, true);
});

test('Clear stays clear if cancellation fails later', async t => {
  const cancel = deferred(), answer = deferred();
  const f = await ui('sidepanel', { ASK_QUESTION: () => answer.promise, CANCEL_ASK: () => cancel.promise }); t.after(f.close);
  f.q('#beta-ask-memory').click();
  f.q('#beta-ask-input').value = 'Question'; f.submit('#beta-ask-form'); f.q('#beta-ask-clear').click();
  cancel.reject(Error('connection lost')); answer.resolve({ answer: 'Old answer' }); await tick();
  assert.equal(f.q('#beta-ask-status').textContent, '');
  assert.equal(f.q('#beta-ask-answer').hidden, true);
});

test('Search puts matches first, hides recents, and discards replies after Clear', async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { SEARCH_QUERY: () => pending.promise }); t.after(f.close);
  f.q('#beta-search-input').value = 'cats'; f.submit('#beta-search-form');
  assert.equal(f.q('#beta-recents-section').hidden, true);
  f.q('#beta-search-clear').click();
  pending.resolve({ results: [{ ...pages[0], score: .8, snippet: 'A match' }] }); await tick();
  assert.equal(f.q('#beta-recents-section').hidden, false);
  assert.equal(f.q('#beta-search-results').children.length, 0);
  f.q('#beta-search-input').value = 'cats'; f.submit('#beta-search-form'); await tick();
  const results = f.q('#beta-search-results');
  assert.equal(results.children.length, 1);
  assert.ok(results.compareDocumentPosition(f.q('#beta-recents-section')) & f.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.match(results.textContent, /Not reranked/);
});

test('answer formatting never interprets raw HTML or unsafe links', async () => {
  const dom = new JSDOM('<div id="answer"></div>');
  try {
    const { renderAnswer } = await loadSource('src/ui/shared/answer.ts', '', {}, { document: dom.window.document });
    const target = dom.window.document.querySelector('#answer');
    renderAnswer(target, '# Title\n\n**Key idea**\n- Fact [2]\n- Unknown [99]\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n[unsafe](javascript:alert(1))\n\n```html\n<svg onload=alert(1)>\n```', [2]);
    assert.equal(target.querySelectorAll('script,img,svg').length, 0);
    assert.equal(target.querySelectorAll('a').length, 1);
    assert.equal(target.querySelector('a').getAttribute('href'), '#ask-source-2');
    assert.equal(target.querySelectorAll('li').length, 2);
    assert.match(target.textContent, /\[99\]/);
    assert.match(target.querySelector('pre').textContent, /<svg/);
  } finally { dom.window.close(); }
});

test('Logs exact Debug filter excludes higher levels and counts visible entries', async t => {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  t.after(async () => (await db.openDatabase()).close());
  const logger = await loadSource('src/shared/logger/index.ts', '', { '../db/index': { saveLog: db.saveLog } }, { console: { info() {}, error() {} } });
  logger.setLogLevel('debug');
  for (const level of ['debug', 'info', 'error']) await logger.log(level, level + ' entry');
  logger.setLogLevel('off');
  await logger.log('error', 'must not be saved');
  const entries = await db.listLogs();
  assert.deepEqual(Array.from(entries, entry => entry.level).sort(), ['debug', 'error', 'info']);
  const f = await ui('logs', { GET_LOGS: () => ({ logs: entries }) }); t.after(f.close);
  f.change('#logs-level', 'debug');
  assert.equal(f.window.document.querySelectorAll('.log-entry').length, 1);
  assert.match(f.q('#logs-list').textContent, /debug entry/);
  assert.equal(f.q('#logs-status').textContent, 'Showing 1 of 3 entries');
  assert.match(f.q('#logs-settings-link').href, /#settings-logging$/);
});

test('Memory exports the current filter as portable JSON through the saved-page transfer', async t => {
  const backend = providerFixture('http://localhost:11434');
  await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ url: 'https://export.test/cats', title: 'Cat notes', text: 'Saved cat evidence', timestamp: 10, chunks: [] });
  await db.savePageRecord({ url: 'https://export.test/dogs', title: 'Dog notes', text: 'Saved dog evidence', timestamp: 20, chunks: [] });
  const view = await ui('manage', {}, backend);
  t.after(view.close);
  await waitFor(() => /2 pages/.test(view.q('#manage-count').textContent), 'saved page list');
  view.q('#manage-search').value = 'cat';
  view.q('#manage-search').dispatchEvent(new view.window.Event('input'));
  view.change('#manage-export-scope', 'filtered');
  view.change('#manage-export-format', 'json');
  let output = '', done = false;
  view.window.showSaveFilePicker = async () => ({
    createWritable: async () => ({ write: async part => { output += part; }, close: async () => { done = true; }, abort: async () => {} })
  });
  view.submit('#manage-export-pages');
  await waitFor(() => done, 'portable export to close');
  assert.deepEqual(JSON.parse(output).pages.map(item => [item.title, item.text]), [['Cat notes', 'Saved cat evidence']]);
});

test('Settings streams a backup through registered messages and validates it before restoring any pages', async t => {
  const backend = providerFixture('http://localhost:11434');
  await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  t.after(async () => (await db.openDatabase()).close());
  const captured = [
    { url: 'https://backup.test/a', title: 'First', text: 'é'.repeat(600_000), timestamp: 10, manual: true, chunks: [{ text: 'First passage', embedding: [1, 0], embeddingKey: 'saved-model' }] },
    { url: 'https://backup.test/b', title: 'Second', text: 'Second passage', timestamp: 20, manual: false, chunks: [] }
  ];
  for (const page of captured) await db.savePageRecord(page);
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  await openStorage(f);
  const writes = [];
  let closed = false, aborted = false;
  f.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async part => { writes.push(part); }, close: async () => { closed = true; }, abort: async () => { aborted = true; } }) });
  f.q('#manage-export').click();
  await waitFor(() => closed, 'the backup file to close');
  assert.equal(aborted, false);
  assert.equal(f.q('#settings-backup-status').textContent, 'Export complete: 2 pages');
  assert.ok(!f.requests.some(request => request.type === 'GET_ALL_PAGES'));
  assert.deepEqual(writes.map(part => JSON.parse(part)).filter(record => record.type === 'page').map(record => record.page.url), captured.map(page => page.url));
  assert.deepEqual(JSON.parse(writes.at(-1)), { type: 'end', pages: 2 });
  await db.deletePages(captured.map(page => page.url));
  const input = f.q('#manage-import');
  const importFile = async file => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new f.window.Event('change'));
    await waitFor(() => !input.disabled, 'the import to finish');
  };
  await importFile(new File(writes.slice(0, -1), 'truncated.jsonl'));
  assert.match(f.q('#settings-backup-status').textContent, /incomplete/i);
  assert.equal((await db.listAllPages()).length, 0);
  await importFile(new File([...writes.slice(0, -1), '{"type":"page-end","url":"https://wrong.test/","versionCount":0}\n', writes.at(-1)], 'late-corruption.jsonl'));
  assert.match(f.q('#settings-backup-status').textContent, /backup|frame/i);
  assert.equal((await db.listAllPages()).length, 0, 'A corrupt late frame must not restore even an earlier valid page');
  await importFile(new File(writes, 'backup.jsonl'));
  assert.equal(f.q('#settings-backup-status').textContent, 'Import complete: 2 pages');
  for (const page of captured) {
    const restored = await db.getPageRecord(page.url);
    assert.equal(restored.text, page.text);
    assert.equal(restored.timestamp, page.timestamp);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.chunks)), page.chunks);
  }
  await importFile(new File([JSON.stringify({ schemaVersion: 1, pages: [{ ...captured[1], url: 'https://legacy.test/article' }] })], 'legacy.json'));
  assert.equal((await db.getPageRecord('https://legacy.test/article')).text, 'Second passage');
  f.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => { throw Error('Disk full'); }, abort: async () => { aborted = true; } }) });
  f.q('#manage-export').click();
  await waitFor(() => !f.q('#manage-export').disabled, 'the failed save to release controls');
  assert.equal(aborted, true);
  assert.match(f.q('#settings-backup-status').textContent, /Disk full/);
});

test('Settings Stop aborts an unfinished backup file and leaves Export available for a fresh transfer', async testContext => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'); testContext.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ url: 'https://backup.test/page', title: 'Evidence', text: 'Saved text', chunks: [], timestamp: 1 });
  const state = await ui('sidepanel', {}, backend); testContext.after(state.close);
  await openStorage(state);
  const blocked = deferred(), started = deferred(); let aborted = false, closed = false;
  state.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async line => { if (JSON.parse(line).type === 'page') { started.resolve(); await blocked.promise; } }, abort: async () => { aborted = true; }, close: async () => { closed = true; } }) });
  state.q('#manage-export').click(); await started.promise;
  try {
    assert.equal(state.q('#settings-transfer-stop').hidden, false);
    state.q('#settings-transfer-stop').click();
    await waitFor(() => aborted, 'Stop to abort the writable file');
  } finally { blocked.resolve(); }
  await waitFor(() => !state.q('#manage-export').disabled, 'cancelled export controls');
  assert.equal(closed, false); assert.equal(state.q('#settings-backup-status').textContent, 'Export cancelled');
  assert.equal(state.q('#settings-transfer-stop').hidden, true);
  state.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => {}, abort: async () => {}, close: async () => { closed = true; } }) });
  state.q('#manage-export').click(); await waitFor(() => closed && !state.q('#manage-export').disabled, 'fresh export completion');
  assert.match(state.q('#settings-backup-status').textContent, /Export complete: 1 pages/);
});

test('a lost backup worker aborts the output instead of closing a plausible incomplete file', async testContext => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'); testContext.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ url: 'https://backup.test/page', title: 'Evidence', text: 'Saved text', chunks: [], timestamp: 1 });
  const state = await ui('sidepanel', {}, backend); testContext.after(state.close);
  await openStorage(state);
  let aborted = false, closed = false;
  state.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async line => { if (JSON.parse(line).type === 'page') backend.ports.at(-1).worker.disconnect(); }, abort: async () => { aborted = true; }, close: async () => { closed = true; } }) });
  state.q('#manage-export').click();
  await waitFor(() => aborted && !state.q('#manage-export').disabled, 'worker loss to abort output and release controls');
  assert.equal(closed, false);
  assert.match(state.q('#settings-backup-status').textContent, /Export failed: Backup connection (lost|closed)/);
  assert.doesNotMatch(state.q('#settings-backup-status').textContent, /Export complete/);
});

test('Settings Stop restores only complete acknowledged pages and releases a stalled file reader', async testContext => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'); testContext.after(async () => (await db.openDatabase()).close());
  const send = backend.send;
  const pendingRefresh = deferred();
  let holdRefresh = false, refreshReads = 0;
  backend.send = message => {
    if (message.type !== 'GET_PAGE_LIST' || !holdRefresh) return send(message);
    refreshReads++;
    return pendingRefresh.promise.then(() => send(message));
  };
  const state = await ui('sidepanel', {}, backend); testContext.after(state.close);
  await openStorage(state);
  const first = { url: 'https://backup.test/a', title: 'First', text: 'First evidence', chunks: [], timestamp: 1 };
  const second = { ...first, url: 'https://backup.test/b', title: 'Second', text: 'Second evidence' };
  const frames = [{ format: 'web-recall', schemaVersion: 3 }, { type: 'page', page: first, versionCount: 0 }, { type: 'page-end', url: first.url, versionCount: 0 }, { type: 'page', page: second, versionCount: 0 }, { type: 'page-end', url: second.url, versionCount: 0 }, { type: 'end', pages: 2 }].map(frame => JSON.stringify(frame) + '\n');
  const file = new File(frames, 'stoppable.jsonl'); let passes = 0, readerCancelled = false;
  const initialStream = file.stream.bind(file);
  Object.defineProperty(file, 'stream', { value: () => ++passes === 1 ? initialStream() : new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frames.slice(0, 4).join(''))); }, cancel() { readerCancelled = true; } }) });
  Object.defineProperty(state.q('#manage-import'), 'files', { configurable: true, value: [file] });
  state.q('#manage-import').dispatchEvent(new state.window.Event('change'));
  await waitFor(() => state.q('#settings-backup-status').textContent === 'Importing… 1 of 2 pages', 'first complete page acknowledgement');
  state.q('a[data-view="manage"]').click(); await state.settle();
  holdRefresh = true;
  try {
    state.q('a[data-view="settings"]').click();
    state.q('#settings-transfer-stop').click();
    state.q('a[data-view="manage"]').click();
    const readsOnNavigation = refreshReads;
    await waitFor(() => refreshReads > readsOnNavigation, 'a new list read after Stop, beyond switching views');
    await waitFor(() => !state.q('#manage-import').disabled, 'stopped import controls to release before the list read returns');
    assert.equal(readerCancelled, true);
    assert.equal(state.q('#settings-backup-status').textContent, 'Import stopped: 1 pages restored');
  } finally { pendingRefresh.resolve(); }
  await state.settle();
  assert.equal(state.q('#settings-backup-status').textContent, 'Import stopped: 1 pages restored', 'Refreshing the list does not replace the confirmed outcome');
  assert.equal((await db.getPageRecord(first.url)).text, first.text);
  assert.equal(await db.getPageRecord(second.url), undefined);
  assert.equal(state.q('#manage-count').textContent, '1 page', 'The list must reflect the committed page without reopening Memory');
  assert.match(state.q('#manage-rows').textContent, /First/);
  assert.doesNotMatch(state.q('#manage-rows').textContent, /Second/);
});

test('Memory targets one page, reports progress there, and makes replacement opt-in', async t => {
  const pending = deferred();
  const f = await ui('manage', { BACKFILL_EMBEDDINGS: () => pending.promise }); t.after(f.close);
  assert.match(f.q('#manage-backfill-run').textContent, /Fill missing/);
  assert.equal(f.q('#manage-backfill-force').checked, false);
  assert.equal(f.q('#manage-rows input').getAttribute('aria-label'), 'Select Cats');
  f.q('[aria-label="Re-embed Cats"]').click();
  const request = f.requests.find(m => m.type === 'BACKFILL_EMBEDDINGS');
  assert.deepEqual([...request.urls], [pages[0].url]); assert.equal(request.limit, 1); assert.equal(request.force, true);
  assert.equal(request.createSummaries, true, 'individual Re-embed must also fill a missing summary without relying on the bulk checkbox');
  assert.equal(request.regenerateSummaries, false, 'individual Re-embed must continue preserving saved summaries');
  assert.equal(f.q('#manage-backfill-run').disabled, true);
  f.emit({ type: 'BACKFILL_PROGRESS', requestId: 'other', url: pages[0].url, status: 'error', completed: 0, total: 1 });
  assert.equal(f.q('.wr-row-progress'), null);
  f.emit({ type: 'BACKFILL_PROGRESS', requestId: request.requestId, url: pages[0].url, status: 'running', completed: 0, total: 1 });
  assert.equal(f.q('.wr-row-progress').textContent, 'Embedding…');
  pending.resolve({ result: { processed: 1, updated: 1, failed: 0, updatedUrls: [pages[0].url] } }); await tick();
  assert.equal(f.q('#manage-backfill-run').disabled, false);
  assert.match(f.q('#manage-backfill-status').textContent, /updated 1/);
  f.q('#manage-backfill-force').click();
  assert.match(f.q('#manage-backfill-run').textContent, /Re-embed/);
});

const memorySummaryStatus = fixture => Array.from(fixture.window.document.querySelectorAll('.memory-facts dt')).find(label => label.textContent === 'Summary')?.nextElementSibling?.textContent;

for (const hasSummary of [undefined, false, true]) test(`Memory distinguishes ${String(hasSummary)} summary metadata without inventing a missing summary`, async t => {
  const fixture = await ui('manage', { GET_PAGE_LIST: () => ({ pages: [{ ...pages[0], hasSummary }] }) });
  t.after(fixture.close);
  assert.equal(memorySummaryStatus(fixture), hasSummary === true ? 'Ready' : hasSummary === false ? 'Not saved yet' : 'Unavailable — reload extension');
});

test('Memory refreshes a completed background summary without starting another generation', async t => {
  let hasSummary = false;
  const fixture = await ui('manage', { GET_PAGE_LIST: () => ({ pages: [{ ...pages[0], hasSummary }] }) });
  t.after(fixture.close);
  hasSummary = true;
  fixture.emit({ type: 'SUMMARY_UPDATED', url: pages[0].url });
  await fixture.settle();
  assert.equal(memorySummaryStatus(fixture), 'Ready');
  assert.ok(!fixture.requests.some(message => message.type === 'REGENERATE_PAGE_SUMMARY' || message.type === 'BACKFILL_EMBEDDINGS'));
});

test('an older Memory refresh cannot replace newer saved-summary metadata', async t => {
  const stale = deferred();
  let loads = 0;
  const fixture = await ui('manage', {
    GET_PAGE_LIST: () => ++loads === 2 ? stale.promise : { pages: [{ ...pages[0], hasSummary: loads >= 3 }] }
  });
  t.after(fixture.close);
  fixture.q('#app-root').dispatchEvent(new fixture.window.Event('wr-refresh'));
  fixture.emit({ type: 'SUMMARY_UPDATED', url: pages[0].url });
  await waitFor(() => memorySummaryStatus(fixture) === 'Ready', 'the completed summary metadata');
  stale.resolve({ pages: [{ ...pages[0], hasSummary: false }] });
  await fixture.settle();
  assert.equal(memorySummaryStatus(fixture), 'Ready');
});

test('Memory regenerates exactly one summary without bulk backfill or embedding work', async t => {
  const pending = deferred();
  const other = { ...pages[0], url: 'https://example.test/dogs', title: 'Dogs' };
  const fixture = await ui('manage', { GET_PAGE_LIST: () => ({ pages: [pages[0], other] }), REGENERATE_PAGE_SUMMARY: () => pending.promise }); t.after(fixture.close);
  fixture.q('[aria-label="Regenerate summary Cats"]').click();
  const request = fixture.requests.find(message => message.type === 'REGENERATE_PAGE_SUMMARY');
  assert.equal(request.url, pages[0].url);
  assert.equal(fixture.requests.some(message => message.type === 'BACKFILL_EMBEDDINGS'), false);
  assert.equal(fixture.q('[aria-label="Regenerate summary Dogs"]').disabled, true);
  assert.equal(fixture.q('[aria-label="Re-embed Cats"]').disabled, true);
  assert.match(fixture.q('.wr-row-progress').textContent, /Summarizing/);
  pending.resolve({ updated: true });
  await waitFor(() => Boolean(fixture.q('[aria-label="Regenerate summary Cats"]')), 'summary controls to recover');
  assert.match(fixture.q('#manage-status').textContent, /Summary regenerated/);
  assert.equal(fixture.q('[aria-label="Regenerate summary Dogs"]').disabled, false);
  assert.equal(fixture.q('#manage-backfill-regenerate-summaries').checked, false);
});

test('successful summary regeneration preserves a subsequent Memory refresh failure', async t => {
  let regenerated = false;
  const fixture = await ui('manage', {
    GET_PAGE_LIST: () => regenerated ? { error: 'Library read failed' } : { pages },
    REGENERATE_PAGE_SUMMARY: () => { regenerated = true; return { updated: true }; }
  }); t.after(fixture.close);
  fixture.q('[aria-label="Regenerate summary Cats"]').click(); await fixture.settle();
  assert.match(fixture.q('#manage-status').textContent, /Summary regenerated/);
  assert.match(fixture.q('#manage-status').textContent, /refresh Memory.*Library read failed/i);
  assert.equal(fixture.q('#manage-status').classList.contains('danger'), true);
  assert.equal(fixture.requests.filter(request => request.type === 'REGENERATE_PAGE_SUMMARY').length, 1);
  assert.ok(fixture.q('[aria-label="Regenerate summary Cats"]'), 'The previous page view remains available');
});

test('invalidated per-page conversations release runtime subscriptions and stop active work exactly once', async t => {
  const pending = deferred();
  const fixture = await ui('sidepanel', { GET_PAGE_PREVIEW: () => ({ page: { snippet: 'Saved content.' } }), ASK_QUESTION: () => pending.promise }); t.after(fixture.close);
  await fixture.settle();
  const initialListeners = fixture.listenerCount();
  for (let cycle = 0; cycle < 5; cycle++) {
    fixture.q('#beta-recents-list .ask-this-page').click();
    assert.equal(fixture.listenerCount(), initialListeners + 1);
    fixture.window.dispatchEvent(new fixture.window.Event('wr-memory-changed')); await fixture.settle();
    assert.equal(fixture.listenerCount(), initialListeners, 'Discarded page conversations must release their event subscriptions');
  }
  fixture.q('#beta-recents-list .ask-this-page').click();
  fixture.q('#beta-ask-input').value = 'Question'; fixture.submit('#beta-ask-form');
  const request = fixture.requests.find(message => message.type === 'ASK_QUESTION');
  fixture.window.dispatchEvent(new fixture.window.Event('wr-memory-changed')); await tick();
  assert.equal(fixture.listenerCount(), initialListeners);
  assert.deepEqual(fixture.requests.filter(message => message.type === 'CANCEL_ASK').map(message => message.requestId), [request.options.requestId]);
  pending.resolve({ answer: 'Stale answer', sources: [] }); await fixture.settle();
  fixture.q('#beta-recents-list .ask-this-page').click();
  assert.doesNotMatch(fixture.q('#beta-ask-answer').textContent, /Stale answer/);
});

for (const progressDelivered of [true, false]) test(`Memory retains embedding failure details after a successful summary, with progress ${progressDelivered ? 'delivered' : 'missed'}`, async t => {
  const pending = deferred();
  let hasSummary = false;
  const fixture = await ui('manage', {
    GET_PAGE_LIST: () => ({ pages: [{ ...pages[0], embeddingStatus: '', hasEmbeddings: false, hasSummary }] }),
    BACKFILL_EMBEDDINGS: () => pending.promise
  });
  t.after(fixture.close);
  const reason = 'This browser model is not downloaded. Open Settings to download it.';
  fixture.q('[aria-label="Re-embed Cats"]').click();
  const request = fixture.requests.find(message => message.type === 'BACKFILL_EMBEDDINGS');
  if (progressDelivered) {
    fixture.emit({ type: 'BACKFILL_PROGRESS', requestId: request.requestId, url: pages[0].url, status: 'error', completed: 1, total: 1, error: reason });
    fixture.emit({ type: 'BACKFILL_PROGRESS', requestId: request.requestId, url: pages[0].url, phase: 'summaries', status: 'running', completed: 0, total: 1 });
    fixture.emit({ type: 'BACKFILL_PROGRESS', requestId: request.requestId, url: pages[0].url, phase: 'summaries', status: 'complete', completed: 1, total: 1 });
    assert.match(fixture.q('#manage-rows').textContent, /Embeddings failed: This browser model is not downloaded/);
  }
  hasSummary = true;
  pending.resolve({ result: { processed: 1, updated: 0, failed: 1, summariesUpdated: 1, summariesFailed: 0, failures: [{ url: pages[0].url, phase: 'embeddings', error: reason }] } });
  await fixture.settle();
  const text = fixture.q('#manage-rows').textContent;
  assert.match(text, /Embeddings failed: This browser model is not downloaded/);
  assert.match(text, /SummaryReady/);
  assert.match(fixture.q('#manage-status').textContent, /Embeddings:.*failed 1.*Summaries: 1 created, 0 failed/);
});

for (const failure of ['cancel', 'provider']) test(`individual summary ${failure} restores controls and reports that saved summaries are preserved`, async t => {
  const pending = deferred();
  const fixture = await ui('manage', { REGENERATE_PAGE_SUMMARY: () => pending.promise }); t.after(fixture.close);
  fixture.q('[aria-label="Regenerate summary Cats"]').click();
  const request = fixture.requests.find(message => message.type === 'REGENERATE_PAGE_SUMMARY');
  if (failure === 'cancel') {
    fixture.q('[aria-label="Stop summary Cats"]').click();
    assert.equal(fixture.requests.find(message => message.type === 'CANCEL_BACKFILL').requestId, request.requestId);
  }
  pending.reject(new Error(failure === 'cancel' ? 'Stopped by user' : 'Model unavailable'));
  await waitFor(() => Boolean(fixture.q('[aria-label="Regenerate summary Cats"]')), 'summary controls to recover');
  assert.match(fixture.q('#manage-status').textContent, failure === 'cancel' ? /Stopped.*preserved/ : /Model unavailable.*kept/);
  assert.equal(fixture.q('[aria-label="Regenerate summary Cats"]').disabled, false);
});

test('Search Stop cancels the request and discards late results; Clear also cancels', async t => {
  const pending=deferred();
  const f=await ui('sidepanel',{SEARCH_QUERY:()=>pending.promise,CANCEL_SEARCH:()=>({cancelled:true})}); t.after(f.close);
  f.q('#beta-search-input').value='slow query'; f.submit('#beta-search-form');
  const first=f.requests.find(m=>m.type==='SEARCH_QUERY');
  assert.equal(f.q('#beta-search-stop').hidden,false);
  f.q('#beta-search-stop').click();
  assert.equal(f.requests.find(m=>m.type==='CANCEL_SEARCH').requestId,first.requestId);
  pending.resolve({results:[{...pages[0],score:.8,snippet:'late'}]}); await tick();
  assert.match(f.q('#beta-search-status').textContent,/Stopped/);
  assert.equal(f.q('#beta-search-results').children.length,0);
  assert.equal(f.q('#beta-search-stop').hidden,true);
  f.submit('#beta-search-form'); f.q('#beta-search-clear').click(); await tick();
  assert.equal(f.requests.filter(m=>m.type==='CANCEL_SEARCH').length,2);
  assert.equal(f.q('#beta-search-status').textContent,'1 page');
});

test('Memory Stop targets the running backfill and restores controls when cancelled', async t => {
  const pending=deferred();
  const f=await ui('manage',{BACKFILL_EMBEDDINGS:()=>pending.promise,CANCEL_BACKFILL:()=>({cancelled:true})}); t.after(f.close);
  f.q('#manage-backfill-run').click(); await tick();
  const request=f.requests.find(m=>m.type==='BACKFILL_EMBEDDINGS');
  assert.equal(f.q('#manage-backfill-stop').hidden,false);
  f.q('#manage-backfill-stop').click();
  assert.equal(f.requests.find(m=>m.type==='CANCEL_BACKFILL').requestId,request.requestId);
  pending.resolve({error:'Stopped by user'}); await tick(); await tick();
  assert.equal(f.q('#manage-backfill-stop').hidden,true);
  assert.equal(f.q('#manage-backfill-run').disabled,false);
  assert.match(f.q('#manage-backfill-status').textContent,/Stopped.*existing vectors/);
});

test('inline preview and source chooser send exact saved-page scopes and preserve the draft', async t => {
  const more = { ...pages[0], url: 'https://example.test/dogs', title: 'Dogs' };
  const f = await ui('sidepanel', {
    GET_PAGE_LIST: () => ({ pages: [pages[0], more] }),
    GET_PAGE_PREVIEW: message => ({ page: { ...pages[0], url: message.url, snippet: 'Saved passage from the actual capture.' } }),
    SEARCH_QUERY: () => ({ results: [pages[0], more].map(page => ({ ...page, snippet: 'Matched saved passage', score: .8 })) }),
    ASK_QUESTION: message => ({ answer: 'Supported fact [1]', sources: [{ ...pages[0], url: message.options.scopeUrls[0], snippet: 'Supporting sentence', index: 1, domain: 'example.test' }] })
  }); t.after(f.close);
  f.q('#beta-search-input').value = 'pets'; f.submit('#beta-search-form'); await tick();
  const page = f.q('#beta-search-results details'); page.open = true;
  f.q('#beta-search-results .ask-this-page').click();
  assert.equal(f.q('#beta-ask-submit').disabled, true);
  f.q('#beta-ask-input').value = 'What matters?'; f.submit('#beta-ask-form'); await tick();
  assert.deepEqual([...f.requests.find(message => message.type === 'ASK_QUESTION').options.scopeUrls], [pages[0].url]);
  f.q('#beta-ask-answer a').click();
  assert.equal(f.q('#ask-source-1 details').open, true);
  f.q('#beta-ask-close').click();
  f.q('#beta-ask-results').click();
  assert.equal(f.q('#beta-ask-results').hidden, true);
  f.q('#beta-ask-input').value = 'Compare the selected pages';
  const checkbox = f.q('#beta-source-options input'); checkbox.checked = false; checkbox.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.q('#beta-ask-input').value, 'Compare the selected pages');
  assert.equal(f.q('#beta-source-label').textContent, 'Using 1 page');
  f.submit('#beta-ask-form'); await tick();
  assert.deepEqual([...f.requests.filter(message => message.type === 'ASK_QUESTION').at(-1).options.scopeUrls], [more.url]);
  f.q('a[data-view="settings"]').click();
  f.q('#beta-view-settings .utility-back').click();
  assert.equal(f.q('#beta-search-input').value, 'pets');
  assert.match(f.q('#beta-ask-answer').textContent, /Supported fact/);
});

test('item chats continue across navigation and isolate streaming, completion and Stop', async t => {
  const first = deferred(), second = deferred();
  const dog = { ...pages[0], url: 'https://example.test/dogs', title: 'Dogs' };
  const fixture = await ui('sidepanel', {
    GET_PAGE_LIST: () => ({ pages: [pages[0], dog] }),
    GET_PAGE_PREVIEW: () => ({ page: { snippet: 'Saved content.' } }),
    ASK_QUESTION: message => message.options.scopeUrls[0] === dog.url ? second.promise : first.promise
  }); t.after(fixture.close);
  const rows = [...fixture.window.document.querySelectorAll('#beta-recents-list > article')];
  rows[0].querySelector('details').open = true;
  rows[0].querySelector('.ask-this-page').click();
  fixture.q('#beta-ask-input').value = 'Question for cats'; fixture.submit('#beta-ask-form');
  const catId = fixture.requests.find(message => message.type === 'ASK_QUESTION').options.requestId;
  rows[0].querySelector('details').open = false; await tick();
  rows[1].querySelector('details').open = true;
  rows[1].querySelector('.ask-this-page').click();
  fixture.q('#beta-ask-input').value = 'Question for dogs'; fixture.submit('#beta-ask-form');
  const dogId = fixture.requests.filter(message => message.type === 'ASK_QUESTION').at(-1).options.requestId;
  assert.equal(fixture.requests.filter(message => message.type === 'CANCEL_ASK').length, 0);
  assert.match(rows[0].querySelector('.wr-item-ask-state').textContent, /Answering/);
  fixture.emit({ type: 'ASK_ANSWER_UPDATE', requestId: catId, chunk: 'Cat draft' });
  fixture.emit({ type: 'ASK_ANSWER_UPDATE', requestId: dogId, chunk: 'Dog draft' });
  assert.equal(fixture.q('#beta-ask-answer').textContent, 'Dog draft');
  rows[0].querySelector('details').open = true;
  rows[0].querySelector('.ask-this-page').click();
  assert.equal(fixture.q('#beta-ask-answer').textContent, 'Cat draft');
  assert.equal(fixture.q('#beta-ask-stop').hidden, false);
  rows[1].querySelector('details').open = true;
  rows[1].querySelector('.ask-this-page').click();
  first.resolve({ answer: 'Cats final [1]', sources: [{ ...pages[0], index: 1 }], outcome: 'answered' }); await tick();
  assert.equal(fixture.q('#beta-ask-answer').textContent, 'Dog draft');
  assert.equal(rows[0].querySelector('.wr-item-ask-state').textContent, 'Answer ready');
  fixture.q('#beta-ask-stop').click();
  assert.deepEqual(fixture.requests.filter(message => message.type === 'CANCEL_ASK').map(message => message.requestId), [dogId]);
  second.resolve({ answer: 'Late dog answer', sources: [] }); await tick();
  rows[0].querySelector('details').open = true;
  rows[0].querySelector('.ask-this-page').click();
  assert.match(fixture.q('#beta-ask-answer').textContent, /Cats final/);
  assert.equal(fixture.window.document.querySelectorAll('#beta-ask-host').length, 1);
});

test('saved previews start compact and Show more reveals the same saved text without inference', async t => {
  const text = 'A complete opening sentence. ' + 'More saved details about the article. '.repeat(28);
  const fixture = await ui('sidepanel', { GET_PAGE_PREVIEW: () => ({ page: { snippet: text } }) }); t.after(fixture.close);
  const row = fixture.q('#beta-recents-list > article'); row.querySelector('details').open = true; await tick();
  const toggle = row.querySelector('.preview-toggle'), passage = row.querySelector('.content-entry-body > p');
  await waitFor(() => !toggle.hidden, 'the saved preview to load');
  assert.ok(passage.textContent.length < 265);
  assert.match(passage.textContent, /[.!?…]$/);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click(); assert.equal(passage.textContent, text.trim());
  assert.equal(toggle.textContent, 'Show less'); assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click(); assert.ok(passage.textContent.length < 265);
  assert.equal(fixture.requests.filter(message => message.type === 'ASK_QUESTION').length, 0);
});

test('open previews update when background summaries finish and backfill summaries require an explicit choice', async t => {
  let ready = false;
  const fixture = await ui('sidepanel', {
    GET_PAGE_PREVIEW: () => ({ page: { snippet: ready ? 'New saved summary.' : 'Original saved text.', previewKind: ready ? 'summary' : 'excerpt' } }),
    BACKFILL_EMBEDDINGS: () => ({ result: { processed: 0, updated: 0, summariesUpdated: 1 } })
  }); t.after(fixture.close);
  fixture.q('#beta-recents-list details').open = true;
  await waitFor(() => fixture.q('#beta-recents-list .content-entry-body > p').textContent === 'Original saved text.', 'raw saved preview');
  ready = true; fixture.emit({ type: 'SUMMARY_UPDATED', url: pages[0].url });
  await waitFor(() => fixture.q('#beta-recents-list .content-entry-body > p').textContent === 'New saved summary.', 'summary preview');
  assert.equal(fixture.q('#beta-recents-list .content-entry-body > span').hidden, false);
  fixture.q('a[data-view="manage"]').click(); await tick();
  const maintenance = [...fixture.q('#beta-view-manage').querySelectorAll('summary')].find(summary => summary.textContent.trim() === 'Maintenance');
  maintenance.click();
  const controls = maintenance.closest('details[open]');
  const choice = controls.querySelector('#manage-backfill-summaries'); assert.equal(choice.checked, false);
  assert.equal(controls.querySelector('#manage-backfill-regenerate-summaries').checked, false);
  choice.checked = true; controls.querySelector('#manage-backfill-run').click(); await tick();
  assert.equal(fixture.requests.find(message => message.type === 'BACKFILL_EMBEDDINGS').createSummaries, true);
  assert.match(fixture.q('#manage-backfill-status').textContent, /Summaries: 1 created/);
});

test('regenerating summaries is an explicit bulk choice and does not force replacement embeddings', async t => {
  const fixture = await ui('manage', { BACKFILL_EMBEDDINGS: () => ({ result: { processed: 0, updated: 0, summariesUpdated: 1 } }) }); t.after(fixture.close);
  const regenerate = fixture.q('#manage-backfill-regenerate-summaries');
  assert.equal(regenerate.checked, false);
  regenerate.checked = true;
  fixture.q('#manage-backfill-run').click(); await tick();
  const request = fixture.requests.find(message => message.type === 'BACKFILL_EMBEDDINGS');
  assert.equal(request.regenerateSummaries, true);
  assert.equal(request.createSummaries, true);
  assert.equal(request.force, false);
});

test('changing the selected pages cancels Ask before accepting a late stream or answer', async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { GET_PAGE_LIST: () => ({ pages: [pages[0], { ...pages[0], url: 'https://example.test/dogs', title: 'Dogs' }] }), ASK_QUESTION: () => pending.promise }); t.after(f.close);
  f.q('#beta-ask-results').click(); f.q('#beta-ask-input').value = 'Compare'; f.submit('#beta-ask-form');
  const request = f.requests.find(message => message.type === 'ASK_QUESTION');
  const checkbox = f.q('#beta-source-options input'); checkbox.checked = false; checkbox.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.requests.find(message => message.type === 'CANCEL_ASK').requestId, request.options.requestId);
  f.emit({ type: 'ASK_ANSWER_UPDATE', requestId: request.options.requestId, chunk: 'Stale scope' });
  pending.resolve({ answer: 'Stale final', sources: [] }); await tick();
  assert.equal(f.q('#beta-ask-answer').hidden, true);
  assert.equal(f.q('#beta-ask-input').value, '', 'sending consumes the draft even when the source selection later changes');
});

test('menu mounts each real tool once and Memory reads the same backend library', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'); t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ ...pages[0], text: 'Real stored capture text.', chunks: [{ text: 'Real stored capture text.', embedding: [] }] });
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  f.q('a[data-view="manage"]').click(); await f.settle(); await tick();
  assert.match(f.q('#manage-rows').textContent, /Cats/);
  assert.equal(f.q('#manage-count').textContent, '1 page');
  f.q('#beta-view-manage .primary-button[href]').click(); await f.settle(); await tick();
  assert.match(f.q('#beta-search-results').textContent, /Real stored capture text/);
  f.q('a[data-view="logs"]').click(); await tick();
  f.q('#logs-settings-link').click();
  assert.equal(f.q('#settings-advanced').open, true);
  assert.equal(f.q('#settings-logging').open, true);
  await db.savePageRecord({ ...pages[0], url: 'https://example.test/dogs', title: 'Dogs', text: 'A new capture.', chunks: [{ text: 'A new capture.', embedding: [] }] });
  f.q('a[data-view="manage"]').click(); await tick();
  await f.settle(); await tick();
  assert.match(f.q('#manage-rows').textContent, /Dogs/);
  assert.equal(f.q('#manage-count').textContent, '2 pages');
  assert.equal(f.window.document.querySelectorAll('#manage-rows').length, 1);
  assert.equal(f.window.document.querySelectorAll('#beta-ask-form').length <= 1, true);
});

test('Refresh pages reruns the active query against the current library', async t => {
  let results = [{ ...pages[0], snippet: 'Saved text', score: .8 }];
  const f = await ui('sidepanel', { SEARCH_QUERY: () => ({ results }) }); t.after(f.close);
  f.q('#beta-search-input').value = 'pets'; f.submit('#beta-search-form'); await tick();
  assert.equal(f.q('#beta-search-status').textContent, '1 page');
  results = [...results, { ...pages[0], url: 'https://example.test/dogs', title: 'Dogs', snippet: 'New saved text', score: .7 }];
  f.q('#beta-refresh-recents').click(); await tick();
  assert.equal(f.q('#beta-search-input').value, 'pets');
  assert.equal(f.q('#beta-search-status').textContent, '2 pages');
  assert.match(f.q('#beta-search-results').textContent, /Dogs/);
});

test('follow-up questions keep history and older citations have unique targets', async t => {
  const f = await ui('sidepanel', { ASK_QUESTION: () => ({ answer: 'A fact [1]', sources: [{ ...pages[0], snippet: 'Evidence', index: 1, domain: 'example.test' }] }) }); t.after(f.close);
  f.q('#beta-ask-memory').click(); f.q('#beta-ask-input').value = 'First question'; f.submit('#beta-ask-form'); await tick();
  f.q('#beta-ask-input').value = 'Explain that'; f.submit('#beta-ask-form'); await tick();
  const request = f.requests.filter(message => message.type === 'ASK_QUESTION').at(-1);
  assert.equal(request.options.history[0].question, 'First question');
  const citation = f.q('#beta-ask-history .beta-ask-answer a'); citation.click();
  assert.equal(f.q('#ask-history-0-source-1 details').open, true);
  const ids = [...f.window.document.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(ids.length, new Set(ids).size);
});

test('Enter clears the composer immediately while prior answers remain visible during a follow-up', async t => {
  const pending = deferred(); let count = 0;
  const f = await ui('sidepanel', { ASK_QUESTION: () => ++count === 1 ? { answer: 'Earlier evidence [1]', sources: [{ ...pages[0], snippet: 'Evidence', index: 1, domain: 'example.test' }] } : pending.promise }); t.after(f.close);
  f.q('#beta-ask-memory').click(); f.q('#beta-ask-input').value = 'First question'; f.submit('#beta-ask-form'); await tick();
  f.q('#beta-ask-input').value = 'Explain the earlier answer';
  f.q('#beta-ask-form').requestSubmit = () => f.submit('#beta-ask-form');
  f.q('#beta-ask-input').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(f.q('#beta-ask-input').value, '');
  assert.match(f.q('#beta-ask-question').textContent, /Explain the earlier answer/);
  assert.match(f.q('#beta-ask-history').textContent, /First question/);
  assert.match(f.q('#beta-ask-history').textContent, /Earlier evidence/);
  assert.equal(f.q('#beta-ask-history > details').open, true);
  pending.resolve({ answer: 'More detail [1]', sources: [{ ...pages[0], index: 1 }] }); await tick();
  assert.match(f.q('#beta-ask-history').textContent, /Earlier evidence/);
});

test('parallel calls to the same tool keep separate activity rows and retain completion after rendering the answer', async t => {
  const pending = deferred();
  const f = await ui('sidepanel', { ASK_QUESTION: () => pending.promise }); t.after(f.close);
  f.q('#beta-ask-memory').click(); f.q('#beta-ask-input').value = 'Compare two passages'; f.submit('#beta-ask-form');
  const requestId = f.requests.find(message => message.type === 'ASK_QUESTION').options.requestId;
  for (const callId of ['one', 'two']) f.emit({ type: 'ASK_TOOL_ACTIVITY', requestId, event: { callId, tool: 'fetch_more', status: 'started' } });
  assert.equal(f.q('#beta-ask-log').children.length, 2, 'identical labels are different invocations');
  for (const callId of ['one', 'two']) f.emit({ type: 'ASK_TOOL_ACTIVITY', requestId, event: { callId, tool: 'fetch_more', status: 'completed', ms: 1 } });
  assert.match(f.q('[data-call-id="one"]').textContent, /completed/);
  assert.match(f.q('[data-call-id="two"]').textContent, /completed/);
  pending.resolve({ answer: 'Both passages agree [1]', sources: [{ ...pages[0], index: 1 }] }); await tick();
  assert.equal(f.q('#beta-ask-log').children.length, 2);
  assert.doesNotMatch(f.q('#beta-ask-log').textContent, /started/);
});

test('follow-ups round-trip the compact checkpoint while Clear discards its model context and visible history', async t => {
  const checkpoint = { schemaVersion: 1, scope: 'null', summary: 'We discussed Cedar.', turns: [], references: [{ index: 7, url: pages[0].url, title: 'Cedar' }] };
  const f = await ui('sidepanel', { ASK_QUESTION: () => ({ answer: 'Cedar [7]', sources: [{ ...pages[0], index: 7 }], conversation: checkpoint }) }); t.after(f.close);
  f.q('#beta-ask-memory').click(); f.q('#beta-ask-input').value = 'First'; f.submit('#beta-ask-form'); await tick();
  f.q('#beta-ask-input').value = 'Explain that'; f.submit('#beta-ask-form'); await tick();
  assert.deepEqual(f.requests.filter(message => message.type === 'ASK_QUESTION')[1].options.conversation, checkpoint);
  assert.match(f.q('#beta-ask-history').textContent, /First/);
  f.q('#beta-ask-clear').click();
  assert.equal(f.q('#beta-ask-history').children.length, 0);
  f.q('#beta-ask-input').value = 'New chat'; f.submit('#beta-ask-form'); await tick();
  assert.equal(f.requests.filter(message => message.type === 'ASK_QUESTION')[2].options.conversation, undefined);
  assert.equal(f.requests.filter(message => message.type === 'ASK_QUESTION')[2].options.history.length, 0);
});

test('an honest insufficient answer finishes without an error and a failed answer exposes retrieved pages for recovery', async t => {
  const f = await ui('sidepanel', { ASK_QUESTION: message => message.question === 'Missing budget?' ? { outcome: 'insufficient_evidence', answer: 'The saved plan has no budget.', sources: [] } : { outcome: 'failed', answer: 'The model could not finish.', sources: [{ ...pages[0], index: 1 }] } }); t.after(f.close);
  f.q('#beta-ask-memory').click(); f.q('#beta-ask-input').value = 'Missing budget?'; f.submit('#beta-ask-form'); await tick();
  assert.equal(f.q('#beta-ask-status').dataset.state, 'insufficient_evidence');
  assert.equal(f.q('#beta-ask-status').dataset.variant, 'info');
  f.q('#beta-ask-input').value = 'Try another question'; f.submit('#beta-ask-form'); await tick();
  assert.equal(f.q('#beta-ask-status').dataset.state, 'failed');
  assert.equal(f.q('#beta-ask-sources article').hidden, false);
  assert.match(f.q('#beta-ask-sources').textContent, /Retrieved pages/);
  assert.equal(f.q('#beta-ask-input').value, 'Try another question');
});

test('page Ask explains that automatic AI is off and keeps retrieved pages when a chat request fails', async testContext => {
  const requests = [];
  const backend = await recallFixture(testContext, { fetch: async input => {
    const endpoint = new URL(input).pathname;
    requests.push(endpoint);
    if (endpoint === '/api/tags') return Response.json({ models: [{ name: 'local-model' }] });
    if (endpoint === '/api/ps') return Response.json({ models: [{ name: 'local-model', context_length: 4096 }] });
    if (endpoint === '/api/embed') return Response.json({ embeddings: [[1, 0]] });
    throw new TypeError('Failed to connect to the chat server');
  } });
  await backend.send({ type: 'CAPTURE_ACTIVE_TAB' }); await backend.drain();
  await backend.send({ type: 'SET_SETTINGS', payload: { activeProviderId: 'ollama', captureSetupComplete: true, queryRewrite: false, askRerank: false, enableTools: false } });
  const fixture = await ui('sidepanel', {}, backend);
  testContext.after(fixture.close);
  await fixture.settle();
  fixture.q('#beta-recents-list details > summary').click();
  fixture.q('.ask-this-page').click();
  await fixture.settle();
  const note = () => [...fixture.q('#beta-ask-host').querySelectorAll('p:not([hidden])')].find(paragraph => /Automatic AI is off/i.test(paragraph.textContent));
  assert.match(note()?.textContent || '', /Automatic AI is off.*Ask.*chat model/i);
  assert.deepEqual(requests, [], 'Opening Ask does not contact a model');
  fixture.q('#beta-ask-input').value = 'Where do copper terns migrate?';
  fixture.submit('#beta-ask-form'); await fixture.settle();
  assert.ok(requests.includes('/api/chat'), 'Explicit Ask still attempts the selected chat model');
  assert.match(fixture.q('#beta-ask-answer').textContent, /could not generate an AI answer.*chat model.*Settings/i);
  assert.doesNotMatch(fixture.q('#beta-ask-answer').textContent, /returned an empty answer/i);
  assert.equal(fixture.q('#beta-ask-sources article').hidden, false);
  assert.match(fixture.q('#beta-ask-sources article').textContent, /Coastal field notes/);
  const { settings } = await backend.send({ type: 'SET_SETTINGS', payload: { automaticAi: true } });
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings });
  assert.equal(note(), undefined, 'An open Ask view must not still say automatic AI is off');
});

test('disabling chat hides every Ask entry point and keeps saved-page actions usable without reloading', async testContext => {
  const settings = { ...DEFAULT_SETTINGS, captureSetupComplete: true, recallSetupComplete: true, activeProviderId: 'disabled' };
  const fixture = await ui('sidepanel', {
    GET_SETTINGS: () => ({ settings }),
    GET_PROVIDERS: () => ({ providers: [{ id: 'ollama', name: 'Ollama', settings: [], actions: [], models: [] }] }),
    SET_SETTINGS: message => ({ settings: { ...settings, ...message.payload } })
  });
  testContext.after(fixture.close);
  const entry = fixture.q('#beta-recents-list details > summary');
  entry.click();
  assert.equal(fixture.q('#beta-ask-memory').hidden, true);
  assert.equal(fixture.q('#beta-ask-results').hidden, true);
  assert.equal(fixture.q('.ask-this-page').hidden, true);
  assert.equal(fixture.q('.read-saved-page').hidden, false);
  const live = fixture.q('#beta-recents-list .preview-actions a');
  assert.equal(live.href, pages[0].url);
  assert.match(live.textContent, /Open live page/);
  fixture.q('.ask-this-page').click();
  fixture.q('#beta-ask-results').click();
  fixture.q('#beta-ask-memory').click();
  assert.equal(fixture.q('#beta-ask-host'), null);
  assert.ok(!fixture.requests.some(message => message.type === 'ASK_QUESTION'));
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings: { ...settings, activeProviderId: 'ollama' } });
  assert.equal(fixture.q('#beta-ask-memory').hidden, false);
  assert.equal(fixture.q('#beta-ask-results').hidden, false);
  fixture.q('.ask-this-page').click();
  assert.ok(fixture.q('#beta-ask-host:not([hidden])'));
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings });
  assert.equal(fixture.q('#beta-ask-host'), null);
  assert.equal(fixture.window.document.activeElement, fixture.q('#beta-search-input'));
  assert.equal(fixture.q('#beta-ask-memory').hidden, true);
  assert.equal(fixture.q('#beta-ask-results').hidden, true);
  assert.equal(fixture.q('.ask-this-page').hidden, true);
  await openModels(fixture);
  assert.equal(fixture.q('#beta-provider-select').selectedOptions[0].textContent, 'Disabled');
  assert.equal(fixture.q('#beta-chat-provider-fields').hidden, true);
  assert.match(fixture.q('#beta-chat-disabled').textContent, /Choose a provider/);
});

test('an earlier Apple permission prompt cannot undo a later chat disable', async testContext => {
  const settings = { ...DEFAULT_SETTINGS, activeProviderId: 'ollama' };
  const permission = deferred();
  const fixture = await ui('sidepanel', {
    GET_SETTINGS: () => ({ settings }),
    GET_PROVIDERS: () => ({ providers: ['ollama', 'apple'].map(id => ({ id, name: id, settings: [], actions: [], models: [] })) })
  });
  testContext.after(fixture.close);
  let asked = false;
  fixture.permissions.request = () => { asked = true; return permission.promise; };
  await openModels(fixture);
  fixture.change('#beta-provider-select', 'apple');
  assert.equal(asked, true);
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings: { ...settings, activeProviderId: 'disabled' } });
  permission.resolve(true);
  await tick(); await fixture.settle();
  assert.equal(fixture.q('#beta-provider-select').value, 'disabled');
  assert.ok(!fixture.requests.some(message => message.type === 'SET_SETTINGS' && message.payload.activeProviderId === 'apple'));
});

test('an Apple safety block survives Ask and runtime messaging with actionable provider-specific UI', async t => {
  const backend = providerFixture('http://localhost:11434');
  Object.assign(backend.stored.betaSettings, { activeProviderId: 'apple', queryRewrite: false, askRerank: false, enableTools: false });
  const nativeRequests = [];
  backend.runtime.connectNative = () => {
    const listeners = [];
    return {
      onMessage: { addListener: listener => listeners.push(listener) },
      onDisconnect: { addListener() {} }, disconnect() {},
      postMessage(request) {
        nativeRequests.push(request);
        const event = request.action === 'status'
          ? { id: request.id, type: 'status', status: { protocolVersion: 2, available: true, contextTokens: 8192, mode: 'on-device', libraryTools: true } }
          : { id: request.id, type: 'error', text: 'Response may contain sensitive or unsafe content.' };
        queueMicrotask(() => listeners.forEach(listener => listener(event)));
      }
    };
  };
  const db = await backend.load('src/shared/db/index.ts');
  t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ ...pages[0], text: 'A saved page about cats.', chunks: [{ text: 'A saved page about cats.' }] });
  await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  f.q('#beta-ask-memory').click();
  f.q('#beta-ask-input').value = 'A question about cats'; f.submit('#beta-ask-form'); await f.settle();
  assert.match(f.q('#beta-ask-status').textContent, /Apple.*blocked.*safety/i);
  assert.doesNotMatch(f.q('#beta-ask-status').textContent, /Try again or check Settings|Ask failed:/);
  assert.match(f.q('#beta-ask-log').textContent, /Apple.*blocked.*safety/i);
  assert.equal(f.q('#beta-ask-input').value, 'A question about cats');
  assert.equal(f.q('#beta-ask-input').readOnly, false);
  assert.equal(f.q('#beta-ask-stop').hidden, true);
  assert.equal(nativeRequests.filter(request => request.action === 'generate').length, 1);
  assert.equal(backend.requests.some(request => new URL(request.url).pathname.endsWith('/api/chat')), false, 'A safety block must not fall back to HTTP chat');
});

test('unclassified failures retain generic guidance rather than falsely blaming Apple', async t => {
  const f = await ui('sidepanel', { ASK_QUESTION: () => ({ error: 'Response may contain sensitive or unsafe content.' }) }); t.after(f.close);
  f.q('#beta-ask-memory').click(); f.q('#beta-ask-input').value = 'A question'; f.submit('#beta-ask-form'); await f.settle();
  assert.match(f.q('#beta-ask-status').textContent, /Ask failed:.*Try again or check Settings/);
  assert.doesNotMatch(f.q('#beta-ask-status').textContent, /Apple/);
});

test('panel uses one contextual menu without a duplicate title across every real page', async t => {
  const f = await ui('sidepanel', { GET_LOGS: () => ({ logs: [] }), LIST_HIGHLIGHT_DATES: () => ({ dates: [], total: 0 }) }); t.after(f.close);
  assert.equal(f.q('.browser-header'), null);
  assert.ok(f.q('.search-row > .menu-anchor'));
  for (const view of ['settings', 'manage', 'highlights', 'logs', 'sidepanel']) {
    f.q(`a[data-view="${view}"]`).click(); await f.settle(); await tick();
    const target = f.q(`#beta-view-${view === 'sidepanel' ? 'search' : view}`);
    assert.equal(target.hidden, false);
    assert.ok(target.querySelector('.menu-anchor'));
    assert.equal(f.window.document.querySelectorAll('.menu-anchor').length, 1);
  }
});

test('capture queue hides when idle, opens from Menu and follows active and failed work', async t => {
  let queue = [];
  const f = await ui('sidepanel', { GET_PROCESSING: () => ({ queue }) }); t.after(f.close);
  const details = f.q('#beta-queue-section');
  assert.equal(details.hidden, true);
  [...f.window.document.querySelectorAll('.panel-menu button')].find(button => button.textContent === 'Capture queue').click(); await f.settle();
  assert.equal(details.hidden, false); assert.equal(details.open, true);
  details.open = false; await waitFor(() => details.hidden, 'the idle queue to hide after its native toggle event');
  assert.equal(details.hidden, true);
  queue = [{ ...pages[0], status: 'processing', textSaved: true, attempts: 1 }]; await f.poll();
  assert.equal(details.hidden, false); assert.equal(details.open, false);
  assert.match(f.q('#beta-queue-label').textContent, /1 saved page.*indexing/);
  assert.equal(f.q('#beta-capture-status button').disabled, true);
  queue[0].status = 'failed'; await f.poll();
  assert.match(f.q('#beta-queue-label').textContent, /1 indexing failed/);
  f.q('#beta-capture-status button').click(); await f.settle();
  assert.equal(f.requests.find(message => message.type === 'RETRY_PROCESSING').url, pages[0].url);
  queue = []; await f.poll(); assert.equal(details.hidden, true);
});

for (const delayed of ['providers', 'settings']) test(`Models summary reflects the saved Apple provider when ${delayed} loads last`, async t => {
  const pending = deferred();
  const settings = { ...DEFAULT_SETTINGS, activeProviderId: 'apple', captureSetupComplete: true, automaticAi: true, recallSetupComplete: true };
  const providers = [
    { id: 'ollama', name: 'Ollama', settings: [], models: [], actions: [], status: { online: false } },
    { id: 'apple', name: 'Apple Foundation Models', settings: [], models: [], actions: [], status: { online: true } }
  ];
  const fixture = await ui('sidepanel', {
    GET_SETTINGS: () => delayed === 'settings' ? pending.promise : { settings },
    GET_PROVIDERS: () => delayed === 'providers' ? pending.promise : { providers },
    GET_EMBEDDING_CONFIG: () => ({ config: { ...DEFAULT_EMBEDDING_CONFIG, provider: 'browser' } })
  });
  t.after(fixture.close);
  await openModels(fixture);
  if (delayed === 'providers') assert.doesNotMatch(fixture.q('#settings-models-summary').textContent, /Ollama chat/, 'Pending provider metadata must not claim a different active provider');
  pending.resolve(delayed === 'providers' ? { providers } : { settings });
  await fixture.settle();
  assert.equal(fixture.q('#beta-provider-select').value, 'apple');
  assert.equal(fixture.q('#settings-models-summary').textContent, 'In-browser embeddings · Apple Foundation Models chat');
  assert.equal(fixture.q('#beta-apple-options').hidden, false, 'The provider fields must agree with the saved selection');
  assert.match(fixture.q('#beta-provider-status').textContent, /Apple Foundation Models online/);
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings: { ...settings, activeProviderId: 'ollama' } });
  assert.equal(fixture.q('#settings-models-summary').textContent, 'In-browser embeddings · Ollama chat');
  assert.equal(fixture.q('#beta-apple-options').hidden, true);
});

test('Apple provider selection requests native access, keeps embeddings and requires explicit cloud confirmation', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const fixture = await ui('sidepanel', {}, backend); t.after(fixture.close); await fixture.settle();
  await openModels(fixture); await fixture.settle();
  const previousEmbedding = JSON.stringify(backend.stored.betaEmbeddingConfig);
  fixture.permissions.allowed = false;
  fixture.change('#beta-provider-select', 'apple'); await fixture.settle(); await tick();
  assert.equal(backend.stored.betaSettings.activeProviderId || 'ollama', 'ollama');
  assert.equal(fixture.q('#beta-provider-select').value, 'ollama');
  assert.match(fixture.q('#settings-models-summary').textContent, /Ollama chat/);
  fixture.permissions.allowed = true;
  backend.failNextWrite('betaSettings');
  fixture.change('#beta-provider-select', 'apple');
  await waitFor(() => /Unable to change provider/.test(fixture.q('#beta-settings-status').textContent), 'failed provider save');
  assert.match(fixture.q('#settings-models-summary').textContent, /Ollama chat/, 'A failed provider save must retain the persisted provider label');
  fixture.change('#beta-provider-select', 'apple');
  await waitFor(() => /Apple Foundation Models chat/.test(fixture.q('#settings-models-summary').textContent), 'updated provider label');
  await fixture.settle();
  assert.equal(backend.stored.betaSettings.activeProviderId, 'apple');
  assert.match(fixture.q('#settings-models-summary').textContent, /Apple Foundation Models chat/);
  assert.equal(fixture.permissions.requests.at(-1).permissions[0], 'nativeMessaging');
  assert.equal(fixture.q('#beta-apple-options').hidden, false);
  assert.equal(fixture.q('#beta-provider-base').closest('.beta-field').hidden, true);
  assert.equal(fixture.q('#beta-chat-model').disabled, true);
  assert.equal(fixture.q('#beta-apple-cloud').checked, false);
  fixture.window.confirm = () => false;
  fixture.q('#beta-apple-cloud').checked = true; fixture.change('#beta-apple-cloud', ''); await fixture.settle();
  assert.equal(backend.stored.betaSettings.applePrivateCloud, false);
  assert.equal(fixture.q('#beta-apple-cloud').checked, false);
  fixture.window.confirm = () => true;
  fixture.q('#beta-apple-cloud').checked = true; fixture.change('#beta-apple-cloud', ''); await fixture.settle();
  assert.equal(backend.stored.betaSettings.applePrivateCloud, true);
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings: backend.stored.betaSettings });
  await fixture.settle();
  assert.match(fixture.q('#beta-remote-provider-banner').textContent, /Apple servers/);
  fixture.q('#beta-apple-cloud').checked = false; fixture.change('#beta-apple-cloud', ''); await fixture.settle();
  assert.equal(backend.stored.betaSettings.applePrivateCloud, false);
  fixture.change('#beta-provider-select', 'ollama'); await fixture.settle();
  assert.match(fixture.q('#settings-models-summary').textContent, /Ollama chat/);
  assert.equal(fixture.q('#beta-provider-base').value, 'http://localhost:11434');
  assert.equal(JSON.stringify(backend.stored.betaEmbeddingConfig), previousEmbedding);
  assert.ok(!fixture.requests.some(request => request.type === 'SET_EMBEDDING_CONFIG' || request.type === 'BACKFILL_EMBEDDINGS'));
});

test('incomplete capture setup remains visible with no jobs and disappears after an explicit policy choice', async t => {
  const backend = providerFixture('http://localhost:11434');
  backend.stored.betaSettings.captureSetupComplete = false;
  await backend.connect();
  const fixture = await ui('sidepanel', {}, backend); t.after(fixture.close); await fixture.settle();
  const setup = fixture.q('#beta-capture-setup');
  assert.equal(setup.closest('[hidden], details:not([open])'), null, 'first-run policy choices must be exposed without opening a menu');
  assert.match(setup.textContent, /capture starts paused/i);
  assert.equal(backend.stored.betaSettings.paused, true);
  assert.equal(fixture.q('#beta-queue-section').hidden, true);
  fixture.q('#beta-open-capture-settings').click();
  assert.equal(fixture.q('#beta-view-settings').hidden, false);
  assert.equal(fixture.q('#settings-capture').open, true);
  fixture.q('a[data-view="sidepanel"]').click();
  fixture.q('#beta-enable-broad-capture').click(); await fixture.settle();
  assert.equal(backend.stored.betaSettings.captureSetupComplete, true);
  assert.equal(backend.stored.betaSettings.paused, false);
  fixture.emit({ type: 'BETA_SETTINGS_UPDATED', settings: backend.stored.betaSettings });
  assert.equal(setup.hidden, true);
  assert.equal(fixture.q('#beta-queue-section').hidden, true, 'completing setup must not expose an idle queue');
});

test('new log entries preserve keyboard focus and expanded metadata without stealing focus from filters', async t => {
  let entries = [{ id: 1, level: 'info', message: 'Captured an article', data: { title: 'Saved article' } }];
  const fixture = await ui('logs', { GET_LOGS: () => ({ logs: entries }) }); t.after(fixture.close); await fixture.settle();
  const summary = fixture.q('#logs-list summary');
  const label = summary.textContent;
  summary.parentElement.open = true;
  summary.focus();
  entries = [...entries, { id: 2, level: 'warn', message: 'Indexing is waiting', data: {} }];
  await fixture.poll(); await fixture.settle();
  assert.equal(fixture.window.document.activeElement.textContent, label, 'a background update must retain keyboard position in the same log entry');
  assert.match(fixture.q('#logs-list details[open]').textContent, /Saved article/);
  const filter = fixture.q('#logs-text'); filter.focus();
  entries = [...entries, { id: 3, level: 'info', message: 'Indexing resumed', data: {} }];
  await fixture.poll(); await fixture.settle();
  assert.equal(fixture.window.document.activeElement, filter, 'refresh must not move focus out of a filter');
});

test('empty memory provides capture and setup actions without an empty queue or count', async t => {
  const f = await ui('sidepanel', { GET_PAGE_LIST: () => ({ pages: [] }), CAPTURE_ACTIVE_TAB: () => ({ status: 'queued' }) }); t.after(f.close);
  assert.equal(f.q('.results-toolbar').hidden, true);
  assert.equal(f.q('#beta-queue-section').hidden, true);
  f.q('.wr-empty-memory .primary-button').click(); await f.settle();
  assert.ok(f.requests.some(message => message.type === 'CAPTURE_ACTIVE_TAB'));
  f.q('.wr-empty-memory .text-button').click();
  assert.equal(f.q('#beta-view-settings').hidden, false);
  assert.equal(f.q('#settings-capture').open, true);
  assert.ok(!f.requests.some(message => message.type === 'ASK_QUESTION'));
});

test('capture policy, theme, logging and retrieval budgets save through their real handlers', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  f.q('a[data-view="settings"]').click();
  f.q('#beta-allowlist-input').value = 'EXAMPLE.TEST\n*.docs.test';
  f.q('#beta-denylist-input').value = 'private.example.test';
  f.q('#beta-save-rules').click(); await f.settle();
  assert.deepEqual(backend.stored.betaSettings.allowlist, ['example.test', '*.docs.test']);
  assert.deepEqual(backend.stored.betaSettings.denylist, ['private.example.test']);
  f.q('#beta-pause-toggle').checked = false; f.change('#beta-pause-toggle', ''); await f.settle();
  assert.equal(backend.stored.betaSettings.paused, false);
  assert.match(f.q('#beta-capture-policy-note').textContent, /capture is on/);
  f.change('#beta-theme-select', 'dark'); await f.settle();
  assert.equal(backend.stored.betaSettings.theme, 'dark'); assert.equal(f.window.document.documentElement.dataset.theme, 'dark');
  f.change('#beta-log-level', 'off'); await f.settle();
  assert.equal(backend.stored.betaSettings.logLevel, 'off');
  f.change('#settings-ask-sources', '3'); await f.settle();
  assert.equal(backend.stored.betaSettings.askMaxSources, 3);
  assert.equal(f.q('#beta-calib-sim'), null);
  assert.equal(f.requests.some(message => /CALIBRATION/.test(message.type)), false);
  assert.ok(!f.requests.some(message => message.type === 'ASK_QUESTION'));
});

test('Memory filters, sorts, selects and deletes the intended saved records', async t => {
  const backend = providerFixture('http://localhost:11434'); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'); t.after(async () => (await db.openDatabase()).close());
  for (const [title, manual] of [['Cats', false], ['Dogs', true]]) await db.savePageRecord({ url: `https://example.test/${title}`, title, manual, text: title, timestamp: title === 'Cats' ? 10 : 20, chunks: [] });
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  f.q('a[data-view="manage"]').click(); await f.settle();
  f.change('#manage-sort', 'title-asc');
  assert.match(f.q('#manage-rows > article').textContent, /Cats/);
  f.q('#manage-filter-manual').checked = true; f.change('#manage-filter-manual', '');
  assert.equal(f.q('#manage-count').textContent, '1 page'); assert.match(f.q('#manage-rows').textContent, /Dogs/);
  f.q('#manage-select').click(); f.q('#manage-select-all').checked = true; f.change('#manage-select-all', '');
  assert.equal(f.q('#manage-delete').disabled, false); f.q('#manage-delete').click(); await f.settle();
  assert.deepEqual(Array.from(await db.listAllPages(), page => page.title), ['Cats']);
});

test('Highlights validates ranges, paginates and opens the actual captured sources', async t => {
  const dates = [{ date: '2026-11-14', count: 1 }, { date: '2026-11-13', count: 1 }];
  const f = await ui('highlights', {
    LIST_HIGHLIGHT_DATES: message => ({ dates: dates.slice(message.offset, message.offset + message.limit), total: dates.length }),
    GET_HIGHLIGHTS: () => ({ highlight: { text: '1. Cats', entries: pages } })
  }); t.after(f.close);
  f.q('#highlight-from').value = '2026-11-15'; f.q('#highlight-to').value = '2026-11-14'; f.submit('#highlight-filter');
  assert.match(f.q('#highlight-status').textContent, /From must be/);
  f.q('#highlight-from').value = ''; f.q('#highlight-to').value = ''; f.q('#highlight-size').value = '1'; f.submit('#highlight-filter'); await f.settle();
  assert.equal(f.q('#highlight-next').disabled, false); f.q('#highlight-next').click(); await f.settle();
  assert.match(f.q('#highlight-list').textContent, /November 13/);
  assert.equal(f.q('.highlight-source').href, pages[0].url);
  assert.equal(f.q('#highlight-next').disabled, true);
});

test('Logs recovers from a refresh error even if the entries have not changed', async t => {
  let failed = false;
  const f = await ui('logs', { GET_LOGS: () => { if (failed) throw Error('Connection lost'); return { logs: [{ id: 1, level: 'warn', message: 'Capture retry', data: { url: pages[0].url } }] }; } }); t.after(f.close);
  failed = true; await f.poll(); assert.match(f.q('#logs-status').textContent, /Failed/);
  failed = false; await f.poll(); assert.equal(f.q('#logs-status').dataset.variant, 'info');
  assert.doesNotMatch(f.q('#logs-status').textContent, /Failed/);
});

test('Search, saved previews and Memory remain usable when model endpoints are unavailable', async t => {
  const backend = providerFixture('http://localhost:11434');
  const bg = await backend.load('src/background/orchestration/index.ts', { fetch: async () => Response.json({ error: 'No model available' }, { status: 404 }) }); bg.orchestrateLifecycle();
  const db = await backend.load('src/shared/db/index.ts'); t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ ...pages[0], text: 'Cats have whiskers.', chunks: [{ text: 'Cats have whiskers.', embedding: [] }] });
  const f = await ui('sidepanel', {}, backend); t.after(f.close); await f.settle();
  f.q('#beta-search-input').value = 'whiskers'; f.submit('#beta-search-form'); await f.settle();
  assert.equal(f.q('#beta-search-status').textContent, '1 page'); assert.match(f.q('#beta-search-results').textContent, /Cats have whiskers/);
  f.q('a[data-view="manage"]').click(); await f.settle(); assert.equal(f.q('#manage-count').textContent, '1 page');
  f.q('#beta-view-manage .primary-button[href]').click(); await f.settle(); assert.match(f.q('#beta-search-results').textContent, /Cats have whiskers/);
  assert.ok(!f.requests.some(message => message.type === 'ASK_QUESTION'));
});

test('downloaded model rows show stored revisions, select without downloading and confirm exact removal', async t => {
  let config = { ...DEFAULT_EMBEDDING_CONFIG }, models = [
    { model: config.browserModel, revision: config.browserRevision, sizeBytes: 123_000_000, fileCount: 4, hasWeights: true },
    { model: 'custom/model', revision: 'partial-revision', sizeBytes: null, fileCount: 1, hasWeights: false }
  ];
  const pending = deferred();
  const f = await ui('sidepanel', {
    GET_EMBEDDING_CONFIG: () => ({ config }), LIST_BROWSER_MODELS: () => ({ models }),
    SET_EMBEDDING_CONFIG: message => ({ config: config = { ...config, ...message.payload } }),
    DELETE_BROWSER_MODEL: async message => { await pending.promise; models = models.filter(model => model.model !== message.model || model.revision !== message.revision); return { deletedFiles: 4 }; }
  }); t.after(f.close);
  assert.ok(!f.requests.some(message => message.type === 'LIST_BROWSER_MODELS'));
  f.q('#settings-downloads').open = true;
  await waitFor(() => f.window.document.querySelectorAll('.wr-model-download').length === 2, 'cached model rows');
  assert.match(f.q('#beta-browser-models-list').textContent, /123|117/);
  assert.match(f.q('#beta-browser-models-list').textContent, /Partial download.*Size unavailable/);
  f.q('.wr-model-download .secondary-button').click();
  await waitFor(() => f.q('#beta-browser-models-status').textContent.includes('Model selected'), 'model selection');
  assert.equal(config.provider, 'browser');
  assert.match(f.q('.wr-model-download summary').textContent, /Selected/);
  assert.ok(!f.requests.some(message => ['DOWNLOAD_BROWSER_EMBED', 'BACKFILL_EMBEDDINGS'].includes(message.type)));
  f.q('.wr-model-download .danger-text').click();
  assert.ok(!f.requests.some(message => message.type === 'DELETE_BROWSER_MODEL'));
  assert.equal(f.q('.wr-model-download .danger-text').textContent, 'Confirm removal');
  f.q('.wr-model-download .button-row .text-button:not(.danger-text)').click();
  assert.equal(f.q('.wr-model-download .danger-text').textContent, 'Remove download');
  f.q('.wr-model-download .danger-text').click(); f.q('.wr-model-download .danger-text').click(); f.q('.wr-model-download .danger-text').click();
  assert.equal(f.requests.filter(message => message.type === 'DELETE_BROWSER_MODEL').length, 1);
  const removed = f.requests.find(message => message.type === 'DELETE_BROWSER_MODEL');
  assert.equal(removed.model, DEFAULT_EMBEDDING_CONFIG.browserModel); assert.equal(removed.revision, DEFAULT_EMBEDDING_CONFIG.browserRevision);
  assert.equal(f.q('#beta-refresh-browser-models').disabled, true);
  pending.resolve(); await waitFor(() => !f.q('#beta-refresh-browser-models').disabled, 'removal to finish');
  assert.equal(f.window.document.querySelectorAll('.wr-model-download').length, 1);
  assert.match(f.q('#beta-browser-models-list').textContent, /partial-revision/);
});

test('download refresh failures remain visible after a successful deletion', async t => {
  let fail = false;
  const f = await ui('sidepanel', {
    LIST_BROWSER_MODELS: () => { if (fail) throw Error('Cache unavailable'); return { models: [{ model: 'org/model', revision: 'pinned', sizeBytes: 100, fileCount: 1, hasWeights: true }] }; },
    DELETE_BROWSER_MODEL: () => { fail = true; return { deletedFiles: 1 }; }
  }); t.after(f.close);
  f.q('#settings-downloads').open = true;
  await waitFor(() => f.q('.wr-model-download'), 'model inventory'); f.q('.wr-model-download .danger-text').click(); f.q('.wr-model-download .danger-text').click();
  await waitFor(() => !f.q('#beta-refresh-browser-models').disabled, 'refresh failure');
  assert.equal(f.q('#beta-browser-models-status').dataset.variant, 'error');
  assert.match(f.q('#beta-browser-models-status').textContent, /Cache unavailable/);
  assert.doesNotMatch(f.q('#beta-browser-models-status').textContent, /Download removed/);
});

test('model inventory and deletion use registered handlers without touching captured records', async t => {
  let models = [{ model: 'org/model', revision: 'one', sizeBytes: 1234, fileCount: 2, hasWeights: true }]; const calls = [];
  const backend = providerFixture('http://localhost:11434', [], { sendOffscreenMessage: async message => {
    calls.push(message);
    if (message.type === 'OFFSCREEN_LIST_BROWSER_MODELS') return { models };
    if (message.type === 'OFFSCREEN_REMOVE_BROWSER_MODEL') { models = []; return { deletedFiles: 2 }; }
    return { runtimeAvailable: true };
  } }); await backend.connect();
  const db = await backend.load('src/shared/db/index.ts'); t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ ...pages[0], text: 'Keep this captured content.', chunks: [{ text: 'Keep this captured content.', embedding: [1, 2], embeddingKey: 'original' }] });
  const before = JSON.stringify(await db.getPageRecord(pages[0].url));
  const f = await ui('sidepanel', {}, backend); t.after(f.close);
  f.q('#settings-downloads').open = true; await waitFor(() => f.q('.wr-model-download'), 'stored cache inventory');
  f.q('.wr-model-download .danger-text').click(); f.q('.wr-model-download .danger-text').click();
  await waitFor(() => f.q('#beta-browser-models-status').textContent.includes('Download removed'), 'cache deletion');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(message => message.type === 'OFFSCREEN_REMOVE_BROWSER_MODEL'))), { type: 'OFFSCREEN_REMOVE_BROWSER_MODEL', model: 'org/model', revision: 'one' });
  assert.equal(JSON.stringify(await db.getPageRecord(pages[0].url)), before);
  assert.match(f.q('#beta-browser-models-list').textContent, /No browser models downloaded/);
});
