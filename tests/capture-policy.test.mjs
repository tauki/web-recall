import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, plain } from './helpers.mjs';

async function captureEntryFixture() {
  let command, menu, listener;
  let gestureActive = false;
  const sent = [], injected = [], jobs = [], menus = [], panels = [];
  const stored = { betaSettings: { paused: true, captureSetupComplete: true, allowlist: [], denylist: ['private.test'] } };
  let tab = { id: 7, url: 'https://public.test/article' }, missingReceiver = false;
  let focusedTab;
  const chrome = {
    runtime: { sendMessage() {} },
    storage: { onChanged: { addListener() {} }, local: {
      get(keys, callback) { callback(Object.fromEntries(keys.map(key => [key, stored[key]]))); },
      set(values, callback) { Object.assign(stored, values); callback?.(); }
    } },
    tabs: {
      query: async () => [focusedTab ?? tab],
      get: async id => {
        if (id === tab.id) return tab;
        if (id === focusedTab?.id) return focusedTab;
        throw Error('No such tab');
      },
      sendMessage: async (id, message) => {
        if (missingReceiver) { missingReceiver = false; throw Error('Could not establish connection. Receiving end does not exist.'); }
        sent.push({ id, message }); return { ok: true };
      }
    },
    scripting: { executeScript: async request => { injected.push(request.target.tabId); } },
    sidePanel: {
      setPanelBehavior: async () => {},
      async open({ windowId }) {
        if (!gestureActive) throw Error('Opening the side panel requires a user gesture');
        panels.push({ action: 'open', windowId });
      },
      async close({ windowId }) { panels.push({ action: 'close', windowId }); }
    },
    commands: { onCommand: { addListener(value) { command = value; } } },
    contextMenus: { removeAll(done) { menus.length = 0; done(); }, create(item) { menus.push(plain(item)); }, onClicked: { addListener(value) { menu = value; } } }
  };
  const settings = await loadSource('src/background/settings/index.ts', '', { '../../shared/logger/index': { setLogLevel() {} } }, { chrome });
  const context = { chrome, self: { addEventListener() {} }, console: { info() {}, warn() {}, error() {} } };
  await loadSource('src/background/index.ts', '', {
    './capture/index': { createCaptureQueue: () => ({ bindRuntimeListener() {} }) },
    './embeddings/index': { configureEmbeddings() {} }, './storage/index': { initStorage() {} },
    './orchestration/index': { orchestrateLifecycle() {} }, './settings/index': settings, '../settings/index': settings
  }, context);
  chrome.runtime.onMessage = { addListener(value) { listener = value; } };
  const capture = await loadSource('src/background/capture/index.ts', '', {
    './processor': { processCapturePayload: async payload => { jobs.push(plain(payload)); } },
    '../processing/index': { listProcessingEntries: async () => [], markQueued: async () => true, markProcessing: async () => true, markDone: async () => {}, markFailed: async () => {}, getProcessingEntryByUrl: async () => undefined },
    '../settings/index': settings, '../../shared/logger/index': { log: async () => {} }
  }, context);
  const queue = capture.createCaptureQueue();
  queue.bindRuntimeListener();
  const withGesture = action => {
    gestureActive = true;
    try { return action(); }
    finally { gestureActive = false; }
  };
  return { sent, injected, jobs, settings, queue, panels,
    navigate: url => { tab = { ...tab, url }; },
    focus: nextTab => { focusedTab = nextTab; },
    noReceiver: () => { missingReceiver = true; },
    keyboard: () => command('capture-this-page', tab),
    keyboardWithoutTab: () => command('capture-this-page'),
    menu: () => menu({ menuItemId: 'wr_capture_now' }, tab),
    shortcutPanel: windowId => withGesture(() => command('open-side-panel', { ...tab, windowId })),
    menuPanel: windowId => withGesture(() => menu({ menuItemId: 'wr_open_panel' }, { ...tab, windowId })),
    contextMenu: (contextType, info = {}) => {
      const item = menus.find(candidate => candidate.contexts.some(context => context === 'all' || context === contextType) && /capture.*page/i.test(candidate.title));
      assert.ok(item, `Page capture must be offered in Chrome's ${contextType} context`);
      return menu({ ...info, menuItemId: item.id }, tab);
    },
    save: payload => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('SAVE_PAGE did not respond')), 5000);
      listener({ type: 'SAVE_PAGE', ...payload }, { tab }, response => { clearTimeout(timer); resolve(response); });
    })
  };
}

test('native panel actions open in the triggering window before the user gesture expires', async () => {
  const fixture = await captureEntryFixture();
  await fixture.menuPanel(22);
  await fixture.shortcutPanel(17);
  await fixture.shortcutPanel(17);
  await fixture.shortcutPanel(17);
  await fixture.shortcutPanel(22);
  assert.deepEqual(plain(fixture.panels), [
    { action: 'open', windowId: 22 },
    { action: 'open', windowId: 17 },
    { action: 'close', windowId: 17 },
    { action: 'open', windowId: 17 },
    { action: 'close', windowId: 22 }
  ]);
});

