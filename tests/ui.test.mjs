import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadSource, tick } from './helpers.mjs';

const { DEFAULT_SETTINGS, DEFAULT_EMBEDDING_CONFIG } = await loadSource('src/shared/config/index.ts');
const pages = [{ url: 'https://example.test/cats', title: 'Cats', timestamp: Date.now(), manual: false, embeddingStatus: 'Present', chunkCount: 3 }];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function ui(view, overrides = {}) {
  const dom = new JSDOM('<div id="app-root"></div>', { url: 'https://extension.test/' });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const listeners = [], requests = [];
  const responses = {
    GET_SETTINGS: () => ({ settings: { ...DEFAULT_SETTINGS, captureSetupComplete: true } }),
    GET_EMBEDDING_CONFIG: () => ({ config: { ...DEFAULT_EMBEDDING_CONFIG } }),
    GET_PROVIDERS: () => ({ providers: [] }),
    GET_BROWSER_EMBED_STATUS: () => ({ status: { ready: false, state: 'idle', runtimeAvailable: true } }),
    GET_CALIBRATION: () => ({ calibration: { wSim: .6, wLLM: .4 } }),
    GET_PROCESSING: () => ({ queue: [] }),
    GET_PAGE_LIST: () => ({ pages }),
    ...overrides
  };
  const send = async message => { requests.push(message); return responses[message.type]?.(message) ?? {}; };
  await loadSource(`src/ui/${view}/index.ts`, '', {
    '../shared/runtime': { sendRuntimeMessage: send },
    '../../shared/runtime': { sendRuntimeMessage: send },
    '../shared/polling': { startPolling: task => { void task(); return () => {}; } }
  }, {
    window, document: window.document, HTMLElement: window.HTMLElement,
    chrome: { runtime: { getURL: p => 'https://extension.test/' + p, onMessage: { addListener: f => listeners.push(f) } }, tabs: { create() {} } }
  });
  await tick(); await tick();
  const q = selector => window.document.querySelector(selector);
  const change = (selector, value) => { q(selector).value = value; q(selector).dispatchEvent(new window.Event('change', { bubbles: true })); };
  return { window, q, change, requests, emit: message => listeners.forEach(f => f(message)), close: () => window.close(),
    submit: selector => q(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) };
}

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
  const f = await ui('logs', { GET_LOGS: () => ({ logs: ['debug', 'info', 'error'].map(level => ({ level, message: level + ' entry', createdAt: 1 })) }) }); t.after(f.close);
  f.change('#logs-level', 'debug');
  assert.equal(f.window.document.querySelectorAll('.log-entry').length, 1);
  assert.match(f.q('#logs-list').textContent, /debug entry/);
  assert.equal(f.q('#logs-status').textContent, 'Showing 1 of 3 entries');
  assert.match(f.q('#logs-settings-link').href, /#settings-advanced$/);
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
