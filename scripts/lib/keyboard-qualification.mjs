import assert from 'node:assert/strict';
import { assertCapturedPage, withObservationDeadline } from './capture-qualification.mjs';
import { blockBenchmarkModels } from './recall-observer.mjs';
import { withQualificationWorker } from './sqlite-capture-qualification.mjs';

async function tabTo(page, target, key = 'Tab') {
  await target.waitFor();
  for (let attempt = 0; attempt < 32; attempt++) {
    if (await target.evaluate(node => node === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  assert.fail(`Could not reach ${await target.getAttribute('id') || await target.textContent()} using ${key}`);
}

export async function qualifyKeyboard({ openPanel, optionsPage, scenario, origin, rpc, entry }) {
  const url = `${origin}/${scenario.kind}/keyboard`;
  const source = await optionsPage.context().newPage();
  await source.goto(url);
  const panel = await openPanel();
  await optionsPage.close();
  await withQualificationWorker(panel, evaluate => withObservationDeadline(
    () => evaluate(blockBenchmarkModels, true), 'audit the model-free keyboard workflow'));
  const request = type => withObservationDeadline(() => rpc(panel, { type }), `keyboard qualification ${type}`);
  const settings = (await request('GET_SETTINGS')).settings;
  assert.equal(settings.paused, true);
  assert.equal(settings.automaticAi, false);
  assert.equal(settings.captureSetupComplete, false);
  const active = () => panel.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, text: document.activeElement?.textContent?.trim().slice(0, 80), className: document.activeElement?.className }));
  const capture = panel.locator('.wr-empty-memory').getByRole('button', { name: 'Capture current tab', exact: true });
  await tabTo(panel, panel.getByRole('button', { name: 'Manual only', exact: true }));
  await panel.keyboard.press('Enter');
  await panel.locator('#beta-capture-setup').waitFor({ state: 'hidden' });
  entry.afterManualChoice = await active();
  const manualFocus = await capture.evaluate(node => node === document.activeElement);
  await tabTo(panel, capture);
  await source.bringToFront();
  await panel.keyboard.press('Enter');
  await panel.getByRole('status').filter({ hasText: /^Page saved · text-searchable$/u }).waitFor();
  await panel.bringToFront();
  const trySearch = panel.getByRole('button', { name: 'Try a search', exact: true });
  await trySearch.waitFor();
  entry.afterSave = await active();
  const saveFocus = await trySearch.evaluate(node => node === document.activeElement);
  const saved = (await request('GET_ALL_PAGES')).pages;
  assert.equal(saved.length, 1);
  assertCapturedPage(saved[0], scenario, url);
  assert.ok(saved[0].chunks.every(chunk => !chunk.embedding.length));
  await source.close();
  await tabTo(panel, trySearch);
  await panel.keyboard.press('Enter');
  assert.equal((await active()).id, 'beta-search-input', 'The search guide moves keyboard focus into its input');
  await panel.keyboard.insertText(`"${scenario.phrase}"`);
  await panel.keyboard.press('Enter');
  const item = panel.locator('#beta-search-results > article').filter({ has: panel.locator(`details[data-url=${JSON.stringify(url)}]`) });
  const summary = item.locator(':scope > details > summary');
  await summary.waitFor();
  await panel.keyboard.press('ArrowDown');
  assert.ok(await summary.evaluate(node => node === document.activeElement), 'From Search, ArrowDown must focus the actual result');
  await panel.keyboard.press('Enter');
  const read = item.getByRole('button', { name: 'Read saved page', exact: true });
  await tabTo(panel, read);
  await panel.keyboard.press('Enter');
  const savedText = item.locator('.saved-reader-text');
  const match = savedText.locator('mark');
  await match.waitFor();
  entry.readerFocus = await active();
  assert.equal(await savedText.textContent(), saved[0].text);
  assert.equal(await match.textContent(), scenario.phrase);
  assert.ok(await match.evaluate(node => node === document.activeElement), 'Reading must move keyboard focus to the saved match');
  const captured = await panel.evaluate(timestamp => new Date(timestamp).toLocaleString(), saved[0].timestamp);
  assert.ok((await item.locator('.saved-reader-host > [role=status]').textContent()).includes(captured), 'Expose the durable capture time');
  await tabTo(panel, item.getByRole('button', { name: 'Back to preview', exact: true }), 'Shift+Tab');
  await panel.keyboard.press('Enter');
  assert.ok(await read.evaluate(node => node === document.activeElement), 'Back must return focus to the control that opened the reader');
  const current = (await request('GET_SETTINGS')).settings;
  assert.equal(current.captureSetupComplete, true);
  assert.equal(current.recallSetupComplete, true);
  assert.equal(current.automaticAi, false);
  const modelCalls = await withQualificationWorker(panel, evaluate => withObservationDeadline(
    () => evaluate(() => globalThis.benchmarkCalls), 'inspect model-free worker'));
  assert.ok(modelCalls, 'The worker observed throughout the keyboard workflow must retain its model-call counters');
  assert.deepEqual({ http: modelCalls.http, native: modelCalls.native, offscreen: modelCalls.offscreen, modelDispatches: modelCalls.modelDispatches },
    { http: [], native: 0, offscreen: 0, modelDispatches: [] });
  assert.ok(manualFocus && saveFocus, `Onboarding lost keyboard position: ${JSON.stringify({ afterManual: entry.afterManualChoice, afterSave: entry.afterSave })}`);
  return { savedPages: saved.length, usedKeys: true, sourceClosedBeforeRead: true, automaticAi: current.automaticAi, modelCalls };
}
