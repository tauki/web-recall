import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
        else { globalThis.captureMessages.push(message); respond?.({ status: 'queued' }); }
      }
    } };
  });
  const bundled = await build({ entryPoints: ['src/content/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const original = await page.locator('article').innerHTML();
  const result = await page.evaluate(async () => {
    const acknowledgement = await new Promise(resolve => globalThis.deliverCaptureMessage({ type: 'FORCE_CAPTURE' }, {}, resolve));
    return { acknowledgement, messages: globalThis.captureMessages };
  });
  assert.equal(result.acknowledgement.ok, true);
  const saved = result.messages.find(message => message.type === 'SAVE_PAGE');
  assert.ok(saved, 'Manual capture must send a SAVE_PAGE message');
  assert.equal(saved.url, url);
  assert.equal(saved.title, 'Code guide');
  assert.equal(saved.manual, true);
  assert.equal(saved.captureInfo.source, 'article');
  assert.equal(saved.captureInfo.warnings.length, 1);
  assert.match(saved.captureInfo.warnings[0], /Collapsed content.*Expand/);
  assert.match(saved.text, /Article heading/);
  assert.match(saved.text, /Useful prose and inline\(\)/);
  assert.ok(saved.text.includes('const answer = 42;\nreturn answer;'), 'Code line breaks must survive capture');
  assert.doesNotMatch(saved.text, /Noise/);
  assert.match(saved.text, /Visible child/);
  assert.match(saved.text, /Visible summary/);
  assert.ok(saved.chunks.join(' ').includes('const answer = 42; return answer;'), 'Saved chunks must retain the code');
  assert.equal(await page.locator('article').innerHTML(), original);
  await page.locator('article').evaluate(article => { article.parentElement.style.display = 'none'; });
  const count = await page.evaluate(async () => {
    globalThis.captureMessages = [];
    await new Promise(resolve => globalThis.deliverCaptureMessage({ type: 'FORCE_CAPTURE' }, {}, resolve));
    return globalThis.captureMessages.filter(message => message.type === 'SAVE_PAGE').length;
  });
  assert.equal(count, 0, 'Hidden ancestors must also prevent text extraction');
});

test('manual capture sends whole-page fallback text and metadata, and never acknowledges unsupported viewers', async t => {
  const browser = await chromium.launch({ headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const bundled = await build({ entryPoints: ['src/content/index.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
  for (const fixture of ['documentation', 'forum', 'embedded', 'pdf']) {
    await t.test(fixture, async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      try {
        const html = fixture === 'embedded' || fixture === 'pdf'
          ? '<main><h1>Document viewer</h1><button>Zoom</button><iframe src="about:blank"></iframe></main>'
          : await readFile(new URL(`./fixtures/extraction/${fixture}.html`, import.meta.url), 'utf8');
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
        await page.goto(`https://capture.example.test/${fixture}`);
        await page.evaluate(mime => {
          if (mime) Object.defineProperty(document, 'contentType', { value: mime });
          globalThis.captureMessages = [];
          globalThis.chrome = { runtime: {
            onMessage: { addListener(listener) { globalThis.deliverCaptureMessage = listener; } },
            sendMessage(message, respond) {
              if (message.type === 'SHOULD_CAPTURE') respond?.({ allow: false });
              else { globalThis.captureMessages.push(message); respond?.({ status: 'queued' }); }
            }
          } };
        }, fixture === 'pdf' ? 'application/pdf' : null);
        await page.addScriptTag({ content: bundled.outputFiles[0].text });
        const result = await page.evaluate(async () => ({
          acknowledgement: await new Promise(resolve => globalThis.deliverCaptureMessage({ type: 'FORCE_CAPTURE' }, {}, resolve)),
          messages: globalThis.captureMessages
        }));
        if (fixture === 'embedded' || fixture === 'pdf') {
          assert.equal(result.acknowledgement.ok, undefined);
          assert.match(result.acknowledgement.error, fixture === 'pdf' ? /PDF.*HTML or text/ : /embedded content.*HTML or text/);
          assert.equal(result.messages.filter(message => message.type === 'SAVE_PAGE').length, 0);
        } else {
          assert.equal(result.acknowledgement.ok, true);
          const saved = result.messages.find(message => message.type === 'SAVE_PAGE');
          assert.equal(saved.captureInfo.source, 'main');
          assert.deepEqual(saved.captureInfo.warnings, []);
          const expected = fixture === 'forum' ? 'The restart recovered every pending job in order.' : 'Maximum queued jobs';
          assert.ok(saved.text.includes(expected), 'SAVE_PAGE must carry the useful text beyond the first article');
          assert.ok(saved.chunks.some(chunk => chunk.includes(expected)), 'Processing chunks must carry that actual extracted text too');
          assert.doesNotMatch(saved.text, /Noise/);
        }
      } finally { await page.close(); }
    });
  }
});
