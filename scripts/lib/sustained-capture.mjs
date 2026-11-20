import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { durationSummary, fingerprint, requireRecoveryIdentity, withObservationDeadline } from './capture-qualification.mjs';
import { pageCommand, workerCommand } from './recall-cdp.mjs';
import { inspectSqliteAuthority, sqliteJobIdentities } from './sqlite-capture-qualification.mjs';

export const SUSTAINED_PHASE = 'sustained-capture-and-index-recovery';
const waveSize = 80;
export const SUSTAINED_COUNT = 3 * waveSize;
export const SUSTAINED_DIMENSIONS = 768;
const pageSizes = [4, 24, 64];
const fixtureSummary = 'This fixture describes saved evidence and recovery.';
const sampleIntervalMs = 125;
const stageDeadlineMs = 90000;
const readingText = text => text.replace(/^#+\s/u, '').replace(/\s+/gu, ' ');

export function sustainedFixture(index) {
  assert.ok(Number.isSafeInteger(index) && index >= 0 && index < SUSTAINED_COUNT, 'Unknown sustained page');
  const title = `Harbor field report ${index}`;
  const phrase = `unique harbor ledger ${index} quartz ribbon`;
  const sampleLine = 'Early morning tide readings showed steady movement past the wooden harbor marker. The observation was recorded before the crew returned.';
  const kib = pageSizes[index % pageSizes.length];
  const paragraphs = [`The reading for ${phrase} was recorded after sunrise.`];
  for (let line = 0; line < Math.ceil(kib * 1024 / sampleLine.length); line++) paragraphs.push(`Survey ${line + 1}. ${sampleLine}`);
  paragraphs.push(`End of the retained survey for harbor report ${index}.`);
  return {
    title, phrase, kib, normalizedText: [title, ...paragraphs].join(' '),
    html: `<!doctype html><meta charset="utf-8"><title>${title}</title><article><h1>${title}</h1>${paragraphs.map(line => `<p>${line}</p>`).join('')}</article>`
  };
}

export function assertSustainedProvider(requests, fixtures, expectations) {
  const byPhrase = new Map(fixtures.map(fixture => [fixture.phrase, { fixture, states: [] }]));
  for (const request of requests) {
    const first = request.body?.input?.[0];
    const phrase = typeof first === 'string' ? first.match(/unique harbor ledger \d+ quartz ribbon/u)?.[0] : undefined;
    const record = byPhrase.get(phrase);
    assert.ok(record, `Embedding request did not identify an authored sustained page: ${phrase}`);
    assert.ok(readingText(request.body.input.join(' ')) === record.fixture.normalizedText, `${phrase}: provider received incomplete or substituted text`);
    assert.deepEqual(request.body.input.map(fingerprint), record.fixture.chunkHashes, `${phrase}: provider changed the saved chunk boundaries`);
    record.states.push(request.state);
  }
  for (const [index, { fixture, states }] of [...byPhrase.values()].entries()) {
    assert.deepEqual(states, expectations(index), `${fixture.phrase}: missing, reordered, or duplicate provider transitions`);
  }
}

export function assertSustainedIndex(record, expected, key, indexed = true) {
  assert.equal(record.url, expected.url);
  assert.equal(record.title, expected.title);
  assert.equal(record.timestamp, expected.timestamp);
  assert.equal(record.versionId, requireRecoveryIdentity(expected.versionId, 'Sustained capture version ID'));
  assert.equal(record.manual, true);
  assert.equal((record.versions || []).length, 0, `${expected.url}: retry or recovery must not add history`);
  assert.equal(fingerprint(record.text), expected.textHash, `${expected.url}: saved text bytes changed`);
  assert.ok(record.chunks.length > 0, `${expected.url}: saved chunks missing`);
  assert.equal(record.chunks.map(chunk => chunk.text).join(' '), record.text.replace(/\s+/gu, ' '), `${expected.url}: chunks differ from the complete saved text`);
  for (const [index, chunk] of record.chunks.entries()) {
    assert.equal(chunk.embedding.length, indexed ? SUSTAINED_DIMENSIONS : 0, `${expected.url} chunk ${index}: incorrect vector dimensions`);
    if (indexed) assert.ok(chunk.embedding[0] === (expected.index + 1) / 256 && chunk.embedding[1] === (index + 1) / 256 && chunk.embedding.slice(2).every((value, dimension) => value === (1 + (dimension % 256)) / 256), `${expected.url} chunk ${index}: incorrect vector association`);
    assert.equal(chunk.embeddingKey, indexed ? key : undefined, `${expected.url} chunk ${index}: incorrect embedding space`);
  }
  if (indexed) assert.ok(Number.isFinite(record.lastEmbeddedAt));
}

async function waitForStage(check, label) {
  const deadline = performance.now() + stageDeadlineMs;
  while (performance.now() < deadline) {
    const observed = await withObservationDeadline(check, label, Math.max(1, deadline - performance.now()));
    if (observed) return observed;
    await delay(150);
  }
  throw Error(`Sustained qualification observation expired: ${label}`);
}

async function observeHeap(page, operation, collection) {
  const context = page.context(), browser = context.browser();
  const browserSession = await withObservationDeadline(() => browser.newBrowserCDPSession(), 'browser measurement session');
  let pageSession;
  let sessionId;
  try {
    pageSession = await withObservationDeadline(() => context.newCDPSession(page), 'sidepanel measurement session');
    const host = new URL(page.url()).host;
    const { targetInfos } = await withObservationDeadline(() => browserSession.send('Target.getTargets'), 'worker measurement target');
    const target = targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith('chrome-extension:') && new URL(info.url).host === host);
    assert.ok(target, 'Heap measurement requires the extension worker target');
    ({ sessionId } = await withObservationDeadline(() => browserSession.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }), 'attach to worker measurement target'));
    const startedAt = performance.now();
    async function sample() {
      const [worker, ui] = await Promise.all([workerCommand(browserSession, browser, sessionId, 'Runtime.getHeapUsage'), pageCommand(pageSession, browser, 'Runtime.getHeapUsage')]);
      const fields = [worker.usedSize, worker.backingStorageSize, ui.usedSize, ui.backingStorageSize];
      assert.ok(fields.every(value => Number.isFinite(value) && value >= 0), 'Heap samples must include both targets and their backing storage');
      collection.push({ offsetMs: performance.now() - startedAt, workerBytes: worker.usedSize + worker.backingStorageSize, panelBytes: ui.usedSize + ui.backingStorageSize });
    }
    await sample();
    let settled = false;
    const running = withObservationDeadline(operation, 'stage operation', stageDeadlineMs).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    let samplerError;
    while (!settled) {
      await delay(sampleIntervalMs);
      if (!settled) try { await sample(); } catch (error) { samplerError = error; break; }
    }
    const result = await running;
    if (result.error) throw result.error;
    if (samplerError) throw samplerError;
    await sample();
    return result.value;
  } finally {
    if (sessionId) await withObservationDeadline(() => browserSession.send('Target.detachFromTarget', { sessionId }), 'detach worker measurement', 2000).catch(() => {});
    if (pageSession) await withObservationDeadline(() => pageSession.detach(), 'detach sidepanel measurement', 2000).catch(() => {});
    await withObservationDeadline(() => browserSession.detach(), 'detach browser measurement', 2000).catch(() => {});
  }
}

