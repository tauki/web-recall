import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrary, CORPUS_VERSION } from '../tests/fixtures/recall-library.mjs';
import { evaluateFinding, evaluationSchedule, summarizeObservations, latencySummary, verifyPassage, resourceSummary, validateEvaluationSources } from './lib/recall-evaluation.mjs';
import { installRecallObserver, blockBenchmarkModels, observeSavedReader } from './lib/recall-observer.mjs';
import { flatCdp } from './lib/recall-cdp.mjs';
import { stageRecallPackage } from './lib/recall-package.mjs';
import { withObservationDeadline } from './lib/capture-qualification.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
const acceptance = args.includes('--acceptance'), pilot = args.includes('--pilot');
const profiling = args.includes('--profile');
const candidateArg = args.find(value => value.startsWith('--candidate='))?.slice('--candidate='.length);
if (!candidateArg) throw Error('Select the exact ZIP with --candidate=<file>.');
const candidate = path.resolve(candidateArg);
if (acceptance && pilot) throw Error('A pilot cannot be an acceptance run.');
if (profiling && !pilot) throw Error('CPU profiling is diagnostic; use --pilot.');
const sizesArg = args.find(value => value.startsWith('--sizes='));
const sizes = sizesArg ? sizesArg.slice(8).split(',').map(Number) : [1000, 10000];
if (!sizes.length || new Set(sizes).size !== sizes.length || sizes.some(value => ![1000, 10000].includes(value))) throw Error('Use the declared 1000- and 10000-page workloads without duplicates.');
if (acceptance && (sizes.length !== 2 || !sizes.includes(1000) || !sizes.includes(10000))) throw Error('Acceptance requires both reference libraries.');
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const topics = await readJson('tests/fixtures/recall-topics.json');
const development = (await readJson('tests/fixtures/recall-development.json')).map(value => ({ ...value, split: 'development' }));
const sourceFiles = execFileSync('rg', ['--files', 'src'], { encoding: 'utf8' }).trim().split('\n').sort();
const heldoutFixture = 'tests/fixtures/recall-heldout-v3.json';
const provenanceFiles = [...sourceFiles, 'manifest.json', 'package.json', 'pnpm-lock.yaml', 'scripts/recall-benchmark.mjs', 'scripts/lib/capture-qualification.mjs', ...['evaluation', 'observer', 'cdp', 'package'].map(name => 'scripts/lib/recall-' + name + '.mjs'), ...['topics.json', 'library.mjs', 'development.json', 'heldout.json', 'heldout-v2.json'].map(name => 'tests/fixtures/recall-' + name), heldoutFixture];
const provenance = Object.fromEntries(await Promise.all(provenanceFiles.map(async filename => [filename, hash(await readFile(filename))])));
const report = {
  protocol: 'everyday-recall-v4-packaged-sqlite', corpus: CORPUS_VERSION, heldoutFixture, startedAt: new Date().toISOString(), candidate: { path: candidate },
  mode: pilot ? 'development-pilot' : acceptance ? 'acceptance' : 'development',
  limitations: ['Authored synthetic corpus; not observed-user acceptance or universal capacity evidence.', 'Browser-cold, OS-cache-uncontrolled; no disk-cache purge.', 'Warm heap observations sum distinct JS isolates across each search-and-reader verification window, not exclusively during query execution. These samples are not process RSS, a native/Wasm memory census, or an OS peak.', 'Loads unmodified ZIP bytes in isolated profiles. Worker provider traps attach after startup, before any benchmark activity. The browser observer and corpus seeder are test-only.'],
  hardware: { platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version, timezone: 'UTC' },
  provenance, sourceDigest: hash(JSON.stringify(provenance)),
  git: { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), status: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }) },
  targets: { topFive: 0.9, exact: 1, warmP95Ms: 500, coldP95Ms: 2000, resources: { storageBytes: 512 * 1024 * 1024, activeSampleBytes: 256 * 1024 * 1024, idleBytes: 32 * 1024 * 1024 } }, libraries: []
};
const heldout = acceptance ? (await readJson(heldoutFixture)).map(value => ({ ...value, split: 'heldout' })) : [];
report.schedule = evaluationSchedule(development, heldout, acceptance);
const scenarios = [...(pilot ? development.filter((_value, index) => index % 4 === 0) : development), ...heldout];
const reportDirectory = path.join(root, 'output/benchmarks');
await mkdir(reportDirectory, { recursive: true });
const output = path.join(reportDirectory, `${report.startedAt.replace(/[:.]/gu, '-')}-${report.mode}.json`);
await writeFile(output, '', { flag: 'wx' });
let context;
let directory;
let packaged;
let extensionOrigin;
let interrupted = false;
async function closeBrowser() {
  if (!context) return;
  const opened = context, browser = opened.browser();
  await opened.close();
  if (browser?.isConnected() !== false) throw Error('Cannot confirm the disposable benchmark browser closed.');
  if (context === opened) context = null;
}
const interrupt = () => { interrupted = true; void closeBrowser().catch(() => {}); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

const workerFixture = `
  import { LIBRARY_PORT, requestLibraryFrames } from ${JSON.stringify(path.join(root, 'src/shared/libraryTransfer.ts'))};
  import { buildLibrary } from ${JSON.stringify(path.join(root, 'tests/fixtures/recall-library.mjs'))};
  import topics from ${JSON.stringify(path.join(root, 'tests/fixtures/recall-topics.json'))};
  const encoder = new TextEncoder(), expected = new Map();
  let authorityId;
  const snapshot = version => [version.versionId, version.title, version.text, version.timestamp, version.firstCapturedAt, version.manual,
    version.kept, version.summary, version.chunks.map(chunk => [chunk.text, chunk.embedding, chunk.embeddingKey])];
  const digest = async page => new Uint8Array(await crypto.subtle.digest('SHA-256',
    encoder.encode(JSON.stringify([page.url, snapshot(page), (page.versions || []).map(snapshot)])))).toHex();
  const call = async (action) => {
    const response = await requestLibraryFrames(chrome.runtime.connect({ name: LIBRARY_PORT }), { kind: 'operate', id: authorityId, action });
    if (!Object.hasOwn(response, 'value')) throw Error('Active library verification did not receive a result.');
    return response.value;
  };
  globalThis.benchmarkFixture = {
    async seed(count) {
      const authority = (await chrome.storage.local.get('savedLibraryAuthority')).savedLibraryAuthority;
      if (authority?.phase !== 'active' || authority.retired !== true || authority.source !== 'indexeddb') throw Error('Benchmark requires a fresh active SQLite authority.');
      authorityId = authority.id;
      for (const record of buildLibrary(count, topics)) {
        expected.set(record.url, await digest(record));
        await call({ op: 'save', record, options: { replace: true } });
      }
      return expected.size;
    },
    async statistics() {
      const stats = { pages: 0, versions: 0, currentTextBytes: 0, historyTextBytes: 0, chunkTextBytes: 0, vectorValues: 0, indexedPages: 0, chunks: 0, minCapture: Infinity, maxCapture: 0 };
      let after, revision;
      do {
        const batch = await call({ op: 'pages', after });
        if (revision !== undefined && revision !== batch.revision) throw Error('The persisted benchmark corpus changed while verifying it.');
        revision = batch.revision;
        if (batch.after !== null && (!(batch.after > (after ?? '')) || batch.records.at(-1)?.url !== batch.after)) throw Error('Benchmark library cursor did not advance.');
        for (const page of batch.records) {
          if (!expected.has(page.url) || expected.get(page.url) !== await digest(page)) throw Error('Persisted corpus differs from its authored evidence for ' + page.url);
          expected.delete(page.url);
          stats.pages++;
          if (page.chunks.some(chunk => chunk.embedding.length)) stats.indexedPages++;
          for (const [index, version] of [page, ...(page.versions || [])].entries()) {
            if (index) stats.versions++;
            stats[index ? 'historyTextBytes' : 'currentTextBytes'] += encoder.encode(version.text).length;
            stats.minCapture = Math.min(stats.minCapture, version.timestamp);
            stats.maxCapture = Math.max(stats.maxCapture, version.timestamp);
            for (const chunk of version.chunks) { stats.chunks++; stats.chunkTextBytes += encoder.encode(chunk.text).length; stats.vectorValues += chunk.embedding.length; }
          }
        }
        after = batch.after;
      } while (after !== null);
      if (expected.size) throw Error('Persisted store is missing ' + expected.size + ' authored pages.');
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('web-recall-library.sqlite3')).getFile();
      return { ...stats, authorityId, authorityFileBytes: file.size, storage: await navigator.storage.estimate(), persistent: await navigator.storage.persisted() };
    }
  };
`;
const uiInstrumentation = `if (location.protocol === 'chrome-extension:' && globalThis.chrome?.runtime) {
  (${blockBenchmarkModels.toString()})();
  (${installRecallObserver.toString()})();
}`;

function makeOracle(count) {
  const pages = {}, topicMap = Object.fromEntries(topics.map(topic => [topic.id, {}]));
  const distribution = { types: {}, words: { short: 0, medium: 0, long: 0, reference: 0 } };
  let index = 0;
  for (const page of buildLibrary(count, topics)) {
    const curated = index < topics.length;
    if (curated) topicMap[topics[index].id] = { url: page.url };
    const type = curated ? topics[index].type : ['article', 'documentation', 'forum', 'dynamic'][index % 4];
    distribution.types[type] = (distribution.types[type] || 0) + 1;
    const words = page.text.split(/\s+/u).length;
    distribution.words[words > 50000 ? 'reference' : words > 3000 ? 'long' : words > 700 ? 'medium' : 'short']++;
    pages[page.url] = [page, ...(page.versions || [])].map((snapshot, version) => {
      const authored = curated ? version ? topics[index].history.text : topics[index].text : undefined;
      const passages = [];
      if (authored) for (let offset = snapshot.text.indexOf(authored); offset >= 0; offset = snapshot.text.indexOf(authored, offset + authored.length)) passages.push({ start: offset, end: offset + authored.length });
      const heading = curated && snapshot.text.startsWith('# ' + snapshot.title) ? { start: 2, end: 2 + snapshot.title.length, text: snapshot.title } : null;
      return { url: page.url, versionId: snapshot.versionId, title: snapshot.title, timestamp: snapshot.timestamp, ...(curated ? { textHash: hash(snapshot.text), passages, heading } : {}) };
    });
    index++;
  }
  return { pages, topics: topicMap, distribution };
}

async function launch(profile, heap = false) {
  const start = performance.now();
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, timeout: 20000, timezoneId: 'UTC', viewport: { width: 420, height: 1000 }, args: [`--disable-extensions-except=${packaged.extension}`, `--load-extension=${packaged.extension}`, '--host-resolver-rules=MAP * ~NOTFOUND',
    ...(heap ? ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] : [])] });
  const requests = [];
  context.on('request', request => { if (/^https?:/u.test(request.url())) requests.push(request.url()); });
  await context.route(/^https?:/u, route => route.abort());
  const matchingWorker = worker => worker.url().startsWith('chrome-extension:') && new URL(worker.url()).pathname === '/' + packaged.manifest.background.service_worker;
  const worker = context.serviceWorkers().find(matchingWorker) || await context.waitForEvent('serviceworker', { predicate: matchingWorker, timeout: 20000 });
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  if (extensionOrigin && origin !== extensionOrigin) throw Error('Packaged worker origin changed between browser launches.');
  extensionOrigin = origin;
  await withObservationDeadline(() => worker.evaluate(blockBenchmarkModels, true), 'attach package worker provider guard');
  await context.addInitScript({ content: uiInstrumentation });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const panelUrl = `${origin}/${packaged.manifest.side_panel.default_path}`;
  const open = async () => {
    await page.goto(panelUrl); await page.bringToFront();
    await page.waitForFunction(() => document.querySelector('#beta-recents-list > article'));
    await page.evaluate(() => document.fonts.ready);
  };
  return { context, worker, page, panelUrl, profile, open, requests, startupMs: () => performance.now() - start };
}

