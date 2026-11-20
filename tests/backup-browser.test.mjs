import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { buildBrowserStorageRuntime } from './browser-storage-runtime.mjs';

test('Settings and real MV3 ports restore a near-budget history offline without a whole-page message', { timeout: 120000 }, async testContext => {
  const started = performance.now();
  const checkpoint = phase => testContext.diagnostic(`${phase}: ${Math.round(performance.now() - started)} ms`);
  const directory = await mkdtemp(path.join(tmpdir(), 'web-recall-backup-contract-'));
  let context;
  testContext.after(async () => { await context?.close(); await rm(directory, { recursive: true, force: true }); });
  const source = path.resolve('src');
  const workerSource = `
    import { bindBackupTransfers } from ${JSON.stringify(path.join(source, 'background/manage/backup.ts'))};
    import { storageManager as db } from ${JSON.stringify(path.join(source, 'background/storage/manager.ts'))};
    bindBackupTransfers();
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.type === 'GET_SETTINGS') { respond({settings:{theme:'dark',captureSetupComplete:true,paused:true}}); return; }
      if (message.type === 'GET_PROCESSING') { respond({queue:[]}); return; }
      if (message.type === 'GET_BACKUP_RESTORE_MODE') { respond({recover:false}); return; }
    });
    globalThis.backupContract = {
      async seed() {
        const snapshot = index => ({title:'Reference '+index, versionId:'version-'+index, timestamp:index, firstCapturedAt:index, kept:true, manual:false,
          text:'Whole saved reference '+index+'\\n'+'science \\"quoted\\" \\\\ evidence '.repeat(30000), summary:'Overview '+index,
          chunks:Array.from({length:400},(_,chunk)=>({text:'Passage '+index+':'+chunk, embedding:Array.from({length:768},(_,dimension)=>((dimension+chunk)%37)/37),embeddingKey:'preserved-model',position:chunk})),
          futureMetadata:{nil:null,empty:[],enabled:false},captureInfo:{source:'article',warnings:[],extractor:'retained'}});
        const sample=snapshot(0);
        const count=Math.floor(125*1024*1024/new TextEncoder().encode(JSON.stringify(sample)).length);
        await db.savePageRecord({url:'https://backup.test/article',...sample,versions:Array.from({length:count-1},(_,index)=>snapshot(index+1))});
        return count;
      },
      async describe() {
        const page=await db.getPageRecord('https://backup.test/article');
        if(!page)return null;
        return [page,...page.versions].map(snapshot=>({title:snapshot.title,id:snapshot.versionId,time:snapshot.timestamp,textLength:snapshot.text.length,summary:snapshot.summary,kept:snapshot.kept,metadata:snapshot.futureMetadata,capture:snapshot.captureInfo,
          chunks:snapshot.chunks.map(chunk=>({text:chunk.text,key:chunk.embeddingKey,position:chunk.position,dimensions:chunk.embedding.length,sum:chunk.embedding.reduce((total,value)=>total+value,0)}))}));
      },
      clear:()=>db.deletePages(['https://backup.test/article'])
    };`;
  const plugins = [{ name: 'offline-contract', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/capture\/index|\.\.\/embeddings\/index)$/ }, args => ({ path: args.path, namespace: 'offline-contract' }));
    builder.onLoad({ filter: /.*/, namespace: 'offline-contract' }, () => ({ contents: 'export const cancelCaptureJobs=async()=>[]; export const getEmbeddingConfig=()=>({});' }));
  } }];
  const workerBundle = await build({ stdin: { contents: workerSource, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', plugins });
  const uiBundle = await build({ entryPoints: ['src/ui/sidepanel/index.ts'], bundle: true, write: false, format: 'esm' });
  await buildBrowserStorageRuntime(directory);
  await writeFile(path.join(directory, 'dist/beta/background.js'), workerBundle.outputFiles[0].text);
  const { background, content_security_policy, cross_origin_embedder_policy, cross_origin_opener_policy } = JSON.parse(await readFile('manifest.json', 'utf8'));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Web Recall backup contract', version: '1.0',
    permissions: ['storage', 'offscreen', 'unlimitedStorage'], background, content_security_policy, cross_origin_embedder_policy, cross_origin_opener_policy }));
  const panel = path.join(directory, 'dist/beta/ui/sidepanel');
  await mkdir(panel, { recursive: true });
  await writeFile(path.join(panel, 'index.js'), uiBundle.outputFiles[0].text);
  await writeFile(path.join(panel, 'index.html'), await readFile('src/ui/sidepanel/index.html'));
  context = await chromium.launchPersistentContext(path.join(directory, 'profile'), { channel: 'chromium', headless: true, timeout: 10000, args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`] });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  await context.route(/^https?:/, route => route.abort());
  checkpoint('opened');
  const count = await worker.evaluate(() => globalThis.backupContract.seed());
  checkpoint('seeded');
  const before = await worker.evaluate(() => globalThis.backupContract.describe());
  checkpoint('inspected');
  assert.equal(before.length, count); assert.ok(before.every(snapshot => snapshot.chunks.length === 400));
  const extensionId = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${extensionId}/dist/beta/ui/sidepanel/index.html#settings-storage`);
  await page.evaluate(() => {
    globalThis.savedBackup = undefined;
    globalThis.chromeMessages = [];
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = (...args) => {
      const port = connect(...args), post = port.postMessage.bind(port);
      port.postMessage = message => { globalThis.chromeMessages.push(new TextEncoder().encode(JSON.stringify(message)).length); post(message); };
      port.onMessage.addListener(message => globalThis.chromeMessages.push(new TextEncoder().encode(JSON.stringify(message)).length));
      return port;
    };
    window.showSaveFilePicker = async () => ({ createWritable: async () => {
      let parts = [];
      return { write: async value => { parts.push(value); }, close: async () => { globalThis.savedBackup = new Blob(parts); parts = []; }, abort: async () => { parts = []; } };
    } });
  });
  const browserSession = await context.browser().newBrowserCDPSession();
  const targets = await browserSession.send('Target.getTargets');
  const target = targets.targetInfos.find(info => info.url === worker.url());
  const attached = await browserSession.send('Target.attachToTarget', { targetId: target.targetId });
  let serial = 0;
  const workerCommand = method => new Promise((resolve, reject) => {
    const id = ++serial;
    const receive = event => {
      if (event.sessionId !== attached.sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== id) return;
      browserSession.off('Target.receivedMessageFromTarget', receive);
      if (message.error) reject(Error(message.error.message)); else resolve(message.result);
    };
    browserSession.on('Target.receivedMessageFromTarget', receive);
    browserSession.send('Target.sendMessageToTarget', { sessionId: attached.sessionId, message: JSON.stringify({ id, method }) }).catch(reject);
  });
  const pageSession = await context.newCDPSession(page);
  const checkpoints = [];
  const maxima = { workerHeap: 0, workerBacking: 0, uiHeap: 0, uiBacking: 0 };
  const sample = async phase => {
    const worker = await workerCommand('Runtime.getHeapUsage'), ui = await pageSession.send('Runtime.getHeapUsage');
    maxima.workerHeap = Math.max(maxima.workerHeap, worker.usedSize); maxima.workerBacking = Math.max(maxima.workerBacking, worker.backingStorageSize);
    maxima.uiHeap = Math.max(maxima.uiHeap, ui.usedSize); maxima.uiBacking = Math.max(maxima.uiBacking, ui.backingStorageSize);
    if (phase) checkpoints.push({ phase, worker, ui });
  };
  const observeUntil = async operation => {
    let settled = false;
    const outcome = operation.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    while (!settled) { await sample(); await new Promise(resolve => setTimeout(resolve, 100)); }
    const result = await outcome; if (result.error) throw result.error; return result.value;
  };
  await sample('before-export');
  await page.locator('#manage-export').click();
  await observeUntil(page.waitForFunction(() => !document.querySelector('#manage-export').disabled, undefined, { timeout: 30000 }));
  checkpoint('exported');
  assert.match(await page.locator('#settings-backup-status').textContent(), /Export complete: 1 pages/);
  const bytes = await page.evaluate(() => globalThis.savedBackup.size);
  assert.ok(bytes > 120 * 1024 * 1024 && bytes < 128 * 1024 * 1024, 'The resource fixture must approach the named 128 MiB per-page backup policy');
  await sample('exported');
  await worker.evaluate(() => globalThis.backupContract.clear());
  assert.equal(await worker.evaluate(() => globalThis.backupContract.describe()), null);
  await page.evaluate(() => {
    const input = document.querySelector('#manage-import'), transfer = new DataTransfer();
    transfer.items.add(new File([globalThis.savedBackup], 'near-budget.jsonl'));
    input.files = transfer.files; input.dispatchEvent(new Event('change'));
  });
  await sample('preflight-start');
  await observeUntil(page.waitForFunction(() => !document.querySelector('#manage-import').disabled, undefined, { timeout: 30000 }));
  checkpoint('restored');
  assert.equal(await page.locator('#settings-backup-status').textContent(), 'Import complete: 1 pages');
  await sample('restored');
  assert.deepEqual(await worker.evaluate(() => globalThis.backupContract.describe()), before);
  const messages = await page.evaluate(() => globalThis.chromeMessages);
  assert.ok(messages.every(size => size < 64 * 1024 * 1024), 'No escaped Chrome JSON envelope may reach the documented message limit');
  await page.evaluate(() => { globalThis.savedBackup = undefined; });
  await worker.evaluate(() => globalThis.backupContract.clear());
  await sample('cleared');
  await workerCommand('HeapProfiler.collectGarbage'); await pageSession.send('HeapProfiler.collectGarbage');
  await sample('released-after-gc');
  testContext.diagnostic(JSON.stringify({ browser: context.browser().version(), snapshots: count, bytes, maxMessage: Math.max(...messages), maxima, checkpoints }));
  await browserSession.send('Target.detachFromTarget', { sessionId: attached.sessionId });
  await pageSession.detach(); await browserSession.detach();
});
