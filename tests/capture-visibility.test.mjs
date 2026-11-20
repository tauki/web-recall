import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadSource, tick, plain } from './helpers.mjs';

async function pageFixture({ visible = true, focused = true, deferredEligibility = false, deferredSave = false, saveError, empty = false } = {}) {
  const dom = new JSDOM(`<title>Reading notes</title><article><h1>${empty ? '' : 'A useful page'}</h1><p>${empty ? '' : 'Saved reading.'}</p></article>`, { url: 'https://reading.test/article', pretendToBeVisual: true });
  const { window } = dom, { document } = window;
  Object.defineProperty(document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  document.hasFocus = () => focused;
  let now = 0, next = 0, receiver;
  const timers = new Map(), messages = [], eligibility = [], saves = [];
  window.setTimeout = (callback, delay) => { timers.set(++next, { at: now + delay, callback }); return next; };
  window.clearTimeout = id => timers.delete(id);
  window.setInterval = (callback, delay) => { timers.set(++next, { at: now + delay, callback, interval: delay }); return next; };
  window.clearInterval = id => timers.delete(id);
  const navigateUnobserved = window.history.pushState.bind(window.history);
  const chrome = { runtime: { onMessage: { addListener: listener => { receiver = listener; } }, sendMessage(message, respond) {
    messages.push(plain(message));
    if (message.type === 'SHOULD_CAPTURE') {
      if (deferredEligibility) eligibility.push(respond);
      else respond({ allow: true });
    } else if (message.type === 'SAVE_PAGE') {
      if (deferredSave) saves.push(respond);
      else respond?.(saveError ? { error: saveError } : { status: 'queued' });
    }
  } } };
  await loadSource('src/content/index.ts', '', {}, { window, document, chrome, history: window.history, location: window.location, MutationObserver: window.MutationObserver, Node: window.Node, Element: window.Element, HTMLElement: window.HTMLElement, HTMLDetailsElement: window.HTMLDetailsElement, getComputedStyle: window.getComputedStyle.bind(window) });
  await tick();
  return { messages,
    captures: () => messages.filter(message => message.type === 'SAVE_PAGE'),
    async advance(duration) {
      const end = now + duration;
      while (true) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!entry) break;
        now = entry[1].at; timers.delete(entry[0]);
        if (entry[1].interval) timers.set(entry[0], { ...entry[1], at: now + entry[1].interval });
        entry[1].callback(); await tick();
      }
      now = end; await tick();
    },
    visibility(value) { visible = value; document.dispatchEvent(new window.Event('visibilitychange')); },
    focus(value) { focused = value; window.dispatchEvent(new window.Event(value ? 'focus' : 'blur')); },
    async mutate(text) { document.querySelector('p').textContent = text; await tick(); },
    navigate(path) { window.history.pushState({}, '', path); },
    navigateUnobserved(path) { navigateUnobserved({}, '', path); },
    releaseEligibility() { deferredEligibility = false; for (const respond of eligibility.splice(0)) respond({ allow: true }); },
    confirmSave() { for (const respond of saves.splice(0)) respond({ status: 'queued' }); },
    manual: () => new Promise(resolve => receiver({ type: 'FORCE_CAPTURE' }, {}, resolve)),
    close: () => window.close()
  };
}

test('hidden pages do not auto-capture and becoming visible starts a fresh foreground dwell', async t => {
  const page = await pageFixture({ visible: false }); t.after(page.close);
  await page.advance(30000); assert.equal(page.captures().length, 0);
  page.visibility(true); await page.advance(1499); assert.equal(page.captures().length, 0);
  await page.advance(1); assert.equal(page.captures().length, 1);
});

test('a visible but unfocused window does not count as foreground reading', async t => {
  const page = await pageFixture({ focused: false }); t.after(page.close);
  await page.advance(30000); assert.equal(page.captures().length, 0);
  page.focus(true); await page.advance(1500); assert.equal(page.captures().length, 1);
});

test('switching away resets dwell and prevents a delayed eligibility reply from capturing in the background', async t => {
  const page = await pageFixture({ deferredEligibility: true }); t.after(page.close);
  await page.advance(1500); assert.equal(page.captures().length, 0);
  page.visibility(false); page.releaseEligibility(); await page.advance(20000);
  assert.equal(page.captures().length, 0);
  page.visibility(true); await page.advance(1499); assert.equal(page.captures().length, 0);
  await page.advance(1); assert.equal(page.captures().length, 1);
});

test('navigation invalidates earlier eligibility and captures only the new settled page', async t => {
  const page = await pageFixture({ deferredEligibility: true }); t.after(page.close);
  await page.advance(1500); page.navigate('/new-article'); page.releaseEligibility(); await tick();
  assert.equal(page.captures().length, 0);
  await page.advance(1500);
  assert.deepEqual(page.captures().map(capture => capture.url), ['https://reading.test/new-article']);
});

test('manual capture bypasses foreground dwell but waits for the background confirmation', async t => {
  const page = await pageFixture({ visible: false, focused: false, deferredSave: true }); t.after(page.close);
  let confirmed = false;
  const request = page.manual().then(result => { confirmed = true; return result; }); await tick();
  assert.equal(confirmed, false);
  page.confirmSave(); const result = await request;
  assert.equal(result.ok, true);
  assert.equal(page.captures()[0].manual, true);
  assert.equal(page.messages.some(message => message.type === 'SHOULD_CAPTURE'), false);
});

test('manual capture reports the actual background failure instead of acknowledging success', async t => {
  const page = await pageFixture({ saveError: 'Capture blocked by your capture rules.' }); t.after(page.close);
  const result = await page.manual();
  assert.equal(result.ok, undefined);
  assert.match(result.error, /blocked/);
});

test('continuous foreground updates capture by the documented maximum wait and require explicit recapture afterward', async t => {
  const page = await pageFixture(); t.after(page.close);
  for (let count = 0; count < 19; count++) { await page.advance(1000); await page.mutate(`Reading update ${count}`); }
  assert.equal(page.captures().length, 0);
  await page.advance(1000); assert.equal(page.captures().length, 1);
  await page.mutate('Later article revision'); await page.advance(30000);
  assert.equal(page.captures().length, 1);
  await page.manual(); assert.equal(page.captures().length, 2);
  assert.match(page.captures()[1].text, /Later article revision/);
});

test('an initially empty dynamic page retains a bounded capture attempt when later content never becomes idle', async t => {
  const page = await pageFixture({ empty: true }); t.after(page.close);
  await page.advance(1500); assert.equal(page.captures().length, 0);
  for (let count = 0; count < 19; count++) { await page.advance(1000); await page.mutate(`Loaded article update ${count}`); }
  assert.equal(page.captures().length, 0);
  await page.advance(1000); assert.equal(page.captures().length, 1);
  assert.match(page.captures()[0].text, /Loaded article update/);
});

test('navigation detected by URL polling cannot inherit the previous page foreground dwell', async t => {
  const page = await pageFixture(); t.after(page.close);
  await page.advance(1400); page.navigateUnobserved('/polled-article');
  await page.advance(100); assert.equal(page.captures().length, 0);
  await page.advance(1399); assert.equal(page.captures().length, 0);
  await page.advance(20000); assert.deepEqual(page.captures().map(capture => capture.url), ['https://reading.test/polled-article']);
});
