import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain, tick, waitFor } from './helpers.mjs';
import { providerFixture } from './provider-fixture.mjs';

const { RECENTS_CACHE_KEY } = await loadSource('src/shared/recents.ts');

const first = { url: 'https://example.test/first', title: 'First saved page', timestamp: 1 };
const second = { url: 'https://example.test/second', title: 'Newest saved page', timestamp: 2 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sessionFixture = () => {
  const values = {};
  return { values, async get(key) { return structuredClone({ [key]: values[key] }); }, async set(next) { Object.assign(values, structuredClone(next)); }, async remove(key) { delete values[key]; } };
};

async function service(session, list) {
  return loadSource('src/background/manage/recents.ts', '', { '../storage/manager': { storageManager: { listRecentPageSummaries: async () => ({ pages: await list(), nextCursor: null }) } } }, { chrome: { storage: { session } } });
}

async function panel(session, loadRecents, { visible = true, settings, observe, local = {}, handle = () => ({}) } = {}) {
  const dom = new JSDOM('<div id="app-root"></div>', { url: 'https://extension.test/' });
  const { window } = dom;
  for (const [key, value] of Object.entries(local)) window.localStorage.setItem(key, value);
  const timers = new Map(), requests = [], messages = [];
  let shown = visible, nextTimer = 0;
  Object.defineProperty(window.document, 'visibilityState', { get: () => shown ? 'visible' : 'hidden' });
  window.setInterval = callback => { timers.set(++nextTimer, callback); return nextTimer; };
  window.clearInterval = timer => timers.delete(timer);
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  const chrome = { storage: { session }, tabs: { create() {} }, runtime: {
    getURL: value => value, onMessage: { addListener() {}, removeListener() {} },
    sendMessage(message, done) {
      requests.push(message.type);
      messages.push(message);
      const response = message.type === 'GET_SETTINGS' ? (settings || { settings: { theme: 'light', captureSetupComplete: true } }) : message.type === 'GET_RECENT_PAGES' ? Promise.resolve().then(() => loadRecents(message)).then(result => Array.isArray(result) ? { pages: result, nextCursor: null } : result) : handle(message);
      Promise.resolve(response).then(done, error => done({ error: error.message }));
    }
  } };
  await loadSource('src/ui/sidepanel/index.ts', '', { './settings/index': { renderSettingsPanel() {} } }, { chrome, window, document: window.document, HTMLElement: window.HTMLElement, TextEncoder, IntersectionObserver: observe });
  await tick(); await tick();
  return { requests, messages, window, q: selector => window.document.querySelector(selector),
    titles: () => [...window.document.querySelectorAll('#beta-recents-list > article summary')].map(node => node.textContent),
    show() { shown = true; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    hide() { shown = false; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    poll() { for (const callback of timers.values()) callback(); },
    close() { window.dispatchEvent(new window.Event('pagehide')); window.close(); }
  };
}

test('closing the sidepanel cancels its in-flight search with the current request identity', async t => {
  const pending = deferred();
  const fixture = await panel(sessionFixture(), async () => [first], {
    handle: message => message.type === 'SEARCH_QUERY' ? pending.promise : {}
  });
  t.after(() => { pending.resolve({ results: [] }); fixture.window.close(); });
  fixture.q('#beta-search-input').value = 'saved page';
  fixture.q('#beta-search-filter-form').requestSubmit();
  const active = fixture.messages.find(message => message.type === 'SEARCH_QUERY');
  assert.ok(active?.requestId, 'Search is in flight when the panel closes');
  assert.ok(!fixture.requests.includes('CANCEL_SEARCH'));
  fixture.close();
  assert.deepEqual(fixture.messages.filter(message => message.type === 'CANCEL_SEARCH').map(message => message.requestId), [active.requestId]);
});

test('a panel created hidden fetches on becoming visible without waiting for its polling interval', async t => {
  const fixture = await panel(sessionFixture(), async () => [first], { visible: false }); t.after(fixture.close);
  assert.equal(fixture.requests.includes('GET_RECENT_PAGES'), false);
  fixture.show();
  await waitFor(() => fixture.titles().some(title => title.includes(first.title)), 'recents immediately after visibility');
  assert.equal(fixture.requests.filter(type => type === 'GET_RECENT_PAGES').length, 1);
  assert.equal(fixture.requests.includes('GET_PAGE_LIST'), false, 'Sidepanel startup must not ask for the complete Memory Manager library');
});

test('closing and reopening paints cached recents while a fresh request is still pending', async t => {
  const session = sessionFixture(), pending = deferred();
  let current = [first], waiting = false;
  const api = await service(session, async () => waiting ? pending.promise : current);
  const initial = await panel(session, message => api.getRecentPages(message.after));
  await waitFor(() => initial.titles().some(title => title.includes(first.title)), 'initial saved page');
  initial.close(); waiting = true;
  const reopened = await panel(session, message => api.getRecentPages(message.after)); t.after(reopened.close);
  await waitFor(() => reopened.titles().some(title => title.includes(first.title)), 'cached recents before database reply');
  pending.resolve([second]);
  await waitFor(() => reopened.titles().some(title => title.includes(second.title)), 'fresh recents replacing the snapshot');
  assert.ok(!reopened.titles().some(title => title.includes(first.title)));
  const saved = session.values[RECENTS_CACHE_KEY];
  assert.deepEqual(plain(saved), [second], 'The session snapshot contains only recents metadata');
});

test('late cache reads and older database replies cannot replace a fresher page list', async t => {
  const read = deferred(), old = deferred();
  const session = sessionFixture();
  session.get = () => read.promise;
  let calls = 0;
  const fixture = await panel(session, () => ++calls === 1 ? old.promise : [second]); t.after(fixture.close);
  fixture.poll();
  await waitFor(() => fixture.titles().some(title => title.includes(second.title)), 'newer database reply');
  read.resolve({ [RECENTS_CACHE_KEY]: [first] }); old.resolve([first]);
  await tick(); await tick();
  assert.ok(fixture.titles().some(title => title.includes(second.title)));
  assert.ok(!fixture.titles().some(title => title.includes(first.title)));
});

test('a cache failure does not block fresh data and a refresh error does not discard cached pages', async t => {
  const broken = sessionFixture(); broken.get = async () => { throw Error('Session cache unavailable'); };
  const fresh = await panel(broken, async () => [second]); t.after(fresh.close);
  await waitFor(() => fresh.titles().some(title => title.includes(second.title)), 'fresh page without cache');
  const session = sessionFixture(), api = await service(session, async () => [first]);
  await api.getRecentPages();
  const stale = await panel(session, async () => { throw Error('Database read unavailable'); }); t.after(stale.close);
  await waitFor(() => stale.titles().some(title => title.includes(first.title)), 'retained snapshot after refresh failure');
  assert.match(stale.q('#beta-search-status').textContent, /Database read unavailable/);
});

test('cache invalidation waits for older writes so a completed deletion cannot resurrect cached pages', async () => {
  const session = sessionFixture(), read = deferred();
  session.values.unrelated = 'Keep other session state';
  const api = await service(session, () => read.promise);
  const pending = api.getRecentPages();
  await tick();
  const invalidated = api.invalidateRecentPages();
  read.resolve([first]); await pending; await invalidated;
  assert.equal(session.values[RECENTS_CACHE_KEY], undefined);
  assert.equal(session.values.unrelated, 'Keep other session state');
});

test('recents use a bounded metadata-only read and stay correct after captures, replacements and deletion', async t => {
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB: new IDBFactory(), IDBKeyRange });
  const connection = await db.openDatabase(); t.after(() => connection.close());
  for (let index = 0; index < 30; index++) await db.savePageRecord({ url: `https://example.test/${index}`, title: `Page ${index}`, timestamp: index, text: 'Private full text', chunks: [{ text: 'Private passage', embedding: [1, 0] }], manual: false }, { replace: true });
  const original = connection.transaction.bind(connection);
  connection.transaction = (...args) => {
    const transaction = original(...args), objectStore = transaction.objectStore.bind(transaction);
    transaction.objectStore = name => {
      const store = objectStore(name);
      if (name === 'pages' && transaction.mode === 'readonly') {
        for (const operation of ['get', 'getAll', 'openCursor']) store[operation] = () => assert.fail('Recents must not materialize saved page bodies or vectors');
        const index = store.index.bind(store);
        store.index = name => {
          const result = index(name);
          for (const operation of ['get', 'getAll', 'openCursor']) result[operation] = () => assert.fail('Recents must read index keys, not page bodies or vectors');
          return result;
        };
      }
      return store;
    };
    return transaction;
  };
  const recent = await db.listRecentPageSummaries(20);
  assert.deepEqual(plain(recent.pages), Array.from({ length: 20 }, (_, offset) => ({ url: `https://example.test/${29 - offset}`, title: `Page ${29 - offset}`, timestamp: 29 - offset })));
  const remaining = await db.listRecentPageSummaries(20, recent.nextCursor);
  assert.deepEqual(plain(remaining.pages), Array.from({ length: 10 }, (_, offset) => ({ url: `https://example.test/${9 - offset}`, title: `Page ${9 - offset}`, timestamp: 9 - offset })));
  assert.equal(remaining.nextCursor, null);
  connection.transaction = original;
  await db.savePageRecord({ ...first, title: '', text: 'New capture', timestamp: 40, chunks: [], manual: true }, { replace: true });
  assert.equal((await db.listRecentPageSummaries(1)).pages[0].title, first.url, 'Untitled captures still appear');
  await db.savePageRecord({ ...first, title: 'Renamed by restore', text: 'Restored', timestamp: 41, chunks: [], manual: true }, { replace: true });
  assert.equal((await db.listRecentPageSummaries(1)).pages[0].title, 'Renamed by restore');
  await db.deletePages([first.url]);
  assert.equal((await db.listRecentPageSummaries(1)).pages[0].url, 'https://example.test/29');
});

test('stopping polling removes its visibility subscription as well as its timer', async () => {
  const document = new EventTarget(), timers = new Map(); let calls = 0;
  document.visibilityState = 'hidden';
  const { startPolling } = await loadSource('src/ui/shared/polling.ts', '', {}, { document, window: { setInterval(callback) { timers.set(1, callback); return 1; }, clearInterval(id) { timers.delete(id); } } });
  const stop = startPolling(() => { calls++; }, 5000);
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 1);
  stop(); document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 1); assert.equal(timers.size, 0);
});