test('keyboard and context-menu capture obey domain rules while allowing capture during pause', async () => {
  const fixture = await captureEntryFixture();
  for (const trigger of [fixture.keyboard, fixture.menu]) {
    fixture.navigate('https://sub.private.test/secret');
    await trigger();
    assert.equal(fixture.sent.length, 0);
    fixture.navigate('chrome://extensions');
    await trigger();
    assert.equal(fixture.sent.length, 0);
  }
  await fixture.settings.updateSettings({ allowlist: ['allowed.test'] });
  fixture.navigate('https://other.test/article');
  await fixture.keyboard(); await fixture.menu();
  assert.equal(fixture.sent.length, 0);
  fixture.navigate('https://allowed.test/article');
  fixture.noReceiver();
  await fixture.keyboard(); await fixture.menu();
  assert.deepEqual(fixture.injected, [7]);
  assert.deepEqual(plain(fixture.sent), [{ id: 7, message: { type: 'FORCE_CAPTURE' } }, { id: 7, message: { type: 'FORCE_CAPTURE' } }]);
  assert.equal((await fixture.settings.getSettings()).paused, true);
});

test('capture shortcut saves only the tab Chrome supplied, even if another tab is active by dispatch', async () => {
  const fixture = await captureEntryFixture();
  fixture.focus({ id: 11, url: 'https://public.test/other-window' });
  await fixture.keyboard();
  assert.deepEqual(fixture.sent.map(({ id }) => id), [7], 'Capture the triggering tab, not a later active tab');
  await fixture.keyboardWithoutTab();
  fixture.navigate('https://private.test/excluded-article');
  await fixture.keyboard();
  assert.deepEqual(fixture.sent.map(({ id }) => id), [7], 'A missing or excluded trigger must not save another tab');
});

test('right-click capture is available on selected text, links and media and always captures the current page', async () => {
  const fixture = await captureEntryFixture();
  for (const contextType of ['page', 'selection', 'link', 'image', 'video', 'audio', 'editable', 'frame', 'action']) {
    await fixture.contextMenu(contextType, {
      pageUrl: 'https://public.test/article', selectionText: 'Only a selected excerpt',
      linkUrl: 'https://private.test/linked-secret', srcUrl: 'https://private.test/image.png',
      frameUrl: 'https://private.test/embedded-frame'
    });
    assert.deepEqual(plain(fixture.sent.at(-1)), { id: 7, message: { type: 'FORCE_CAPTURE' } }, `${contextType} capture must use the current tab rather than the selected text, link, media or frame`);
  }
  assert.equal(fixture.sent.length, 9);
  assert.equal((await fixture.settings.getSettings()).paused, true, 'Explicit capture must not resume automatic capture');
});

test('SAVE_PAGE checks current capture policy before accepting durable work', async () => {
  const fixture = await captureEntryFixture();
  const payload = { url: 'https://private.test/secret', text: 'Private', title: 'Secret', timestamp: 1, chunks: ['Private'], manual: true, force: true };
  assert.match((await fixture.save(payload)).error, /blocked/i);
  assert.equal(fixture.queue.peekQueue().length, 0);
  assert.deepEqual(fixture.jobs, []);
  assert.match((await fixture.save({ ...payload, url: 'https://public.test/article', manual: false, force: false })).error, /blocked/i);
  assert.match((await fixture.save({ ...payload, url: 'https://public.test/article', manual: 'true' })).error, /blocked/i);
  assert.deepEqual(fixture.jobs, []);
  assert.equal((await fixture.save({ ...payload, url: 'https://public.test/article' })).status, 'queued');
});

test('explicit site exclusions override allowlists and manual capture during pause', async () => {
  const fixture = await captureEntryFixture();
  await fixture.settings.updateSettings({ allowlist: ['public.test'], denylist: ['public.test'] });
  await fixture.keyboard(); await fixture.menu();
  assert.equal(fixture.sent.length, 0);
  const result = await fixture.save({ url: 'https://public.test/article', text: 'Excluded content', title: 'Excluded', timestamp: 1, chunks: ['Excluded content'], manual: true });
  assert.match(result.error, /blocked/);
  assert.equal(fixture.jobs.length, 0);
});

test('capture policy rejects protected, malformed and unsupported URL schemes', async () => {
  const fixture = await captureEntryFixture();
  for (const url of ['chrome://extensions', 'about:blank', 'file:///tmp/notes.html', 'data:text/html,Private', 'not a URL']) {
    assert.equal(await fixture.settings.shouldCaptureUrl(url, { ignorePaused: true }), false);
  }
});