async function measure(browser, scenario, oracle) {
  if (interrupted) throw Error('Benchmark explicitly stopped; partial observations are not acceptance.');
  const { page } = browser;
  await page.evaluate(scenario => {
    document.querySelector('#beta-search-input').value = scenario.query;
    for(const [selector,value] of [['#beta-filter-domain',scenario.filters?.domain],['#beta-filter-from',scenario.filters?.from],['#beta-filter-to',scenario.filters?.through]])document.querySelector(selector).value=value||'';
    document.querySelector('#beta-search-input').scrollIntoView({block:'start'}); document.querySelector('#beta-search-filter-form').requestSubmit();
  }, scenario);
  let observation;
  try {
    await page.waitForFunction(() => {
      const current = globalThis.benchmarkObservation;
      return current?.completed && document.querySelector('#beta-search-stop').hidden && (current.firstVisibleMs !== null || !current.response?.results?.length || current.error);
    });
    observation = await page.evaluate(() => {
      const current = globalThis.benchmarkObservation;
      const visibleUrls = [...document.querySelectorAll('#beta-search-results > article > details')].map(element => element.dataset.url);
      const results = current.response?.results || [];
      return { latencyMs: current.firstVisibleMs, results: results.map(row => ({ url: row.url, versionId: row.versionId, timestamp: row.timestamp, title: row.title })), error: current.error || current.response?.error || (JSON.stringify(visibleUrls)!==JSON.stringify(results.map(row=>row.url))?'Rendered URLs differ from the current response':null) };
    });
    const expectedUrls = new Set(scenario.expected.map(id => oracle.topics[id]?.url));
    const target = observation.results.slice(0, 5).find(row => expectedUrls.has(row.url));
    if (target && !observation.error) {
      const row = page.locator('#beta-search-results > article').filter({ has: page.locator(`details[data-url=${JSON.stringify(target.url)}]`) }).first();
      await row.locator(':scope > details > summary').click();
      await row.locator('.read-saved-page').click();
      await row.locator('.saved-reader-text').waitFor();
      const snapshot = oracle.pages[target.url]?.find(value => value.versionId === target.versionId);
      const reading = await row.locator('.saved-reader-text').evaluate(observeSavedReader, snapshot?.passages || []);
      const metadata = await row.locator('.saved-reader-host > [role=status]').textContent();
      const displayedDate = await page.evaluate(timestamp => new Date(timestamp).toLocaleString(), target.timestamp);
      const passage = verifyPassage(scenario, reading.marker, snapshot, reading.visibleBodyRanges);
      observation.readerVerified = reading.digest === snapshot?.textHash && metadata.includes(displayedDate) && passage;
      observation.reading = { ...reading, captureMetadata: metadata, passageVerified: Boolean(passage) };
    }
  } catch (error) {
    observation ||= { results: [], latencyMs: null };
    observation.error = String(error);
    await page.locator('#beta-search-stop').click({ force: true, timeout: 1000 }).catch(() => {});
  }
  const finding = evaluateFinding(scenario, observation, oracle);
  console.info(`${scenario.id}: ${finding.passed ? 'pass' : 'FAIL'} rank=${finding.rank} first=${observation.latencyMs?.toFixed(1) ?? 'none'}ms${observation.error ? ' ' + observation.error.slice(0, 120) : ''}`);
  return { ...finding, latencyMs: scenario.kind === 'empty' ? undefined : observation.latencyMs, results: observation.results, reading: observation.reading, filters: scenario.filters || {}, query: scenario.query };
}

