import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { loadSource } from './helpers.mjs';

for (const shutdown of ['restart', 'browser-process crash']) test(`saved memory and downloaded-model cache survive an isolated Chrome ${shutdown} with eviction protection`, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'web-recall-storage-test-'));
  const extension = path.join(temporary, 'extension');
  const profile = path.join(temporary, 'profile');
  let context;
  try {
    await mkdir(extension);
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: manifest.manifest_version,
      minimum_chrome_version: manifest.minimum_chrome_version,
      name: 'Web Recall isolated storage test',
      version: manifest.version,
      permissions: manifest.permissions,
      background: { ...manifest.background, service_worker: 'background.js' }
    }));
    await writeFile(path.join(extension, 'inspect.html'), '<!doctype html><title>Isolated storage test</title>');
    await build({ entryPoints: ['src/background/index.ts'], outfile: path.join(extension, 'background.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' });
    const launch = () => chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, timeout: 10000,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const open = async () => {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
      const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
      const page = await context.newPage();
      await page.goto(`${origin}/inspect.html`);
      return page;
    };
    context = await launch();
    const first = await open();
    assert.equal(await first.evaluate(() => chrome.permissions.contains({ permissions: ['unlimitedStorage'] })), true);
    const { BROWSER_MODEL_CACHE } = await loadSource('src/shared/browserModels.ts');
    const cachedFile = { name: BROWSER_MODEL_CACHE, url: 'https://huggingface.co/example/storage-test/resolve/pinned/onnx/model.onnx', contents: 'Synthetic cached model bytes, not usable model weights.' };
    await first.evaluate(async file => {
      const cache = await caches.open(file.name);
      await cache.put(file.url, new Response(file.contents));
    }, cachedFile);
    const saved = { url: 'https://example.test/durable', title: 'Persistent article', text: 'Saved evidence before restart.', timestamp: 10, manual: true, summary: 'The article explains durable storage.', chunks: [{ text: 'Saved evidence before restart.', embedding: [0.25, 0.75], embeddingKey: 'test-model' }] };
    const imported = await first.evaluate(record => chrome.runtime.sendMessage({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [record] }), saved);
    assert.equal(imported.error, undefined);
    assert.equal(imported.imported, 1);
    const originalUrl = first.url();
    if (shutdown === 'browser-process crash') {
      const browser = context.browser();
      const session = await browser.newBrowserCDPSession();
      const disconnected = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('The isolated browser did not crash')), 10000);
        browser.once('disconnected', () => { clearTimeout(timer); resolve(); });
      });
      await Promise.all([session.send('Browser.crash').catch(() => {}), disconnected]);
      assert.equal(browser.isConnected(), false);
      await context.close().catch(() => {});
    } else await context.close();
    context = undefined;
    context = await launch();
    const second = await open();
    assert.equal(second.url(), originalUrl);
    const result = await second.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_BACKUP_PAGE' }));
    assert.equal(result.error, undefined);
    const restored = JSON.parse(result.line).page;
    assert.equal(restored.url, saved.url);
    assert.equal(restored.title, saved.title);
    assert.equal(restored.text, saved.text);
    assert.equal(restored.summary, saved.summary);
    assert.equal(restored.manual, true);
    assert.deepEqual(restored.chunks, saved.chunks);
    const retainedModel = await second.evaluate(async file => {
      if (!(await caches.has(file.name))) return null;
      return (await (await caches.open(file.name)).match(file.url))?.text();
    }, cachedFile);
    assert.equal(retainedModel, cachedFile.contents, 'The model cache must survive independently of the saved library and settings');
  } finally {
    await context?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