test('scrolling loads only the next batch, coalesces duplicate intersections and preserves an open preview', async t => {
  const pending = deferred(), cursor = { ...first };
  let observed, notify, following = 0;
  class Observer {
    constructor(callback) { notify = callback; }
    observe(target) { observed = target; }
    disconnect() {}
  }
  const fixture = await panel(sessionFixture(), message => {
    if (message.after) { following++; assert.deepEqual(plain(message.after), cursor); return pending.promise; }
    return { pages: [first], nextCursor: cursor };
  }, { observe: Observer }); t.after(fixture.close);
  await waitFor(() => fixture.titles().length === 1, 'first batch');
  assert.equal(following, 0, 'Initial rendering must not fetch the rest of the library');
  const preview = fixture.q('#beta-recents-list details'); preview.open = true;
  assert.equal(observed, fixture.q('#beta-load-more-recents'));
  notify([{ isIntersecting: true }]); notify([{ isIntersecting: true }]); fixture.poll();
  await tick();
  assert.equal(following, 1);
  pending.resolve({ pages: [first, second], nextCursor: null });
  await waitFor(() => fixture.titles().length === 2, 'lazy batch');
  assert.equal(fixture.q('#beta-recents-list details'), preview, 'Appending must not remount the open page or its Ask view');
  assert.equal(preview.open, true);
  assert.equal(fixture.q('#beta-load-more-recents').hidden, true);
});