async function audit(browser) {
  const worker = await browser.worker.evaluate(async () => ({
    calls: globalThis.benchmarkCalls,
    caches: await caches.keys(),
    offscreenUrls: (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).map(context => context.documentUrl)
  }));
  return { ...worker, ui: await browser.page.evaluate(() => globalThis.benchmarkCalls), requests: browser.requests };
}

async function attachHeapTargets(browser) {
  const [port, pathname] = (await readFile(path.join(browser.profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-f0-9-]+$/u.test(pathname)) {
    throw Error('Invalid disposable DevTools endpoint.');
  }
  const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  const children = new Map();
  const connection = flatCdp(socket, event => {
    if (event.method !== 'Target.attachedToTarget' || !event.sessionId || event.params.targetInfo.type !== 'worker') return;
    const direct = children.get(event.sessionId) || new Map();
    direct.set(event.params.targetInfo.targetId, event.params);
    children.set(event.sessionId, direct);
  });
  try {
    await withObservationDeadline(() => new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('Cannot open the disposable DevTools connection.')), { once: true });
    }), 'connect to the benchmark browser');
    const filter = [{}];
    await connection.send('Target.setDiscoverTargets', { discover: true, filter });
    const { targetInfos } = await connection.send('Target.getTargets', { filter });
    const background = targetInfos.find(value => value.type === 'service_worker' && value.url === browser.worker.url());
    const panel = targetInfos.find(value => value.type === 'page' && value.url === browser.panelUrl);
    const host = targetInfos.find(value => value.type === 'background_page' && value.url === extensionOrigin + '/dist/beta/offscreen/index.html');
    if (!background || !panel || !host) throw Error('Missing packaged background, reader or storage host heap target.');
    const attach = target => connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const targets = [];
    for (const [name, target] of [['background', background], ['panel', panel], ['offscreen', host]]) {
      const { sessionId } = await attach(target);
      targets.push({ name, sessionId });
    }
    const visit = async (targetId, sessionId, requireChildren) => {
      const expected = targetInfos.filter(value => value.type === 'worker' && value.parentId === targetId);
      if (!requireChildren && !expected.length) return;
      await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'worker' }] }, sessionId);
      const deadline = performance.now() + 5000;
      while (!children.get(sessionId)?.size || expected.some(target => !children.get(sessionId).has(target.targetId))) {
        if (performance.now() >= deadline) throw Error('A disposable storage worker did not attach.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      for (const { targetInfo, sessionId: childSession } of children.get(sessionId).values()) {
        targets.push({ name: targetInfo.url, sessionId: childSession });
        await visit(targetInfo.targetId, childSession, targetInfo.url.endsWith('/libraryWorker.js'));
      }
    };
    await visit(host.targetId, targets[2].sessionId, true);
    return { connection, targets };
  } catch (error) { connection.close(); throw error; }
}

