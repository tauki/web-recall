import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, plain } from './helpers.mjs';

async function captureEntryFixture() {
  let command, menu, listener;
  const sent = [], injected = [], jobs = [];
  const stored = { betaSettings: { paused: true, captureSetupComplete: true, allowlist: [], denylist: ['private.test'] } };
  let tab = { id: 7, url: 'https://public.test/article' }, missingReceiver = false;
  const chrome = {
    runtime: { sendMessage() {} },
    storage: { onChanged: { addListener() {} }, local: {
      get(keys, callback) { callback(Object.fromEntries(keys.map(key => [key, stored[key]]))); },
      set(values, callback) { Object.assign(stored, values); callback?.(); }
    } },
    tabs: {
      query: async () => [tab], get: async () => tab,
      sendMessage: async (id, message) => {
        if (missingReceiver) { missingReceiver = false; throw Error('Could not establish connection. Receiving end does not exist.'); }
        sent.push({ id, message }); return { ok: true };
      }
    },
    scripting: { executeScript: async request => { injected.push(request.target.tabId); } },
    sidePanel: { setPanelBehavior: async () => {} }, windows: { WINDOW_ID_CURRENT: -2 },
    commands: { onCommand: { addListener(value) { command = value; } } },
    contextMenus: { removeAll(done) { done(); }, create() {}, onClicked: { addListener(value) { menu = value; } } }
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
  return { sent, injected, jobs, settings, queue,
    navigate: url => { tab = { ...tab, url }; },
    noReceiver: () => { missingReceiver = true; },
    keyboard: () => command('capture-this-page'),
    menu: () => menu({ menuItemId: 'wr_capture_now' }, tab),
    save: payload => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('SAVE_PAGE did not respond')), 5000);
      listener({ type: 'SAVE_PAGE', ...payload }, { tab }, response => { clearTimeout(timer); resolve(response); });
    })
  };
}

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
