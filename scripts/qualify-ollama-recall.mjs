import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { withObservationDeadline } from './lib/capture-qualification.mjs';
import { stageRecallPackage } from './lib/recall-package.mjs';

const argument = name => process.argv.slice(2).find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const candidate = argument('candidate');
assert.ok(candidate, 'Supply --candidate=<exact extension ZIP>');
const server = new URL(argument('ollama') || 'http://127.0.0.1:11434');
assert.ok(server.protocol === 'http:' && server.hostname === '127.0.0.1' && server.port && server.href === server.origin + '/',
  'Select an already running IPv4 loopback Ollama origin without credentials, path or query');
const model = argument('model') || 'embeddinggemma';
const readServer = async pathname => {
  const response = await fetch(new URL(pathname, server), { redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.ok(response.ok, 'Ollama probe failed: ' + response.status);
  return response.json();
};
const { version } = await readServer('/api/version');
const { models } = await readServer('/api/tags');
assert.ok(typeof version === 'string' && Array.isArray(models));
const installed = models.find(item => item.name === model || item.name === model + ':latest');
assert.ok(installed, 'The chosen model must already be installed; this probe never downloads weights');

const directory = await mkdtemp(path.join(tmpdir(), 'web-recall-ollama-'));
let context;
try {
  const archive = await stageRecallPackage(path.resolve(candidate), directory);
  context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
    channel: 'chromium', headless: true, timeout: 15000,
    args: ['--disable-extensions-except=' + archive.extension, '--load-extension=' + archive.extension, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
  });
  const traffic = [];
  const failures = [];
  context.on('request', request => { if (/^https?:/u.test(request.url())) traffic.push({ url: request.url(), method: request.method() }); });
  context.on('requestfailed', request => { if (/^https?:/u.test(request.url())) failures.push({ url: request.url(), error: request.failure()?.errorText }); });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 12000 });
  const panel = await context.newPage();
  await panel.goto(new URL('/' + archive.manifest.side_panel.default_path, worker.url()).href);
  const rpc = async (type, fields = {}) => {
    const reply = await withObservationDeadline(() => panel.evaluate(payload => chrome.runtime.sendMessage(payload), { type, ...fields }), type, 65000);
    assert.ok(reply && !reply.error, reply?.error || 'No extension reply: ' + type);
    return reply;
  };
  const url = 'https://saved-recall.invalid/red-knot';
  const text = 'Red knots lay eggs in shallow depressions along tundra ponds. Adults incubate in shifts and leave the coastal flats until the chicks can fly.';
  await rpc('SET_SETTINGS', { payload: { captureSetupComplete: true, recallSetupComplete: true, paused: true, automaticAi: false, queryRewrite: false, searchRerank: false } });
  const imported = await rpc('IMPORT_PAGES', { schemaVersion: 1, pages: [{ url, title: 'Red knot field notes', timestamp: 1609459200000, text, manual: true, chunks: [{ text, embedding: [] }] }] });
  assert.equal(imported.imported, 1);
  const search = query => rpc('SEARCH_QUERY', { query, requestId: crypto.randomUUID() });
  assert.equal((await search('"shallow depressions"')).results[0]?.url, url);
  assert.equal(traffic.length, 0, 'Recalling saved text does not need a configured model');

  await rpc('SET_EMBEDDING_CONFIG', { payload: { provider: 'ollama', baseUrl: server.origin, model } });
  const backfill = await rpc('BACKFILL_EMBEDDINGS', { urls: [url], limit: 1, force: false, requestId: crypto.randomUUID() });
  assert.equal(backfill.result.updated, 1, JSON.stringify({ backfill: backfill.result, failures }));
  const before = (await rpc('GET_ALL_PAGES')).pages.find(page => page.url === url);
  assert.equal(before?.text, text);
  assert.ok(before.chunks.length && before.chunks.every(chunk => chunk.embedding.length > 0 && chunk.embedding.every(Number.isFinite)));
  const query = 'shorebird breeding habitat';
  const trafficBeforeOptIn = traffic.length;
  assert.equal((await search(query)).results.length, 0, 'The semantic probe must not already match the saved title, URL or body');
  assert.equal(traffic.length, trafficBeforeOptIn, 'Searching before AI opt-in must not request the configured embedding model');
  await rpc('SET_SETTINGS', { payload: { automaticAi: true } });
  const hit = (await search(query)).results.find(result => result.url === url);
  assert.ok(hit?.score > 0 && !hit.textMatch, 'Find the saved page by real semantic retrieval');
  assert.ok(traffic.filter(request => new URL(request.url).pathname === '/api/embed' && request.method === 'POST').length >= 2,
    'Observe both actual document and query embedding requests');
  const browser = context.browser().version();
  assert.equal((await rpc('DELETE_PAGE', { url })).deleted, 1);
  assert.equal((await search(query)).results.length, 0, 'Forgetting removes the real semantic result');
  assert.ok(traffic.every(request => new URL(request.url).origin === server.origin && !new URL(request.url).pathname.includes('/pull')),
    'No traffic to any remote destination or download endpoint');
  console.info(JSON.stringify({ candidate: path.resolve(candidate), sha256: archive.sha256, browser, ollama: version,
    model: installed.name, modelDigest: installed.digest, dimensions: before.chunks[0].embedding.length, textRecallWithoutModel: true,
    semanticResult: true, deletedResultAbsent: true, providerPaths: traffic.map(request => new URL(request.url).pathname) }, null, 2));
} finally {
  await context?.close();
  await rm(directory, { recursive: true, force: true });
}