async function memoryObserver(browser) {
  const { connection, targets } = await attachHeapTargets(browser);
  try { return await measureIsolates(connection, targets); }
  catch (error) { connection.close(); throw error; }
}

async function measureIsolates(connection, targets) {
  let stopped = false;
  const prefix = extensionOrigin + '/dist/beta/offscreen/';
  for (const required of ['libraryWorker.js', 'sqlite/sqlite3-opfs-async-proxy.js?vfs=opfs-wl']) {
    if (!targets.some(value => value.name === prefix + required)) throw Error(`Missing storage heap target ${required}; observed ${targets.map(value => value.name).join(', ')}`);
  }
  const commands = targets.map(target => ({ name: target.name.replace(prefix, ''), command: method => connection.send(method, undefined, target.sessionId) }));
  const isolates = new Map();
  for (const target of commands) {
    const { id } = await target.command('Runtime.getIsolateId');
    if (typeof id !== 'string' || !id) throw Error('CDP did not identify the heap isolate: ' + target.name);
    if (!isolates.has(id)) isolates.set(id, { command: target.command, targets: [] });
    isolates.get(id).targets.push(target.name);
  }
  const observations = [];
  const sample = async (phase, caseId) => {
    const snapshots = await Promise.all(Array.from(isolates.values(), async entry => {
      const usage = await entry.command('Runtime.getHeapUsage');
      if (![usage.usedSize, usage.backingStorageSize].every(value => Number.isFinite(value) && value >= 0)) throw Error('Invalid CDP heap sample for ' + entry.targets.join(', '));
      return { targets: entry.targets, usage, bytes: usage.usedSize + usage.backingStorageSize };
    }));
    const observation = { phase, caseId, isolates: snapshots, observedAt: new Date().toISOString(),
      combinedBytes: snapshots.reduce((total, value) => total + value.bytes, 0),
      backgroundPanelBytes: snapshots.filter(value => value.targets.includes('background') || value.targets.includes('panel')).reduce((total, value) => total + value.bytes, 0) };
    observations.push(observation); return observation;
  };
  return {
    async collect(phase) {
      await Promise.all(Array.from(isolates.values(), entry => entry.command('HeapProfiler.collectGarbage')));
      return sample(phase);
    },
    async profile(operation, size) {
      const command = commands.find(target => target.name === 'libraryWorker.js').command;
      await command('Profiler.enable'); await command('Profiler.start');
      let result;
      try { result = await operation(); }
      finally {
        const { profile } = await command('Profiler.stop');
        await command('Profiler.disable');
        const filename = output.replace(/\.json$/u, `-${size}-${report.chrome}-library-cpu.cpuprofile`);
        await writeFile(filename, JSON.stringify(profile));
        const times = new Map();
        for (let index = 0; index < profile.samples.length; index++) times.set(profile.samples[index], (times.get(profile.samples[index]) || 0) + profile.timeDeltas[index] / 1000);
        const nodes = new Map(profile.nodes.map(node => [node.id,node]));
        const diagnostic = { size, filename, result, totalMs: (profile.endTime-profile.startTime)/1000, selfTime: [...times].map(([id,milliseconds]) => ({ milliseconds, name: nodes.get(id).callFrame.functionName, url: nodes.get(id).callFrame.url })).sort((first,second)=>second.milliseconds-first.milliseconds).slice(0,20) };
        (report.profileDiagnostics ||= []).push(diagnostic);
        console.info(JSON.stringify({ profileDiagnostic: diagnostic }));
      }
    },
    async during(operation, caseId) {
      let finished = false;
      const outcome = operation.then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
      while (!finished && !stopped) { await sample('workload', caseId); await new Promise(resolve => setTimeout(resolve, 100)); }
      const result = await outcome; if (result.error) throw result.error; return result.value;
    },
    async close() {
      stopped = true;
      connection.close();
      const active = observations.filter(value => value.phase === 'workload');
      return { sampleIntervalMs: 100, sampleCount: active.length, maxCombinedSampleBytes: active.length ? Math.max(...active.map(value => value.combinedBytes)) : null,
        peak: active.reduce((largest,value) => !largest || value.combinedBytes > largest.combinedBytes ? value : largest, undefined), checkpoints: observations.filter(value => value.phase !== 'workload') };
    }
  };
}

