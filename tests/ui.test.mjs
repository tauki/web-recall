import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadSource, tick, waitFor } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const { DEFAULT_SETTINGS, DEFAULT_EMBEDDING_CONFIG } = await loadSource('src/shared/config/index.ts');
const pages = [{ url: 'https://example.test/cats', title: 'Cats', timestamp: Date.now(), manual: false, embeddingStatus: 'Present', chunkCount: 3 }];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function ui(view, overrides = {}, backend) {
  const dom = new JSDOM(`<div id="app-root" data-view="${view}"></div>`, { url: 'https://extension.test/' });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  const listeners = [], requests = [], polls = [];
  let pendingMessages = 0;
  const responses = {
    GET_SETTINGS: () => ({ settings: { ...DEFAULT_SETTINGS, captureSetupComplete: true } }),
    GET_EMBEDDING_CONFIG: () => ({ config: { ...DEFAULT_EMBEDDING_CONFIG } }),
    GET_PROVIDERS: () => ({ providers: [] }),
    GET_PROVIDER_CONFIG: () => ({ baseUrl: 'http://localhost:11434' }),
    GET_BROWSER_EMBED_STATUS: () => ({ status: { ready: false, state: 'idle', runtimeAvailable: true } }),
    GET_CALIBRATION: () => ({ calibration: { wSim: .6, wLLM: .4 } }),
    GET_PROCESSING: () => ({ queue: [] }),
    GET_PAGE_LIST: () => ({ pages }),
    ...overrides
  };
  const chrome = {
    runtime: {
      getURL: path => 'https://extension.test/' + path,
      onMessage: { addListener: listener => listeners.push(listener) },
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
    chrome
  });
  await tick(); await tick();
  const q = selector => window.document.querySelector(selector);
  const change = (selector, value) => { q(selector).value = value; q(selector).dispatchEvent(new window.Event('change', { bubbles: true })); };
  return { window, q, change, requests, poll: async () => { polls.forEach(task => task()); await tick(); await tick(); }, emit: message => listeners.forEach(f => f(message)), close: () => window.close(),
    settle: () => waitFor(() => pendingMessages === 0, 'UI requests to finish'),
    submit: selector => q(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) };
}

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
  await waitFor(() => settings.q('#beta-provider-base')?.value === 'http://localhost:11434', 'Settings to load');
  backend.failNextWrite('betaProviderSettings');
  settings.q('#beta-provider-save').click();
  await settings.settle();
  assert.match(settings.q('#beta-settings-status').textContent, /Storage write failed/);
  assert.doesNotMatch(settings.q('#beta-settings-status').textContent, /settings saved/i);
  const db = await backend.load('src/shared/db/index.ts');
  t.after(async () => (await db.openDatabase()).close());
  await db.savePageRecord({ ...pages[0], text: 'Saved text', chunks: [{ text: 'Saved text', embedding: [1, 0] }] });
  const memory = await ui('manage', {}, backend); t.after(memory.close);
  const input = memory.q('#manage-import');
  const invalid = new File([JSON.stringify({ schemaVersion: 1, pages: [{ url: pages[0].url, title: 'No supported content' }] })], 'invalid.json');
  Object.defineProperty(input, 'files', { value: [invalid] });
  input.dispatchEvent(new memory.window.Event('change'));
  await waitFor(() => !input.disabled, 'failed import to finish');
  assert.match(memory.q('#manage-status').textContent, /Import failed:.*content/i);
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

test('Memory streams a backup through registered messages and validates it before restoring any pages', async t => {
  const backend = providerFixture('http://localhost:11434');
  await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  t.after(async () => (await db.openDatabase()).close());
  const captured = [
    { url: 'https://backup.test/a', title: 'First', text: 'é'.repeat(600_000), timestamp: 10, manual: true, chunks: [{ text: 'First passage', embedding: [1, 0], embeddingKey: 'saved-model' }] },
    { url: 'https://backup.test/b', title: 'Second', text: 'Second passage', timestamp: 20, manual: false, chunks: [] }
  ];
  for (const page of captured) await db.savePageRecord(page);
  const f = await ui('manage', {}, backend); t.after(f.close);
  const writes = [];
  let closed = false, aborted = false;
  f.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async part => { writes.push(part); }, close: async () => { closed = true; }, abort: async () => { aborted = true; } }) });
  f.q('#manage-export').click();
  await waitFor(() => closed, 'the backup file to close');
  assert.equal(aborted, false);
  assert.equal(f.q('#manage-status').textContent, 'Export complete: 2 pages');
  assert.ok(!f.requests.some(request => request.type === 'GET_ALL_PAGES'));
  assert.equal(f.requests.filter(request => request.type === 'GET_BACKUP_PAGE').length, 3);
  assert.deepEqual(writes.slice(1, -1).map(part => JSON.parse(part).page.url), captured.map(page => page.url));
  assert.deepEqual(JSON.parse(writes.at(-1)), { type: 'end', pages: 2 });
  await db.deletePages(captured.map(page => page.url));
  const input = f.q('#manage-import');
  const importFile = async file => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new f.window.Event('change'));
    await waitFor(() => !input.disabled, 'the import to finish');
  };
  await importFile(new File(writes.slice(0, -1), 'truncated.jsonl'));
  assert.match(f.q('#manage-status').textContent, /incomplete/i);
  assert.equal((await db.listAllPages()).length, 0);
  assert.ok(!f.requests.some(request => request.type === 'IMPORT_BACKUP_PAGE'));
  await importFile(new File(writes, 'backup.jsonl'));
  assert.equal(f.q('#manage-status').textContent, 'Import complete: 2 pages');
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
  assert.match(f.q('#manage-status').textContent, /Disk full/);
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
  assert.equal(f.q('#beta-ask-input').value, 'Compare');
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
  queue = [{ ...pages[0], status: 'processing', attempts: 1 }]; await f.poll();
  assert.equal(details.hidden, false); assert.equal(details.open, false);
  assert.match(f.q('#beta-queue-label').textContent, /1 capture in progress/);
  assert.equal(f.q('#beta-capture-status button').disabled, true);
  queue[0].status = 'failed'; await f.poll();
  assert.match(f.q('#beta-queue-label').textContent, /1 failed/);
  f.q('#beta-capture-status button').click(); await f.settle();
  assert.equal(f.requests.find(message => message.type === 'RETRY_PROCESSING').url, pages[0].url);
  queue = []; await f.poll(); assert.equal(details.hidden, true);
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

test('capture policy, theme, logging and calibration save through their real handlers', async t => {
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
  f.change('#beta-calib-sim', '.75'); await f.settle();
  assert.equal((await backend.send({ type: 'GET_CALIBRATION' })).calibration.wSim, .75);
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
