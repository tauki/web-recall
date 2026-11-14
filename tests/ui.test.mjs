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
  const dom = new JSDOM('<div id="app-root"></div>', { url: 'https://extension.test/' });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
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

test('sidepanel IDs, tab relationships and keyboard focus stay unique across Settings and Ask', async t => {
  const f = await ui('sidepanel'); t.after(f.close);
  const ids = [...f.window.document.querySelectorAll('[id]')].map(el => el.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const tab of f.window.document.querySelectorAll('[role=tab]')) {
    const panel = f.q('#' + tab.getAttribute('aria-controls'));
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
  }
  f.q('#tab-search').dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(f.window.document.activeElement.id, 'tab-settings');
  assert.equal(f.q('#beta-view-settings').hidden, false);
  assert.equal(f.q('#tab-search').tabIndex, -1);
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

test('Ask prevents duplicate submissions, stops, and ignores all stale replies', async t => {
  const pending = [deferred(), deferred()]; let call = 0;
  const f = await ui('sidepanel', { ASK_QUESTION: () => pending[call++].promise, CANCEL_ASK: () => ({ cancelled: true }) }); t.after(f.close);
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
  pending[1].resolve({ answer: '**New answer** [1]', sources: [{ ...pages[0], index: 1, domain: 'example.test' }] }); await tick();
  assert.equal(f.q('#beta-ask-answer strong').textContent, 'New answer');
  f.q('#beta-ask-answer a').click();
  assert.equal(f.window.document.activeElement.id, 'ask-source-1');
  assert.equal(f.q('#beta-ask-submit').disabled, false);
  f.q('#beta-ask-clear').click();
  assert.equal(f.q('#beta-ask-input').value, '');
  assert.equal(f.q('#beta-ask-answer').hidden, true);
  assert.equal(f.q('#beta-ask-sources').children.length, 0);
});

test('Clear stays clear if cancellation fails later', async t => {
  const cancel = deferred(), answer = deferred();
  const f = await ui('sidepanel', { ASK_QUESTION: () => answer.promise, CANCEL_ASK: () => cancel.promise }); t.after(f.close);
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
  assert.match(f.q('#logs-settings-link').href, /#settings-advanced$/);
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
  assert.equal(f.q('#beta-search-status').textContent,'');
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