try {
  directory = await mkdtemp(path.join(tmpdir(), 'web-recall-benchmark-'));
  packaged = await stageRecallPackage(candidate, directory);
  const manifest = await readJson('manifest.json');
  if (packaged.manifest.version !== manifest.version) throw Error('Select a package for the current manifest version.');
  report.candidate = { ...report.candidate, sha256: packaged.sha256, version: packaged.manifest.version, files: packaged.files };
  const fixtureBundle = (await build({ stdin: { contents: workerFixture, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', logLevel: 'silent' })).outputFiles[0].text;
  report.instrumentation = { fixture: hash(fixtureBundle), ui: hash(uiInstrumentation) };
  for (const size of sizes) {
    console.info(`Preparing ${size} pages (${report.mode}); only the owned temporary profile is used.`);
    const oracle = makeOracle(size), profile = path.join(directory, `profile-${size}`);
    validateEvaluationSources(scenarios, oracle);
    let browser = await launch(profile);
    report.chrome = browser.context.browser().version();
    const entry = { size, distribution: oracle.distribution, samples: [], cold: [], audits: [] };
    report.libraries.push(entry);
    await browser.page.goto(browser.panelUrl);
    entry.settings = await withObservationDeadline(() => browser.page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { paused: true, automaticAi: false, captureSetupComplete: true, recallSetupComplete: true } });
      if (response?.error || response?.settings?.automaticAi !== false || response.settings.paused !== true) throw Error(response?.error || 'Benchmark could not disable automatic capture and AI.');
      if (await chrome.permissions.contains({ permissions: ['nativeMessaging'] })) throw Error('Benchmark must not have native model access.');
      return response.settings;
    }), 'configure the isolated packaged extension');
    const ready = await withObservationDeadline(() => browser.page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_RECENT_PAGES' })), 'open the packaged authority before seeding');
    if (ready?.error || !Array.isArray(ready?.pages) || ready.pages.length) throw Error(ready?.error || 'Benchmark must start with a new saved library.');
    await withObservationDeadline(() => browser.worker.evaluate(fixtureBundle), 'attach corpus fixture');
    const seedStart = performance.now();
    const written = await withObservationDeadline(() => browser.worker.evaluate(size => globalThis.benchmarkFixture.seed(size), size), `seed ${size} pages`, 300000);
    entry.seedMs = performance.now() - seedStart;
    entry.storage = await withObservationDeadline(() => browser.worker.evaluate(async () => {
      try { return await globalThis.benchmarkFixture.statistics(); }
      finally { delete globalThis.benchmarkFixture; }
    }), 'verify the persisted benchmark corpus', 120000);
    if (written !== size || entry.storage.pages !== size) throw Error('Persisted workload does not match the declared library size.');
    console.info(JSON.stringify({ verifiedPages: size, seedMs: entry.seedMs, sqliteBytes: entry.storage.authorityFileBytes }));
    entry.audits.push(await audit(browser));
    await closeBrowser();
    browser = await launch(profile, true);
    await browser.open(); entry.initializationMs = browser.startupMs();
    const memory = await memoryObserver(browser);
    try {
      await memory.collect('initialized-after-gc');
      entry.warmup = await measure(browser, development[0], oracle);
      for (let round = 0; round < (pilot ? 1 : 2); round++) {
        for (const scenario of scenarios) entry.samples.push({ round, ...await memory.during(measure(browser, scenario, oracle), scenario.id) });
      }
      if (profiling) await memory.profile(async () => {
        const scenario = development.find(value => value.id === 'vague-07');
        await browser.page.evaluate(query => {
          document.querySelector('#beta-search-input').value=query;
          for(const id of ['beta-filter-domain','beta-filter-from','beta-filter-to'])document.getElementById(id).value='';
          document.querySelector('#beta-search-input').scrollIntoView({block:'start'});
          document.querySelector('#beta-search-filter-form').requestSubmit();
        },scenario.query);
        await browser.page.waitForFunction(()=>globalThis.benchmarkObservation?.completed && globalThis.benchmarkObservation.firstVisibleMs!==null && document.querySelector('#beta-search-stop').hidden);
        return browser.page.evaluate(()=>({firstVisibleMs:globalThis.benchmarkObservation.firstVisibleMs,results:globalThis.benchmarkObservation.response.results.length}));
      }, size);
      await browser.page.evaluate(() => {
        for (const id of ['beta-search-input','beta-filter-domain','beta-filter-from','beta-filter-to']) document.getElementById(id).value='';
        document.querySelector('#beta-search-filter-form').requestSubmit();
        globalThis.benchmarkObservation=null;
      });
      await browser.page.waitForFunction(() => document.querySelector('#beta-search-stop').hidden && !document.querySelector('#beta-search-results > article'));
      await memory.collect('cleared-after-gc');
    } finally { entry.memory = await memory.close(); }
    entry.audits.push(await audit(browser));
    await closeBrowser();
    if (!pilot) {
      for (const scenario of scenarios.filter(value => value.cold)) {
        browser = await launch(profile); await browser.open();
        const initializationMs = browser.startupMs();
        entry.cold.push({ initializationMs, ...await measure(browser, scenario, oracle) });
        entry.audits.push(await audit(browser));
        await closeBrowser();
      }
    }
    entry.quality = Object.fromEntries(['development', ...(acceptance ? ['heldout'] : [])].map(split => [split, summarizeObservations(entry.samples, entry.cold, split)]));
    entry.timing = { warm: latencySummary(entry.samples.filter(value => value.kind !== 'empty').map(value => value.latencyMs), 500), cold: latencySummary(entry.cold.filter(value => value.kind !== 'empty').map(value => value.latencyMs), 2000) };
    entry.noObservedModelCalls = entry.audits.every(value => [value.calls,value.ui].every(surface => !surface.http.length && surface.native === 0 && surface.offscreen === 0 && !surface.modelDispatches.length) &&
      !value.requests.length && !value.caches.length && value.offscreenUrls.every(url => url === extensionOrigin + '/dist/beta/offscreen/index.html'));
    entry.integrity = [...entry.samples,...entry.cold].every(value => !value.error && !value.violations.length && (value.rank === null || value.rank > 5 || value.sourceMatches && value.readerVerified));
    const totalStorage = entry.storage.storage.usage;
    const storageBytes = Number.isFinite(totalStorage) && totalStorage >= 0 && entry.storage.authorityFileBytes > 0 ? Math.max(totalStorage, entry.storage.authorityFileBytes) : null;
    entry.resources = resourceSummary({ storageBytes, activeSampleBytes: entry.memory.maxCombinedSampleBytes, sampleCount: entry.memory.sampleCount, initializedIdleBytes: entry.memory.checkpoints.find(value => value.phase === 'initialized-after-gc')?.combinedBytes, clearedIdleBytes: entry.memory.checkpoints.find(value => value.phase === 'cleared-after-gc')?.combinedBytes }, report.targets.resources);
    entry.passed = !pilot && entry.integrity && entry.resources.passed && Object.values(entry.quality).every(value => value.passedGate) && Object.values(entry.timing).every(value => value.passed) && entry.noObservedModelCalls;
    console.info(JSON.stringify({ size, quality: entry.quality, timing: entry.timing, resources: entry.resources, noObservedModelCalls: entry.noObservedModelCalls }));
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
} catch (error) {
  report.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  report.cleanupErrors = [];
  try { await closeBrowser(); } catch (error) { report.cleanupErrors.push(String(error)); }
  try {
    if (directory && !context) await rm(directory, { recursive: true, force: true });
    else if (directory) report.retainedScratch = directory;
  } catch (error) { report.cleanupErrors.push(String(error)); }
  try {
    report.sourceDrift = (await Promise.all(provenanceFiles.map(async filename => {
      try { return hash(await readFile(filename)) === provenance[filename] ? null : filename; }
      catch { return filename; }
    }))).filter(Boolean);
    report.finishedAt = new Date().toISOString(); report.interrupted = interrupted;
    report.passed = acceptance && !report.error && !interrupted && !report.sourceDrift.length && !report.cleanupErrors.length && report.libraries.length === 2 && new Set(report.libraries.map(value => value.size)).size === 2 && report.libraries.every(entry => entry.passed);
    if (acceptance && !report.passed) process.exitCode = 1;
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
  console.info(`Report: ${output}`);
}