test('a failed next-page read keeps existing rows and can be retried from the same cursor', async t => {
  let fail = true;
  const fixture = await panel(sessionFixture(), message => {
    if (!message.after) return { pages: [first], nextCursor: first };
    if (fail) throw Error('Next page unavailable');
    return { pages: [second], nextCursor: null };
  }); t.after(fixture.close);
  await waitFor(() => fixture.titles().length === 1, 'first batch');
  fixture.q('#beta-load-more-recents').click();
  await waitFor(() => fixture.q('#beta-search-status').textContent.includes('Next page unavailable'), 'pagination failure');
  assert.equal(fixture.titles().length, 1);
  fail = false; fixture.q('#beta-load-more-recents').focus(); fixture.q('#beta-load-more-recents').click();
  await waitFor(() => fixture.titles().length === 2, 'successful retry');
  assert.equal(fixture.window.document.activeElement, fixture.window.document.querySelectorAll('#beta-recents-list summary')[1], 'Keyboard focus must move to the newly loaded page when Load more disappears');
});

test('a delayed next-page response cannot resurrect rows after Memory invalidates the list', async t => {
  const pending = deferred(); let changed = false;
  const fixture = await panel(sessionFixture(), message => message.after ? pending.promise : { pages: changed ? [second] : [first], nextCursor: changed ? null : first }); t.after(fixture.close);
  await waitFor(() => fixture.titles().length === 1, 'first batch');
  fixture.q('#beta-load-more-recents').click(); await tick();
  changed = true; fixture.window.dispatchEvent(new fixture.window.Event('wr-memory-changed'));
  await waitFor(() => fixture.titles().some(title => title.includes(second.title)), 'replacement after deletion');
  pending.resolve({ pages: [first], nextCursor: null }); await tick(); await tick();
  assert.ok(!fixture.titles().some(title => title.includes(first.title)));
});

