import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { observeSavedReader } from '../scripts/lib/recall-observer.mjs';
import { verifyPassage } from '../scripts/lib/recall-evaluation.mjs';

test('saved-reader verification observes useful body lines without requiring exact highlight clipping', async testContext => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  testContext.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 600 } });
  await page.route('https://reader.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto('https://reader.test/');
  const scenario = { kind: 'vague', query: 'air movement in a comfortable room' };
  const render = async options => {
    const fixture = await page.evaluate(options => {
      document.head.innerHTML = '<style>html,body{margin:0}pre{margin:0;white-space:pre-wrap;font:16px/24px sans-serif;width:300px}mark{background:#ddd;color:#111}</style>';
      document.body.replaceChildren();
      const host = document.createElement('div'), reader = document.createElement('pre'); host.append(reader); document.body.append(host);
      const heading = 'Comfort notes\n\n';
      const body = options.partialOverlay ? 'Fresh air moves between rooms.' : 'Open the upper vent and leave the inner door ajar. Air can then move between rooms without changing the thermostat. Record outdoor noise before choosing a ventilation routine.';
      const prefix = heading + (options.distant ? 'An unrelated workshop observation.\n'.repeat(80) : '');
      const authored = (options.blankLine ? '   \n' : '') + body;
      const text = prefix + authored + '\n\nAdditional surrounding context.';
      const start = options.boundary ? prefix.length - 7 : 0;
      const end = options.boundary ? prefix.length + 90 : heading.trim().length;
      reader.append(document.createTextNode(text.slice(0, start)));
      const marker = document.createElement('mark');
      if (options.split) {
        for (const fragment of [text.slice(start, start + 3), text.slice(start + 3, end)]) { const span = document.createElement('span'); span.textContent = fragment; marker.append(span); }
      } else marker.textContent = text.slice(start, end);
      const following = document.createElement('span'); following.textContent = text.slice(end);
      if (options.hiddenBody) following.style.visibility = 'hidden';
      if (options.transparentBody) following.style.opacity = '0';
      reader.append(marker, following);
      if (options.noMarker) marker.replaceWith(...marker.childNodes);
      if (options.width) reader.style.width = `${options.width}px`;
      if (options.clip) { host.style.height = options.blankLine ? '72px' : '55px'; host.style.overflow = 'hidden'; }
      if (options.hidden) reader.style.visibility = 'hidden';
      if (options.obstructed) { const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0 0 auto;height:400px;background:white;z-index:2'; document.body.append(overlay); }
      if (options.partialOverlay) { const header = document.createElement('header'); header.style.cssText = 'position:fixed;inset:0 0 auto;height:55px;background:white;z-index:2'; document.body.append(header); }
      return { text, passages: [{ start: prefix.length, end: prefix.length + authored.length }] };
    }, options);
    const reading = await page.locator('pre').evaluate(observeSavedReader, fixture.passages);
    assert.equal(reading.digest, createHash('sha256').update(fixture.text).digest('hex'), 'Observation preserves the complete saved text');
    return { reading, verdict: verifyPassage(scenario, reading.marker, fixture, reading.visibleBodyRanges) };
  };
  for (const options of [{ boundary: true }, {}, { boundary: true, split: true, width: 180 }, { split: true, width: 260 }]) {
    assert.equal((await render(options)).verdict, true, `Useful body text is visible despite wrapping: ${JSON.stringify(options)}`);
  }
  for (const options of [{ distant: true }, { clip: true }, { clip: true, blankLine: true }, { hidden: true }, { noMarker: true }, { obstructed: true }, { hiddenBody: true }, { transparentBody: true }, { boundary: true, partialOverlay: true }]) {
    assert.equal((await render(options)).verdict, false, `Unavailable useful evidence must fail: ${JSON.stringify(options)}`);
  }
});