export async function qualifySustained({ open, openPanel, crash, directory, origin, rpc: send, provider, entry }) {
  const rpc = (page, message) => withObservationDeadline(() => send(page, message), message.type);
  const profile = path.join(directory, 'sustained-capture');
  let page = await open(profile);
  assert.deepEqual((await rpc(page, { type: 'GET_PAGE_LIST' })).pages, []);
  await rpc(page, { type: 'SET_EMBEDDING_CONFIG', payload: { provider: 'ollama', baseUrl: origin, model: 'qualification-vector' } });
  await rpc(page, { type: 'SET_PROVIDER_SETTING', providerId: 'ollama', key: 'baseUrl', value: origin });
  await rpc(page, { type: 'SET_MODEL', key: 'chatModel', value: 'qualification-chat' });
  await rpc(page, { type: 'SET_SETTINGS', payload: { automaticAi: true, activeProviderId: 'ollama', paused: true, captureSetupComplete: true, recallSetupComplete: true, queryRewrite: false, searchRerank: false, logLevel: 'error' } });
  let panel, source;
  async function resetTabs() {
    panel = await openPanel();
    await page.close();
    source = await panel.context().newPage();
  }
  await resetTabs();
  entry.samples = [];
  entry.stages = [];
  const all = entry.samples;
  const lookup = () => sqliteJobIdentities(panel);
  const pending = async () => (await rpc(panel, { type: 'GET_PROCESSING' })).queue.length;
  const key = JSON.stringify(['ollama', origin, 'qualification-vector']);
  const embeddingRequests = () => provider.requests.filter(request => request.phase === SUSTAINED_PHASE && request.path === '/api/embed');

  async function search(expected) {
    const query = `"${expected.phrase}"`;
    const result = await rpc(panel, { type: 'SEARCH_QUERY', query, requestId: crypto.randomUUID() });
    const match = result.results.find(record => record.url === expected.url);
    assert.ok(match, `${expected.url}: acknowledged text must be searchable before indexed vectors`);
    return { query, match };
  }

  async function admit(start, end) {
    for (let index = start; index < end; index++) {
      const fixture = sustainedFixture(index), url = `${origin}/sustained/${index}`;
      await source.goto(url);
      await source.bringToFront();
      const started = performance.now(), earliestTimestamp = Date.now();
      const viaPanel = index === start;
      if (viaPanel) {
        await withObservationDeadline(() => panel.locator('#beta-capture-now').evaluate(button => {
          const status = document.querySelector('#beta-search-status');
          const changes = globalThis.qualificationCaptureFeedback = [];
          const observe = () => {
            if (changes.length < 30) changes.push({ text: status.textContent, visible: status.getClientRects().length > 0 });
          };
          const observer = new MutationObserver(observe);
          observer.observe(status, { subtree: true, childList: true, characterData: true });
          globalThis.qualificationStopCaptureFeedback = () => { observer.disconnect(); return changes; };
          button.click();
          observe();
        }), 'invoke the packaged capture handler');
        try {
          await panel.locator('#beta-search-status').filter({ hasText: /^Page saved · text-searchable$/u }).waitFor();
        } finally {
          (entry.captureFeedback ||= []).push({ index, transitions: await withObservationDeadline(() => panel.evaluate(() => globalThis.qualificationStopCaptureFeedback()), 'capture feedback evidence') });
        }
      } else {
        const ack = await rpc(panel, { type: 'CAPTURE_ACTIVE_TAB' });
        assert.equal(ack.ok, true); assert.equal(ack.received, true);
      }
      const acknowledgedMs = performance.now() - started, latestTimestamp = Date.now();
      const { query, match } = await search({ url, phrase: fixture.phrase });
      const confirmedSearchableMs = performance.now() - started;
      const { page: saved } = await rpc(panel, { type: 'GET_SAVED_PAGE', url, query, versionId: match.versionId });
      assert.equal(saved.title, fixture.title);
      assert.ok(saved.timestamp >= earliestTimestamp && saved.timestamp <= latestTimestamp, `${url}: captured timestamp is outside the acknowledged save window`);
      assert.ok(readingText(saved.text) === fixture.normalizedText, `${url}: actual content extraction omitted or substituted text`);
      all.push({ index, url, title: saved.title, phrase: fixture.phrase, nominalKiB: fixture.kib, viaPanel, timestamp: saved.timestamp, versionId: requireRecoveryIdentity(saved.versionId, 'Acknowledged version ID'), textHash: fingerprint(saved.text), textBytes: Buffer.byteLength(saved.text), acknowledgedMs, confirmedSearchableMs });
    }
  }

  async function measureStage(name, operation) {
    const heap = [], start = performance.now();
    const stage = { name, initialCount: all.length };
    entry.stages.push(stage);
    try { Object.assign(stage, await observeHeap(panel, operation, heap)); }
    finally {
      stage.elapsedMs = performance.now() - start;
      stage.sampledWorkerPlusSidepanel = { observations: heap.length, intervalMs: sampleIntervalMs, maxBytes: heap.length ? Math.max(...heap.map(sample => sample.workerBytes + sample.panelBytes)) : null, samples: heap };
      Object.assign(stage, { capturesAcknowledged: all.length - stage.initialCount, storage: await withObservationDeadline(() => panel.evaluate(() => navigator.storage.estimate()), 'stage storage estimate').catch(() => null) });
    }
    assert.ok(Number.isFinite(stage.storage?.usage), `${name}: missing origin usage`);
    console.info(`  ${name}: completed`);
  }
  function assertLibrary(records, expected) {
    assert.equal(records.length, expected.length, 'The library must contain every acknowledged save exactly once');
    const byUrl = new Map(records.map(record => [record.url, record]));
    assert.equal(byUrl.size, records.length);
    for (const capture of expected) {
      const record = byUrl.get(capture.url);
      assert.ok(record, `Missing acknowledged saved report: ${capture.url}`);
      assertSustainedIndex(record, capture, key);
    }
  }

  async function assertStoredLibrary(expected, from = 0, indexed = true) {
    const { pages: count } = await inspectSqliteAuthority(panel);
    assert.equal(count, expected.length, 'The library must contain every acknowledged save exactly once');
    for (const capture of expected.slice(from)) {
      const record = await inspectSqliteAuthority(panel, { op: 'read', url: capture.url });
      assert.ok(record, `Missing acknowledged saved report: ${capture.url}`);
      assertSustainedIndex(record, capture, key, indexed);
    }
  }

  provider.setMode('ready');
  await measureStage('browse-and-index', async () => {
    const started = performance.now();
    await admit(0, waveSize);
    const captureMs = performance.now() - started;
    await waitForStage(async () => !(await pending()), 'initial synthetic indexing queue to drain');
    return { captureMs, indexed: waveSize, indexedPerSecondIncludingBrowsing: waveSize * 1000 / (performance.now() - started) };
  });
  await assertStoredLibrary(all);

  provider.setMode('hold');
  let heldJobs;
  await measureStage('browse-with-held-indexing', async () => {
    await admit(waveSize, 2 * waveSize);
    const held = await waitForStage(() => embeddingRequests().find(request => request.state === 'held'), 'active embedding request before interruption');
    assert.ok(held.body.input[0].includes(sustainedFixture(waveSize).phrase));
    const jobs = await lookup();
    assert.equal(jobs.length, waveSize);
    assert.ok(jobs.every(job => job.textSaved === true && ['queued', 'processing'].includes(job.status)), 'Every acknowledged delayed capture must be recoverable');
    heldJobs = new Map(jobs.map(job => [job.url, requireRecoveryIdentity(job.captureId, 'Persisted capture admission ID')]));
    assert.deepEqual([...heldJobs.keys()].sort(), all.slice(waveSize).map(capture => capture.url).sort());
    return { queueDepthBeforeCrash: jobs.length };
  });
  const interrupted = embeddingRequests().find(request => request.state === 'held');
  const recoveredAt = performance.now();
  entry.crash = await crash();
  await waitForStage(() => interrupted.state === 'disconnected', 'interrupted HTTP request to disconnect');
  page = await open(profile, { requireInstalled: true });
  await resetTabs();
  await measureStage('recover-held-indexing', async () => {
    await waitForStage(() => embeddingRequests().some(request => request.state === 'held'), 'recovered active indexing request');
    const jobs = await lookup();
    assert.equal(jobs.length, waveSize);
    for (const job of jobs) {
      assert.equal(requireRecoveryIdentity(job.captureId, 'Recovered admission ID'), heldJobs.get(job.url), `${job.url}: recovered admission was replaced`);
    }
    await panel.locator('#beta-queue-label').filter({ hasText: /^80 saved pages · indexing$/u }).waitFor();
    provider.setMode('ready');
    provider.release();
    await waitForStage(async () => !(await pending()), 'interrupted queued indexing to drain');
    const recoveredMs = performance.now() - recoveredAt;
    return { recovered: waveSize, recoveredMs, recoveredPerSecondIncludingRestart: waveSize * 1000 / recoveredMs };
  });
  await assertStoredLibrary(all);

  const failedLabel = panel.locator('#beta-queue-label').filter({ hasText: /^80 saved pages · 80 indexing failed$/u });
  provider.setMode('fail');
  await measureStage('browse-through-provider-errors', async () => {
    await admit(2 * waveSize, SUSTAINED_COUNT);
    await failedLabel.waitFor();
  });
  const failed = await lookup();
  assert.deepEqual(failed.map(job => job.url).sort(), all.slice(2 * waveSize).map(capture => capture.url).sort());
  assert.ok(failed.every(job => job.status === 'failed' && job.textSaved === true && job.error?.includes(provider.failure)));
  entry.stages.at(-1).failedSavedJobs = failed.length;
  await assertStoredLibrary(all, 2 * waveSize, false);

  provider.setMode('ready');
  await measureStage('retry-failed-indexing', async () => {
    const start = performance.now();
    await failedLabel.click();
    await panel.locator('#beta-capture-status li').filter({ hasText: provider.failure }).first().waitFor();
    await panel.getByRole('button', { name: 'Retry failed', exact: true }).click();
    await panel.locator('#beta-search-status').filter({ hasText: /^Retry requested$/u }).waitFor();
    await waitForStage(async () => !(await pending()), 'explicit indexing retries to drain');
    const retryMs = performance.now() - start;
    return { retried: waveSize, retryMs, retriedPerSecond: waveSize * 1000 / retryMs };
  });
  await waitForStage(async () => {
    const { pages } = await rpc(panel, { type: 'GET_PAGE_LIST' });
    return pages.length === all.length && pages.every(page => page.hasSummary);
  }, 'synthetic summaries to finish');
  const final = (await rpc(panel, { type: 'GET_ALL_PAGES' })).pages;
  assertLibrary(final, all);
  assert.ok(final.every(record => record.summary === fixtureSummary));
  const requests = embeddingRequests();
  assert.equal(requests.length, 4 * waveSize + 1, 'No duplicate or missing indexing request beyond the explicit retry and interrupted request');
  assert.equal(requests.filter(request => request.state === 'completed').length, 3 * waveSize);
  assert.equal(requests.filter(request => request.state === 'failed').length, waveSize);
  assert.equal(requests.filter(request => request.state === 'disconnected').length, 1);
  const byUrl = new Map(final.map(record => [record.url, record]));
  assertSustainedProvider(requests, all.map(capture => ({ ...sustainedFixture(capture.index), chunkHashes: byUrl.get(capture.url).chunks.map(chunk => fingerprint(chunk.text)) })), index => index === waveSize ? ['disconnected', 'completed'] : index >= 2 * waveSize ? ['failed', 'completed'] : ['completed']);
  const rpcSamples = all.filter(sample => !sample.viaPanel);
  const finalStorage = await withObservationDeadline(() => panel.evaluate(() => navigator.storage.estimate()), 'final storage estimate');
  assert.ok(Number.isFinite(finalStorage.usage), 'Final origin usage is required');
  return { captures: all.length, uiCaptures: all.length - rpcSamples.length, textBytes: all.reduce((sum, sample) => sum + sample.textBytes, 0), acknowledgment: durationSummary(rpcSamples.map(sample => sample.acknowledgedMs)), confirmedSearchable: durationSummary(rpcSamples.map(sample => sample.confirmedSearchableMs)), finalStorage };
}
