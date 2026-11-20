import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test('structured extraction retains useful reading across representative page shapes', async t => {
  const browser = await chromium.launch({ headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const bundled = await build({ entryPoints: ['src/content/extraction.ts'], bundle: true, write: false, format: 'iife', globalName: 'captureExtraction', platform: 'browser' });
  const fixture = async (name, html) => {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.route('**/*', route => route.abort());
    await page.setContent(html ?? await readFile(new URL(`./fixtures/extraction/${name}.html`, import.meta.url), 'utf8'));
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    return { page, extract: () => page.evaluate(() => globalThis.captureExtraction.extractPage(document)) };
  };

  await t.test('article method keeps article headings but omits chrome, ads and unrelated embed warnings', async () => {
    const { page, extract } = await fixture('article');
    try {
      const before = await page.locator('body').innerHTML();
      const result = await extract();
      assert.equal(result.captureInfo.source, 'article');
      assert.deepEqual(result.captureInfo.warnings, []);
      assert.match(result.text, /^# Finding a comet$/m);
      assert.match(result.text, /^## Observations$/m);
      assert.match(result.text, /Field report by Ada/);
      assert.match(result.text, /Researchers tracked the faint object across three clear nights\./);
      assert.match(result.text, /The final observation confirmed its path beyond the morning horizon\./);
      assert.doesNotMatch(result.text, /Noise/);
      assert.equal(await page.locator('body').innerHTML(), before, 'Capture must not mutate live content');
    } finally { await page.close(); }
  });

  await t.test('documentation falls back from a sparse article and preserves lists, literal code and table columns', async () => {
    const { page, extract } = await fixture('documentation');
    try {
      const result = await extract();
      assert.equal(result.captureInfo.source, 'main');
      assert.deepEqual(result.captureInfo.warnings, []);
      assert.match(result.text, /^# Configure the worker$/m);
      assert.match(result.text, /Set the queueLimit before starting the worker\./);
      assert.match(result.text, /^3\. Install the package$/m);
      assert.match(result.text, /^8\. Set the queue size$/m);
      assert.match(result.text, /^9\. Start the worker$/m);
      assert.match(result.text, /^  - Choose a bounded limit$/m);
      assert.match(result.text, /^  - Record the chosen value$/m);
      assert.ok(result.text.includes('function start() {\n  const limit = 42;\n\n\n\n\treturn limit;\n}'), 'Code indentation, tabs, and blank lines must survive');
      assert.match(result.text, /^Option \| Default \| Meaning$/m);
      assert.match(result.text, /^queueLimit \| 42 \| Maximum queued jobs$/m);
      assert.match(result.text, /^label \|  \| Optional display name$/m);
      assert.ok(result.text.includes('<img src=x onerror="window.savedCodeRan = true">'), 'Code remains literal inert text');
      assert.equal(await page.evaluate(() => window.savedCodeRan), undefined);
      assert.doesNotMatch(result.text, /Noise|private query/);
    } finally { await page.close(); }
  });

  await t.test('forum capture retains all posts and surrounding thread context instead of the first article', async () => {
    const { page, extract } = await fixture('forum');
    try {
      for (const source of ['main', 'body']) {
        const result = await extract();
        assert.equal(result.captureInfo.source, source);
        assert.match(result.text, /^# How do we drain a queue\?$/m);
        assert.match(result.text, /Can an interrupted worker resume its pending jobs\?/);
        assert.match(result.text, /Keep a durable journal before acknowledging a job\./);
        assert.match(result.text, /The restart recovered every pending job in order\./);
        assert.ok(result.text.includes('await journal.append(job);\nawait acknowledge(job);'));
        assert.match(result.text, /^- Stop before commit$/m);
        assert.doesNotMatch(result.text, /Noise/);
        if (source === 'main') await page.locator('main').evaluate(main => main.replaceWith(...main.childNodes));
      }
    } finally { await page.close(); }
  });

  await t.test('hidden and sparse articles cannot eclipse useful main or body text', async () => {
    const { page, extract } = await fixture(null, '<article style="display:none"><p>Noise hidden first article</p></article><main><article><h2>Brief label</h2></article><h1>Reference material</h1><p>The useful page has several sections outside its article label and must not be discarded.</p><p>The fallback keeps this final paragraph too.</p></main>');
    try {
      assert.equal((await extract()).captureInfo.source, 'main');
      await page.locator('main').evaluate(main => main.replaceWith(...main.childNodes));
      const body = await extract();
      assert.equal(body.captureInfo.source, 'body');
      assert.match(body.text, /Reference material/);
      assert.match(body.text, /The fallback keeps this final paragraph too\./);
      assert.doesNotMatch(body.text, /Noise/);
      await page.locator('body').evaluate(body => { body.style.display = 'none'; });
      assert.equal((await extract()).text, '', 'A hidden ancestor must suppress every candidate');
    } finally { await page.close(); }
  });

  await t.test('a long first article cannot eclipse a short reply or useful context outside the main landmark', async () => {
    const { page, extract } = await fixture(null, `<main><h1>Thread context</h1><article><p>${'A detailed first post explains the queue. '.repeat(100)}</p></article><p>Short reply: keep the journal.</p></main><aside>Noise related topics</aside>`);
    try {
      const main = await extract();
      assert.equal(main.captureInfo.source, 'main');
      assert.match(main.text, /^# Thread context$/m);
      assert.match(main.text, /Short reply: keep the journal\./);
      await page.locator('body').evaluate(body => {
        const paragraph = document.createElement('p');
        paragraph.textContent = 'Final reply outside the main landmark.';
        body.append(paragraph);
      });
      const body = await extract();
      assert.equal(body.captureInfo.source, 'body');
      assert.match(body.text, /Short reply: keep the journal\./);
      assert.match(body.text, /Final reply outside the main landmark\./);
      assert.doesNotMatch(body.text, /Noise/);
    } finally { await page.close(); }
  });

  await t.test('dynamic capture describes the currently loaded text and clears loading warnings after hydration', async () => {
    const { page, extract } = await fixture('dynamic');
    try {
      const early = await extract();
      assert.equal(early.captureInfo.source, 'main');
      assert.match(early.text, /Build one passed the startup check\./);
      assert.equal(early.captureInfo.warnings.length, 1);
      assert.match(early.captureInfo.warnings[0], /still loading.*capture again/i);
      await page.locator('#entries').evaluate(entries => {
        const paragraph = document.createElement('p');
        paragraph.textContent = 'Build two completed the recovery check.';
        entries.append(paragraph);
        entries.closest('main').removeAttribute('aria-busy');
      });
      const settled = await extract();
      assert.match(settled.text, /Build one passed the startup check\./);
      assert.match(settled.text, /Build two completed the recovery check\./);
      assert.deepEqual(settled.captureInfo.warnings, [], 'Unrelated busy widgets must not label the selected root incomplete');
      assert.doesNotMatch(settled.text, /Noise/);
    } finally { await page.close(); }
  });

  await t.test('partial capture warnings apply only to omitted content in the chosen root', async () => {
    const { page, extract } = await fixture('partial');
    try {
      const partial = await extract();
      assert.equal(partial.captureInfo.source, 'main');
      assert.match(partial.text, /The text explains how to replay a journal after a crash\./);
      assert.match(partial.text, /Recovery appendix/);
      assert.doesNotMatch(partial.text, /Hidden recovery procedure|Noise/);
      assert.equal(partial.captureInfo.warnings.length, 2);
      assert.ok(partial.captureInfo.warnings.some(warning => /Embedded content.*HTML or text/.test(warning)));
      assert.ok(partial.captureInfo.warnings.some(warning => /Collapsed content.*Expand/.test(warning)));
      await page.locator('main > iframe').evaluate(frame => frame.remove());
      await page.locator('details').first().evaluate(details => { details.open = true; });
      const expanded = await extract();
      assert.match(expanded.text, /Hidden recovery procedure/);
      assert.deepEqual(expanded.captureInfo.warnings, [], 'Hidden embeds, empty details and widgets outside the root are not capture limitations');
    } finally { await page.close(); }
  });

  await t.test('article narrowing retains a main-level embed warning without importing unrelated body warnings', async () => {
    const { page, extract } = await fixture(null, '<main><article><h1>Journal recovery</h1><p>Replay the durable journal before accepting new jobs.</p></article><iframe src="about:blank" title="Recovery demonstration"></iframe></main><iframe src="about:blank" title="Unrelated site widget"></iframe><aside><iframe src="about:blank" title="Noise ad"></iframe></aside>');
    try {
      const partial = await extract();
      assert.match(partial.text, /Replay the durable journal before accepting new jobs\./);
      assert.equal(partial.captureInfo.warnings.length, 1);
      assert.match(partial.captureInfo.warnings[0], /Embedded content.*HTML or text/);
      await page.locator('main > iframe').evaluate(frame => frame.remove());
      const clean = await extract();
      assert.equal(clean.captureInfo.source, 'article');
      assert.deepEqual(clean.captureInfo.warnings, [], 'Unrelated body widgets must not contaminate the clean article');
      assert.doesNotMatch(clean.text, /Noise/);
    } finally { await page.close(); }
  });

  await t.test('article narrowing retains a collapsed main-level appendix even when its summary has no text', async () => {
    const { page, extract } = await fixture(null, '<main><article><h1>Journal recovery</h1><p>Replay the durable journal before accepting new jobs.</p></article><details><summary aria-label="Recovery appendix"><span aria-hidden="true">+</span></summary><p>Recovery appendix: compare every committed entry.</p></details></main>');
    try {
      const partial = await extract();
      assert.match(partial.text, /Replay the durable journal before accepting new jobs\./);
      assert.doesNotMatch(partial.text, /compare every committed entry/);
      assert.equal(partial.captureInfo.warnings.length, 1);
      assert.match(partial.captureInfo.warnings[0], /Collapsed content.*Expand/);
      await page.locator('details').evaluate(details => { details.open = true; });
      const expanded = await extract();
      assert.match(expanded.text, /Recovery appendix: compare every committed entry\./);
      assert.deepEqual(expanded.captureInfo.warnings, []);
    } finally { await page.close(); }
  });

  await t.test('PDF MIME and embedded-only viewer shells fail with actionable errors', async () => {
    const { page, extract } = await fixture(null, '<nav>Noise viewer navigation</nav><main><article><h1>Document viewer</h1></article><div role="toolbar">Noise zoom controls</div><object type="application/pdf" data="about:blank"></object></main>');
    try {
      await assert.rejects(extract(), /only contains embedded content.*HTML or text/i);
      await page.evaluate(() => Object.defineProperty(document, 'contentType', { value: 'application/pdf' }));
      await assert.rejects(extract(), /PDF capture is not supported.*HTML or text/i);
    } finally { await page.close(); }
  });
});
