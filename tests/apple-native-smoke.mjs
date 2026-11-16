import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

if (!process.argv.includes('--allow-local-inference')) throw new Error('This advisory check runs Apple inference on sample data. Pass --allow-local-inference to proceed.');
if (process.platform !== 'darwin') throw new Error('This advisory check requires macOS and a ready Apple on-device model.');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-recall-apple-smoke-'));
const runtimeState = await fs.mkdtemp('/private/tmp/wr-apple-');
const app = path.join(temporary, 'Web Recall.app');
const binary = path.join(app, 'Contents/MacOS/web-recall-apple');
const hostPath = path.join(temporary, 'profile/NativeMessagingHosts/com.webrecall.apple.json');
let context, registration, companion;

async function cleanup() {
  await context?.close(); context = undefined;
  if (companion && companion.exitCode === null && companion.signalCode === null) {
    companion.kill('SIGTERM');
    await new Promise(resolve => companion.once('exit', resolve));
  }
  if (registration && await fs.readFile(hostPath, 'utf8').catch(() => '') === registration) await fs.unlink(hostPath);
  registration = undefined;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(runtimeState, { recursive: true, force: true });
}

process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
try {
  await fs.cp(path.join(root, 'dist/apple/Web Recall.app'), app, { recursive: true });
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :WebRecallStateDirectory string ${runtimeState}`, path.join(app, 'Contents/Info.plist')]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  companion = spawn(path.join(app, 'Contents/MacOS/WebRecallCompanion'), [], { stdio: 'ignore' });
  const startupDeadline = Date.now() + 15_000;
  while (!(await fs.stat(path.join(runtimeState, 'companion.sock')).catch(() => null))) {
    if (companion.exitCode !== null || companion.signalCode !== null || Date.now() > startupDeadline) throw new Error('The isolated companion did not start.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const extension = path.join(temporary, 'extension');
  await fs.mkdir(extension);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  manifest.permissions.push('nativeMessaging');
  delete manifest.optional_permissions;
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  await fs.cp(path.join(root, 'dist/beta'), path.join(extension, 'dist/beta'), { recursive: true });
  context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.sampleNativeEvents = [];
    const connect = chrome.runtime.connectNative.bind(chrome.runtime);
    chrome.runtime.connectNative = host => {
      const port = connect(host);
      port.onMessage.addListener(event => { globalThis.sampleNativeEvents.push(event); });
      return port;
    };
  });
  const extensionId = new URL(worker.url()).hostname;
  const host = { name: 'com.webrecall.apple', description: 'Temporary Web Recall sample-only verification', path: binary, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
  await fs.mkdir(path.dirname(hostPath), { recursive: true });
  const candidate = JSON.stringify(host, null, 2) + '\n';
  await fs.writeFile(hostPath, candidate, { flag: 'wx', mode: 0o600 });
  registration = candidate;
  const page = await context.newPage();
  await page.exposeFunction('sampleReport', message => console.log('Sample scenario:', message));
  await page.goto(`chrome-extension://${extensionId}/dist/beta/ui/sidepanel/index.html`);
  const seeded = await page.evaluate(async () => {
    const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
    const replies = [];
    replies.push(await send({ type: 'SET_SETTINGS', payload: { paused: true, captureSetupComplete: true, activeProviderId: 'apple', queryRewrite: false, searchRerank: false, askRerank: false, enableTools: false, answerMode: 'detailed' } }));
    replies.push(await send({ type: 'SET_EMBEDDING_CONFIG', payload: { provider: 'browser' } }));
    const text = 'The launch date is May 19. Preparations include a staging rehearsal, a backup verification, an accessibility check, documentation review, and a final release approval. All five steps must finish before the launch.';
    replies.push(await send({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [{ url: 'https://example.test/launch', title: 'Sample release plan', text, timestamp: 1, manual: true, chunks: [{ text, embedding: [] }] }] }));
    return replies;
  });
  for (const reply of seeded) assert(!reply.error, reply.error);
  if (process.argv.includes('--summary-only')) {
    const result = await page.evaluate(async () => {
      const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
      const url = 'https://example.test/web-recall';
      const text = [
        'Web Recall is a local-first Chrome extension for remembering visited pages. It captures readable page text and stores it in the browser.',
        'People can find saved articles with text and semantic search, then ask questions grounded in their saved pages. Answers cite the original captured passages.',
        'Embeddings can run in the browser or through a local provider. Capture choices and site exclusions let people control what gets remembered.',
        'The Memory Manager supports backup export and import. '.repeat(15),
        'Streaming backups have a schemaVersion 2 header and an end footer. Records are limited to 16 MiB. Legacy JSON imports have a 10 MiB limit and support up to 2000 pages. '.repeat(12),
        'These maintenance tools support the main goal: privately recalling and understanding previously visited pages without relying on a cloud browsing-history service.'
      ].join('\n\n');
      const imported = await send({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [{ url, title: 'Web Recall: local-first browser memory, search and Ask', text, summary: 'Backup records are limited to 16 MiB.', timestamp: 2, manual: true, chunks: [{ text, embedding: [1, 0], embeddingKey: 'sample' }] }] });
      if (imported.error) throw new Error(imported.error);
      const regenerated = await send({ type: 'REGENERATE_PAGE_SUMMARY', requestId: 'sample-summary', url });
      if (regenerated.error) throw new Error(regenerated.error);
      return { regenerated, preview: await send({ type: 'GET_PAGE_PREVIEW', url }) };
    });
    assert.equal(result.regenerated.updated, true, JSON.stringify(result));
    const summary = result.preview.page.snippet;
    assert.match(summary, /Web Recall|extension/i);
    assert.match(summary, /search|find|recall|remember/i);
    assert.match(summary, /local|browser|privat/i);
    console.log('Real Apple whole-page summary:', summary);
  } else {
  await page.reload();
  await page.locator('#beta-recents-list summary').first().click();
  await page.locator('.ask-this-page').first().click();
  await page.locator('#beta-ask-input').fill('When is the launch? Cite the saved source.');
  await page.locator('#beta-ask-submit').click();
  await page.waitForFunction(() => document.querySelector('#beta-ask-status')?.dataset.state === 'ready' || document.querySelector('#beta-ask-status')?.dataset.variant === 'error', undefined, { timeout: 0 });
  const status = await page.locator('#beta-ask-status').textContent();
  const nativeEvents = await worker.evaluate(() => globalThis.sampleNativeEvents.filter(event => ['done', 'error'].includes(event.type)));
  assert.match(status, /Answer ready/, JSON.stringify({ status, sampleNativeEvents: nativeEvents }));
  const answer = await page.locator('#beta-ask-answer').textContent();
  assert.match(answer, /May\s+19/);
  const citation = page.locator('#beta-ask-answer a[href="#ask-source-1"]');
  assert(await citation.count() > 0, 'a real answer must link to the saved source');
  await citation.first().click();
  assert.match(await page.locator('#ask-source-1').textContent(), /May 19/);
  const original = page.locator('#ask-source-1 a.original-link');
  assert.equal(await original.getAttribute('href'), 'https://example.test/launch');
  console.log('Real native Ask and saved-source navigation passed:', answer);
  await page.locator('#beta-ask-input').fill('Which preparations must finish before that? Cite the plan.');
  await page.locator('#beta-ask-submit').click();
  assert.equal(await page.locator('#beta-ask-input').inputValue(), '', 'sending clears the composer before inference finishes');
  assert.match(await page.locator('#beta-ask-history').textContent(), /When is the launch/);
  assert(await page.locator('#beta-ask-history > details').first().evaluate(element => element.open));
  await page.waitForFunction(() => ['ready', 'insufficient_evidence', 'failed'].includes(document.querySelector('#beta-ask-status')?.dataset.state), undefined, { timeout: 0 });
  assert.equal(await page.locator('#beta-ask-status').getAttribute('data-state'), 'ready', await page.locator('#beta-ask-status').textContent());
  assert.match(await page.locator('#beta-ask-answer').textContent(), /backup/i);
  assert.match(await page.locator('#beta-ask-answer').textContent(), /accessibility/i);
  console.log('Real native follow-up context and visible conversation passed.');
  const artifacts = await fs.mkdtemp(path.join(root, 'output/agent-chat-'));
  for (const width of [760, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(artifacts, `conversation-${width}.png`), fullPage: true, animations: 'disabled' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the chat must not overflow horizontally');
  }
  console.log('Conversation UI captures:', artifacts);
  await page.locator('#beta-ask-input').fill('What is the launch budget in dollars? If it is not in the saved plan, explain that.');
  await page.locator('#beta-ask-submit').click();
  await page.waitForFunction(() => ['ready', 'insufficient_evidence', 'failed'].includes(document.querySelector('#beta-ask-status')?.dataset.state), undefined, { timeout: 0 });
  assert.equal(await page.locator('#beta-ask-status').getAttribute('data-state'), 'insufficient_evidence', await page.locator('#beta-ask-status').textContent());
  for (const href of await page.locator('#beta-ask-answer a').evaluateAll(links => links.map(link => link.getAttribute('href')))) assert.equal(href, '#ask-source-1', 'optional citations must still point to the actual saved plan');
  console.log('Real native insufficient-evidence response passed without an invented reference.');
  await page.evaluate(() => {
    globalThis.stopSampleStream = message => {
      if (message.type !== 'ASK_ANSWER_UPDATE' || !message.chunk) return;
      chrome.runtime.onMessage.removeListener(globalThis.stopSampleStream);
      document.querySelector('#beta-ask-stop').click();
    };
    chrome.runtime.onMessage.addListener(globalThis.stopSampleStream);
  });
  await page.locator('#beta-ask-input').fill('Explain all five preparation steps at length, with several paragraphs discussing each step and citations to the saved plan.');
  await page.locator('#beta-ask-submit').click();
  await page.waitForFunction(() => /Stopped/.test(document.querySelector('#beta-ask-status')?.textContent) || document.querySelector('#beta-ask-status')?.dataset.variant === 'error', undefined, { timeout: 0 });
  assert.match(await page.locator('#beta-ask-status').textContent(), /Stopped/);
  const stopped = await page.locator('#beta-ask-answer').textContent();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#beta-ask-answer').textContent(), stopped, 'late native output must not replace the stopped draft');
  assert(await page.locator('#beta-ask-stop').isHidden());
  console.log('Real native streaming Stop passed. No PCC inference or user profile was used.');
  const scenarios = await page.evaluate(async () => {
    const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
    const events = [], listener = message => {
      if (['ASK_RUN_STATE', 'ASK_TOOL_ACTIVITY'].includes(message.type)) events.push(message);
      if (message.requestId === 'sample-tools' && message.type === 'ASK_TOOL_ACTIVITY' && message.event.status !== 'started') void globalThis.sampleReport(`${message.event.tool}: ${message.event.status}`);
    };
    chrome.runtime.onMessage.addListener(listener);
    try {
      const url = 'https://example.test/launch';
      const history = [{ question: 'We are discussing the saved release plan. What did we establish?', answer: 'The launch date is May 19 [1]. ' + 'Earlier discussion concerned this release plan and its preparation steps. '.repeat(180) }];
      const compacted = await send({ type: 'ASK_QUESTION', question: 'What launch date did we discuss? Verify it from the saved plan.', options: { requestId: 'sample-compaction', scopeUrls: [url], history } });
      await globalThis.sampleReport(`Conversation compaction: ${compacted.outcome || compacted.error}`);
      if (compacted.error) throw new Error(compacted.error);
      const revised = 'The launch date is May 20. This revised plan describes the same launch as the earlier saved plan.';
      const long = 'Background about staged release procedures. '.repeat(120) + '\nThe rollout code is MAPLE-42. Keep this exact code for the sample release.\n';
      const imported = await send({ type: 'IMPORT_PAGES', schemaVersion: 1, pages: [
        { url: 'https://example.test/revised', title: 'Revised release plan', timestamp: 2, text: revised, chunks: [{ text: revised, embedding: [] }] },
        { url: 'https://example.test/long', title: 'Detailed release procedures', timestamp: 3, text: long, chunks: [{ text: long, embedding: [] }] }
      ] });
      if (imported.error) throw new Error(imported.error);
      const conflict = await send({ type: 'ASK_QUESTION', question: 'How consistent are the launch dates in these two saved plans? Report both dates if they disagree.', options: { requestId: 'sample-conflict', scopeUrls: [url, 'https://example.test/revised'] } });
      await globalThis.sampleReport(`Conflicting sources: ${conflict.outcome || conflict.error}`);
      if (conflict.error) throw new Error(conflict.error);
      await send({ type: 'SET_SETTINGS', payload: { enableTools: true, maxToolSteps: 0 } });
      const tools = await send({ type: 'ASK_QUESTION', question: 'What is the rollout code later in this saved page? Use the saved-memory tools to find it, do not guess.', options: { requestId: 'sample-tools', scopeUrls: ['https://example.test/long'], useSearch: false } });
      await globalThis.sampleReport(`Native tools: ${tools.outcome || tools.error}`);
      return { compacted, conflict, tools, events };
    } finally { chrome.runtime.onMessage.removeListener(listener); }
  });
  assert.equal(scenarios.compacted.outcome, 'answered', JSON.stringify(scenarios.compacted));
  assert.match(scenarios.compacted.answer, /May\s+19/);
  assert(scenarios.compacted.conversation.summary.length > 0);
  assert(scenarios.events.some(event => event.requestId === 'sample-compaction' && event.event.phase === 'compacting'));
  console.log('Real native conversation compaction preserved the subject and saved-source support.');
  assert.equal(scenarios.conflict.outcome, 'answered', JSON.stringify(scenarios.conflict));
  assert.match(scenarios.conflict.answer, /May\s+19/); assert.match(scenarios.conflict.answer, /May\s+20/);
  assert.equal(scenarios.conflict.sources.length, 2, 'conflicting claims must retain both saved sources');
  console.log('Real native conflicting-source answer retained both dates and their references.');
  assert.equal(scenarios.tools.outcome, 'answered', JSON.stringify(scenarios.tools));
  assert.match(scenarios.tools.answer, /MAPLE-42/);
  assert.equal(scenarios.tools.sources[0].url, 'https://example.test/long');
  assert(scenarios.events.some(event => event.requestId === 'sample-tools' && event.type === 'ASK_TOOL_ACTIVITY' && event.event.status === 'completed'));
  console.log('Real native saved-memory tools found and cited evidence outside the initial preview.');
  companion.kill('SIGTERM');
  await new Promise(resolve => companion.once('exit', resolve));
  const unavailable = await page.evaluate(() => new Promise(resolve => chrome.runtime.sendMessage({ type: 'PROVIDER_ACTION', providerId: 'apple', action: 'test' }, resolve)));
  assert.equal(unavailable.status.online, false);
  assert.match(unavailable.status.lastError, /Open the Web Recall companion/);
  assert.notEqual(companion.signalCode, null, 'the bridge must not silently restart a stopped companion');
  console.log('Stopped companion reports unavailable without automatically relaunching.');
  }
} finally { await cleanup(); }