test('the cache boundary drops captured bodies, vectors and history even if a storage backend returns extra fields', async () => {
  const session = sessionFixture();
  const api = await service(session, async () => [{ ...first, text: 'Private captured body', chunks: [{ embedding: [1, 0] }], versions: [{ text: 'Old private body' }] }]);
  assert.deepEqual(plain((await api.getRecentPages()).pages), [first]);
  assert.deepEqual(plain(session.values[RECENTS_CACHE_KEY]), [first]);
});

test('upgrading an existing library adds metadata reads without changing saved evidence or history', async t => {
  const indexedDB = new IDBFactory();
  const record = { ...first, title: '', timestamp: 0, text: 'Preserve saved evidence', summary: 'Keep summary', chunks: [{ text: 'Keep passage', embedding: [0.5, 0.25] }], versions: [{ timestamp: 0, text: 'Keep history', chunks: [] }], manual: true, createdAt: 1, updatedAt: 1 };
  const previous = await new Promise((resolve, reject) => {
    const request = indexedDB.open('webRecallBeta', 3);
    request.onupgradeneeded = () => {
      const pages = request.result.createObjectStore('pages', { keyPath: 'url' }); pages.createIndex('timestamp', 'timestamp');
      request.result.createObjectStore('migrations', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const transaction = previous.transaction('pages', 'readwrite'); transaction.objectStore('pages').put(record);
    transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
  });
  previous.close();
  const db = await loadSource('src/shared/db/index.ts', '', {}, { indexedDB, IDBKeyRange });
  const connection = await db.openDatabase(); t.after(() => connection.close());
  assert.deepEqual(plain((await db.listRecentPageSummaries(20)).pages), [{ ...first, title: first.url, timestamp: 0 }]);
  assert.deepEqual(plain(await db.getPageRecord(first.url)), record);
});

test('explicit deletion and restore invalidate the snapshot before their successful response', async () => {
  const session = sessionFixture(); let records = [first];
  session.values.unrelated = 'Keep other session state';
  const api = await service(session, async () => records);
  const manage = await loadSource('src/background/manage/index.ts', '', {
    './recents': api,
    '../capture/index': { cancelCaptureJobs: async () => [] },
    '../embeddings/index': { getEmbeddingConfig: () => ({}) },
    '../storage/manager': { storageManager: { deletePages: async () => { records = []; return { deleted: 1, removedVersions: [] }; }, savePageRecord: async record => { records = [{ url: record.url, title: record.title, timestamp: record.timestamp }]; } } },
    '../offscreen/index': { invalidateOffscreenIndex: async () => {} }
  });
  await api.getRecentPages(); await manage.deleteManagePages([first.url]);
  assert.equal(session.values[RECENTS_CACHE_KEY], undefined);
  assert.equal(session.values.unrelated, 'Keep other session state');
  await api.getRecentPages();
  await manage.importManagePages({ schemaVersion: 1, pages: [{ ...second, text: 'Restored content', chunks: [], manual: true }] });
  assert.equal(session.values[RECENTS_CACHE_KEY], undefined);
  assert.equal(session.values.unrelated, 'Keep other session state');
  assert.deepEqual(plain((await api.getRecentPages()).pages), [second]);
});

test('later lazy batches never replace the first-page snapshot and cache write failures leave fresh reads usable', async () => {
  const session = sessionFixture();
  const api = await loadSource('src/background/manage/recents.ts', '', { '../storage/manager': { storageManager: {
    listRecentPageSummaries: async (_limit, cursor) => ({ pages: cursor ? [second] : [first], nextCursor: cursor ? null : first })
  } } }, { chrome: { storage: { session } } });
  await api.getRecentPages(); await api.getRecentPages(first);
  assert.deepEqual(plain(session.values[RECENTS_CACHE_KEY]), [first]);
  session.set = async () => { throw Error('Session quota unavailable'); };
  assert.deepEqual(plain((await api.getRecentPages()).pages), [first]);
  await assert.rejects(api.getRecentPages({ timestamp: Infinity, url: first.url, title: first.title }), /cursor/);
});

test('the runtime recents route is bounded while Memory Manager still receives the complete library without model calls', async t => {
  const indexedDB = new IDBFactory(), backend = providerFixture({}, { indexedDB, IDBKeyRange });
  await backend.connect();
  const db = await backend.load('src/shared/db/index.ts');
  const connection = await db.openDatabase(); t.after(() => connection.close());
  for (let index = 0; index < 30; index++) await db.savePageRecord({ url: `https://example.test/runtime/${index}`, title: `Saved ${index}`, timestamp: index + 1, manual: false, text: 'Stored privately', chunks: [] });
  const recent = await backend.send({ type: 'GET_RECENT_PAGES' });
  assert.equal(recent.pages.length, 20);
  assert.equal(recent.pages[0].title, 'Saved 29');
  assert.ok(recent.pages.every(page => Object.keys(page).sort().join(',') === 'timestamp,title,url'));
  assert.equal((await backend.send({ type: 'GET_RECENT_PAGES', after: recent.nextCursor })).pages.length, 10);
  assert.equal((await backend.send({ type: 'GET_PAGE_LIST' })).pages.length, 30, 'Recents must not impose its batch size on Memory Manager');
  assert.deepEqual(backend.requests, [], 'Rendering saved-page metadata must not call a model provider');
});

test('a warm reopen paints cached pages and the saved theme before a sleeping background replies to settings', async t => {
  const session = sessionFixture(), api = await service(session, async () => [first]);
  const initial = await panel(session, message => api.getRecentPages(message.after), { settings: { settings: { theme: 'dark', captureSetupComplete: true } } });
  await waitFor(() => initial.titles().length === 1 && initial.window.document.documentElement.dataset.theme === 'dark', 'initial dark-theme snapshot');
  const local = Object.fromEntries(Object.keys(initial.window.localStorage).map(key => [key, initial.window.localStorage.getItem(key)]));
  initial.close();
  const settings = deferred(), fresh = deferred();
  const reopened = await panel(session, () => fresh.promise, { settings: settings.promise, local }); t.after(reopened.close);
  await waitFor(() => reopened.titles().some(title => title.includes(first.title)), 'cached rows independent of background settings');
  assert.equal(reopened.window.document.documentElement.dataset.theme, 'dark');
  settings.resolve({ settings: { theme: 'dark', captureSetupComplete: true } }); fresh.resolve([second]);
  await waitFor(() => reopened.titles().some(title => title.includes(second.title)), 'fresh rows after background startup');
});

test('Ask these pages includes the lazy-loaded rows instead of silently limiting scope to the initial batch', async t => {
  const head = Array.from({ length: 20 }, (_, index) => ({ url: `https://example.test/head/${index}`, title: `Head ${index}`, timestamp: 100 - index }));
  const fixture = await panel(sessionFixture(), message => message.after ? { pages: [second], nextCursor: null } : { pages: head, nextCursor: head.at(-1) }); t.after(fixture.close);
  await waitFor(() => fixture.titles().length === 20, 'first batch');
  fixture.q('#beta-load-more-recents').click();
  await waitFor(() => fixture.titles().length === 21, 'older saved page');
  fixture.q('#beta-ask-results').click();
  fixture.q('#beta-ask-input').value = 'What do these pages cover?';
  fixture.q('#beta-ask-form').dispatchEvent(new fixture.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => fixture.messages.some(message => message.type === 'ASK_QUESTION'), 'Ask request');
  assert.deepEqual(plain(fixture.messages.find(message => message.type === 'ASK_QUESTION').options.scopeUrls), [...head.map(page => page.url), second.url]);
});
