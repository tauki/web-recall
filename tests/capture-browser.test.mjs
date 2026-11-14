import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test('manual capture delivers article headings and code through SAVE_PAGE without changing the page', async t => {
  const browser = await chromium.launch({ headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const url = 'https://capture.example.test/article';
  await page.route('**/*', route => route.request().url() === url
    ? route.fulfill({ contentType: 'text/html', body: '<title>Code guide</title><style>.concealed { display: none; }</style><article><header>Article heading</header><p>Useful prose and <code>inline()</code>.</p><pre><code>const answer = 42;\nreturn answer;</code></pre><p hidden>Noise hidden attribute</p><div class="concealed"><span>Noise hidden ancestor</span></div><p style="visibility:hidden">Noise visibility<span style="visibility:visible">Visible child</span></p><p style="content-visibility:hidden">Noise skipped rendering</p><details><summary>Visible summary</summary>Noise closed details</details><nav>Noise navigation</nav><footer>Noise footer</footer><aside>Noise aside</aside><script type="application/json">Noise script</script><style>/* Noise style */</style></article>' })
    : route.abort());
  await page.goto(url);
  await page.evaluate(() => {
    globalThis.captureMessages = [];
    globalThis.chrome = { runtime: {
      onMessage: { addListener(listener) { globalThis.deliverCaptureMessage = listener; } },
      sendMessage(message, respond) {
        if (message.type === 'SHOULD_CAPTURE') respond?.({ allow: false });
        else globalThis.captureMessages.push(message);
      }
    } };
  });
  const bundled = await build({ entryPoints: ['src/content/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const original = await page.locator('article').innerHTML();
  const result = await page.evaluate(() => {
    let acknowledgement;
    globalThis.deliverCaptureMessage({ type: 'FORCE_CAPTURE' }, {}, response => { acknowledgement = response; });
    return { acknowledgement, messages: globalThis.captureMessages };
  });
  assert.equal(result.acknowledgement.ok, true);
  const saved = result.messages.find(message => message.type === 'SAVE_PAGE');
  assert.ok(saved, 'Manual capture must send a SAVE_PAGE message');
  assert.equal(saved.url, url);
  assert.equal(saved.title, 'Code guide');
  assert.equal(saved.manual, true);
  assert.match(saved.text, /Article heading/);
  assert.match(saved.text, /Useful prose and inline\(\)/);
  assert.ok(saved.text.includes('const answer = 42;\nreturn answer;'), 'Code line breaks must survive capture');
  assert.doesNotMatch(saved.text, /Noise/);
  assert.match(saved.text, /Visible child/);
  assert.match(saved.text, /Visible summary/);
  assert.ok(saved.chunks.join(' ').includes('const answer = 42; return answer;'), 'Saved chunks must retain the code');
  assert.equal(await page.locator('article').innerHTML(), original);
  await page.locator('article').evaluate(article => { article.parentElement.style.display = 'none'; });
  const count = await page.evaluate(() => {
    globalThis.captureMessages = [];
    globalThis.deliverCaptureMessage({ type: 'FORCE_CAPTURE' }, {}, () => {});
    return globalThis.captureMessages.filter(message => message.type === 'SAVE_PAGE').length;
  });
  assert.equal(count, 0, 'Hidden ancestors must also prevent text extraction');
});
