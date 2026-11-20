import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { installRecallObserver, blockBenchmarkModels } from '../scripts/lib/recall-observer.mjs';

function fixture(testContext) {
  const dom = new JSDOM('<form id="beta-search-form"></form><div id="beta-search-results"><article><details data-url="https://saved.test/current"></details></article></div>', { runScripts: 'outside-only' });
  testContext.after(() => dom.window.close());
  const { window } = dom;
  const frames = [], listeners = [];
  const record = value => typeof value === 'string' ? { url: value, title: 'Saved article', snippet: 'The current evidence.', timestamp: Date.UTC(2020, 0, 2) } : value;
  let callback, clock = 10;
  window.performance.now = () => clock;
  window.requestAnimationFrame = handler => frames.push(handler);
  window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 60, top: 100, bottom: 160 });
  window.chrome = { runtime: { onMessage: { addListener: listener => listeners.push(listener) }, sendMessage: (_message, done) => { callback = done; } } };
  window.eval(`(${installRecallObserver.toString()})();`);
  return {
    window,
    async paint() { await new Promise(resolve => setImmediate(resolve)); while (frames.length) { const handlers = frames.splice(0); for (const handler of handlers) handler(); } },
    start(id, time) { clock = time; window.document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); window.chrome.runtime.sendMessage({ type: 'SEARCH_QUERY', requestId: id }, () => {}); },
    reply(rows) { callback({ results: rows.map(record) }); },
    update(id, rows) { for (const listener of listeners) listener({ type: 'SEARCH_RESULTS_UPDATE', requestId: id, results: rows.map(record) }); },
    rows(rows) { window.document.querySelector('#beta-search-results').innerHTML = rows.map(record).map(value => `<article><details data-url="${value.url}"><span class="result-title">${value.title}</span><span class="result-snippet">${value.snippet}</span><details class="wr-match-details"><p>${new window.Date(value.timestamp).toLocaleString()}</p></details></details></article>`).join(''); },
    clock(time) { clock = time; },
    observation: () => window.benchmarkObservation
  };
}

test('timing rejects stale rows and unrelated mutations even when the previous URL equals the new response', async testContext => {
  const state = fixture(testContext), url = 'https://saved.test/current';
  state.start('new-request', 10);
  state.window.document.body.append(state.window.document.createElement('p'));
  await state.paint(); assert.equal(state.observation().firstVisibleMs, null);
  state.reply([url]); state.window.document.body.append(state.window.document.createElement('p'));
  await state.paint(); assert.equal(state.observation().firstVisibleMs, null, 'An unchanged old DOM node is not a current-query paint');
  state.rows(['https://saved.test/wrong']); await state.paint(); assert.equal(state.observation().firstVisibleMs, null);
  state.update('obsolete-request', ['https://saved.test/wrong']); state.window.document.body.append(state.window.document.createElement('p'));
  await state.paint(); assert.equal(state.observation().firstVisibleMs, null);
  state.clock(90); state.rows([url]); await state.paint(); assert.equal(state.observation().firstVisibleMs, 80);
});

test('a fresh but obsolete snapshot with the current URL cannot certify the current payload paint', async testContext => {
  const state = fixture(testContext);
  const current = { url: 'https://saved.test/current', title: 'Current title', snippet: 'Current passage.', timestamp: Date.UTC(2020, 0, 2) };
  state.start('identity', 10); state.reply([current]);
  for (const change of [{ title: 'Obsolete title' }, { snippet: 'Obsolete passage.' }, { timestamp: Date.UTC(2019, 0, 2) }]) {
    state.rows([{ ...current, ...change }]); await state.paint(); assert.equal(state.observation().firstVisibleMs, null);
  }
  state.clock(80); state.rows([current]); await state.paint(); assert.equal(state.observation().firstVisibleMs, 70);
});

test('first text timing accepts the current early payload without waiting for the desired target or final response', async testContext => {
  const state = fixture(testContext), first = 'https://saved.test/first', later = 'https://saved.test/later';
  state.start('text-first', 20); state.update('text-first', [first]); state.clock(70); state.rows([first]);
  await state.paint(); assert.equal(state.observation().firstVisibleMs, 50); assert.equal(state.observation().completed, false);
  state.clock(300); state.reply([later]); state.rows([later]); await state.paint();
  assert.equal(state.observation().firstVisibleMs, 50, 'Later final ranking must not move the first-text timestamp');
});

test('a replaced query cannot inherit an outstanding paint from an older request', async testContext => {
  const state = fixture(testContext), url = 'https://saved.test/current';
  state.start('old', 10); state.reply([url]); state.rows([url]);
  await new Promise(resolve => setImmediate(resolve));
  state.start('new', 30); state.clock(40); await state.paint();
  assert.equal(state.observation().requestId, 'new'); assert.equal(state.observation().firstVisibleMs, null);
});

test('the benchmark counts and blocks every exposed HTTP, native and offscreen inference entry point', async testContext => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); testContext.after(() => dom.window.close());
  let escaped = 0;
  dom.window.chrome = { runtime: { connectNative() { escaped++; }, sendNativeMessage() { escaped++; } }, offscreen: { createDocument() { escaped++; } } };
  dom.window.fetch = async () => { escaped++; };
  dom.window.eval(`(${blockBenchmarkModels.toString()})();`);
  await assert.rejects(dom.window.fetch('http://localhost:11434/api/chat'), /disabled/);
  assert.throws(() => dom.window.chrome.runtime.connectNative('companion'), /disabled/);
  assert.throws(() => dom.window.chrome.runtime.sendNativeMessage('companion', {}), /disabled/);
  await assert.rejects(dom.window.chrome.offscreen.createDocument({}), /disabled/);
  assert.equal(escaped, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.benchmarkCalls)), {
    http: ['http://localhost:11434/api/chat'], native: 2, offscreen: 1, modelDispatches: [], storageOpens: 0
  });
});

test('the SQLite measurement permits storage but not inference or model-asset dispatch through the shared host', async context => {
  const dom = new JSDOM('', { runScripts: 'outside-only' }); context.after(() => dom.window.close());
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
  const opened = [], dispatched = [];
  dom.window.chrome = { runtime: { getURL: pathname => origin + pathname, sendMessage: (...args) => dispatched.push(args) },
    offscreen: { async createDocument(options) { opened.push(options.url); } } };
  dom.window.eval(`(${blockBenchmarkModels.toString()})(true);`);
  const host = origin + 'dist/beta/offscreen/index.html';
  await dom.window.chrome.offscreen.createDocument({ url: host, reasons: ['WORKERS'] });
  await assert.rejects(dom.window.chrome.offscreen.createDocument({ url: origin + 'other.html', reasons: ['WORKERS'] }), /disabled/u);
  dom.window.chrome.runtime.sendMessage({ type: 'OFFSCREEN_SAVED_LIBRARY', request: { kind: 'inspect' } });
  for (const type of ['OFFSCREEN_EMBED', 'OFFSCREEN_DOWNLOAD_BROWSER_MODEL', 'OFFSCREEN_CHECK_BROWSER_MODEL']) {
    assert.throws(() => dom.window.chrome.runtime.sendMessage({ type }), /disabled/u);
  }
  assert.deepEqual(opened, [host]);
  assert.deepEqual(dispatched.map(args => args[0].type), ['OFFSCREEN_SAVED_LIBRARY']);
  assert.equal(dom.window.benchmarkCalls.modelDispatches.length, 3);
});
