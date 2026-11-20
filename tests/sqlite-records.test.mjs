import assert from 'node:assert/strict';
import test from 'node:test';
import initializeSqlite from '@sqlite.org/sqlite-wasm';
import { loadSource } from './helpers.mjs';

const sqlite = await initializeSqlite();
const id = '7743a63a-d81e-4f7f-a626-615263f1a52f';
const source = 'https://fixture.example/';

const record = (path, timestamp = 10) => ({ url: source + path, text: `Captured ${path}`, title: path, timestamp, manual: true,
  chunks: [{ text: `Captured ${path}`, embeddingKey: 'local-model', embedding: [1, 0] }] });

async function fixture(context, environment = {}) {
  const database = new sqlite.oo1.DB(':memory:', 'c');
  context.after(() => database.close());
  const library = await loadSource('src/shared/db/sqliteLibrary.ts');
  const { SqliteRecords } = await loadSource('src/shared/db/sqliteRecords.ts', '', {}, environment);
  await library.stageSavedLibrary(database, id, null);
  assert.throws(() => new SqliteRecords(database, id), /active saved library is not available/u);
  library.activateSavedLibrary(database, id);
  const records = new SqliteRecords(database, id);
  return { database, library, records, reopen: () => new SqliteRecords(database, id) };
}

test('queue status is a coherent snapshot even when indexing completes during the read', async context => {
  const { records } = await fixture(context);
  const captureText = 'Private captured text. '.repeat(1024);
  const jobs = Array.from({ length: 96 }, (_, index) => {
    const url = source + `capture-${String(index).padStart(2, '0')}`;
    return {
      url, title: `Page ${index}`, status: index === 95 ? 'failed' : 'queued', attempts: index === 95 ? 3 : 0,
      createdAt: index, updatedAt: index, lastAttemptAt: index,
      ...(index === 95 ? { error: 'Local model is offline', textSaved: true } : {}),
      payload: { url, title: `Page ${index}`, timestamp: index, text: captureText, chunks: [captureText], captureId: 'private-retry-id' }
    };
  });
  for (const entry of jobs) await records.run({ op: 'appendJob', entry });
  const completed = jobs[81];
  const workerReplies = [];
  let completeOnReply = true;
  const { createSqliteBackend } = await loadSource('src/background/storage/sqlite.ts', '', {
    '../offscreen/index': {
      ensureOffscreenDocument: async () => {},
      async sendOffscreenMessage({ request }) {
        const value = await records.run(request.action);
        workerReplies.push(value);
        if (completeOnReply) {
          completeOnReply = false;
          await records.run({ op: 'removeJob', url: completed.url });
        }
        return { value };
      }
    }
  });
  const storageManager = createSqliteBackend(id, { listLogs: async () => [], clearLogs: async () => {} });
  let listener;
  const runtime = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    getURL: path => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}`,
    onMessage: { addListener(value) { listener = value; } }
  };
  const { orchestrateLifecycle } = await loadSource('src/background/orchestration/index.ts', '', {
    '../storage/manager': { storageManager }
  }, { chrome: { runtime, storage: { onChanged: { addListener() {} } } } });
  orchestrateLifecycle();
  const sender = { id: runtime.id, url: runtime.getURL('dist/beta/ui/sidepanel/index.html') };
  const readQueue = () => new Promise(resolve => listener({ type: 'GET_PROCESSING' }, sender, resolve));

  const first = await readQueue();
  assert.equal(first.error, undefined, 'A concurrent completion must not fail the queue read');
  const orderedUrls = jobs.map(job => job.url).reverse();
  assert.deepEqual(Array.from(first.queue, job => job.url), orderedUrls, 'The first reply describes one complete queue snapshot');
  assert.deepEqual(structuredClone(first.queue[0]), {
    url: jobs[95].url, title: 'Page 95', status: 'failed', attempts: 3, updatedAt: 95, error: 'Local model is offline', textSaved: true
  });
  assert.ok(!JSON.stringify(first.queue).includes('Private captured text'));
  assert.ok(!JSON.stringify(first.queue).includes('private-retry-id'));
  const transported = JSON.stringify(workerReplies);
  assert.ok(!transported.includes('Private captured text') && !transported.includes('private-retry-id'),
    'The background must not receive saved text or recovery IDs just to show queue status');
  assert.equal(records.job(jobs[95].url).payload.text, captureText, 'Status reads preserve stored retry evidence');
  const next = await readQueue();
  assert.equal(next.error, undefined);
  assert.deepEqual(Array.from(next.queue, job => job.url), orderedUrls.filter(url => url !== completed.url), 'A later read reflects the completed job');
  assert.deepEqual(structuredClone(await storageManager.listFailedProcessingTargets()), [{
    url: jobs[95].url, captureId: 'private-retry-id'
  }], 'Internal retry selection needs only the failed job identity, not the payload');
});

test('worker-owned lexical ranking searches beyond the first batch and returns the exact historical passage, not page bodies', async context => {
  const { records } = await fixture(context);
  for (let index = 0; index < 90; index++) records.save(record(`entry-${index}`, 120));
  const text = 'Earlier observations show that the silver heron returns at dawn.';
  const winner = {
    ...record('zz-last', 110), text: 'The present notes mention a silver bird and morning weather.',
    versions: [{ title: 'Field survey', versionId: 'original', timestamp: 70, chunks: [], text }]
  };
  records.save(winner);
  const replies = [];
  const { createSqliteBackend } = await loadSource('src/background/storage/sqlite.ts', '', {
    '../offscreen/index': {
      ensureOffscreenDocument: async () => {},
      sendOffscreenMessage: async message => {
        assert.equal(message.request.id, id);
        const value = await records.run(message.request.action);
        replies.push(value);
        return { value };
      }
    }
  });
  const backend = createSqliteBackend(id, { listLogs: async () => [], clearLogs: async () => {} });
  const result = await backend.searchTextPages('"silver heron"', 1, { from: 50, before: 100 });
  assert.equal(replies.length, 1);
  assert.equal(result.hasPages, true);
  assert.deepEqual(structuredClone(result.scopeUrls), [winner.url]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].versionId, 'original');
  const match = result.results[0].match;
  assert.equal(match.field, 'text');
  assert.equal(text.slice(match.start, match.end), 'silver heron');
  assert.ok(!Object.hasOwn(result.results[0], 'text') && !Object.hasOwn(result.results[0], 'chunks'));
  const outside = await backend.searchTextPages('"silver heron"', 1, {}, { scopeUrls: [source + 'entry-0'] });
  assert.equal(outside.results.length, 0);
});

test('indexed ranking retains exact, partial and Unicode matches and the same original passage as exhaustive search', async context => {
  const { records } = await fixture(context);
  const decoy = { ...record('filter-decoy', 70), text: 'General woodland observations.' };
  const old = { ...record('old-observations', 120), text: 'Unrelated recent material.',
    versions: [{ title: 'Survey notes', versionId: 'winter-notes', timestamp: 60, chunks: [], text: 'Café visit: KITES\tand\nſwifts gather near the cliff.' }] };
  const title = { ...record('title-hit', 50), title: 'Swift sightings', text: 'A different part of the survey.' };
  const fragment = { ...record('body-fragment', 72), text: 'Some kitesurfers saw seabirds.' };
  const outside = { ...record('outside-window', 110), text: 'kites and swifts gather near the cliff.' };
  const pages = [decoy, old, title, fragment, outside];
  for (const page of pages) records.save(page);
  const filters = { domain: 'fixture.example', from: 50, before: 90 };
  const run = (query, scopeUrls) => records.run({ op: 'searchText', query, limit: 2, filters, scopeUrls });
  for (const query of ['“kites and swifts”', 'kite', 'café', 'ſwift', 'KITES', 'swift survey', 'near the cliff', 'nonexistent']) {
    const indexed = structuredClone(await run(query));
    const exhaustive = structuredClone(await run(query, pages.map(page => page.url)));
    assert.deepEqual(indexed, exhaustive, query);
    assert.deepEqual(indexed.scopeUrls, [fragment.url, decoy.url, old.url, title.url], 'Filter identity is not limited to text hits');
  }
  const [hit] = (await run('“kites and swifts”')).results;
  assert.equal(hit.url, old.url);
  assert.equal(hit.versionId, 'winter-notes');
  assert.equal(old.versions[0].text.slice(hit.match.start, hit.match.end), 'KITES\tand\nſwifts');
  assert.deepEqual(structuredClone((await run('kites')).results.map(result => result.url)), [old.url, fragment.url]);
});

test('damaged or missing search shortcuts cannot hide saved evidence before or after reopening', async context => {
  const { records, database, reopen } = await fixture(context);
  const page = { ...record('retained-evidence', 70), text: 'Independent evidence survives a damaged search shortcut.' };
  records.save(page);
  const hints = database.selectValue('select hints from saved_text_index where url=?', [page.url]);
  const originalHints = new Uint8Array(hints);
  hints[hints.length - 1] ^= 1;
  database.exec('update saved_text_index set hints=? where url=?', { bind: [hints, page.url] });
  const find = { op: 'searchText', query: '"Independent evidence"', limit: 1, filters: { from: 60, before: 80 } };
  const verify = async instance => {
    const reply = await instance.run(find);
    assert.equal(reply.results[0]?.url, page.url);
    assert.equal(reply.hasPages, true);
    assert.deepEqual(structuredClone(reply.scopeUrls), [page.url]);
  };
  await verify(records);
  records.save({ ...record('other-projection', 45), text: 'Ordinary survey notes.' });
  const originalProjection = database.selectValue('select record from saved_search where url=?', [page.url]);
  const otherProjection = database.selectValue('select record from saved_search where url=?', [source + 'other-projection']);
  database.exec('update saved_text_index set hints=? where url=?', { bind: [originalHints, page.url] });
  database.exec('update saved_search set record=?,url=? where url=?', { bind: [otherProjection, source + 'wrong-projection-identity', page.url] });
  await verify(records);
  const bytes = Buffer.from(originalProjection);
  const offset = bytes.indexOf('Independent evidence');
  assert.ok(offset > 0);
  bytes[offset] = 'X'.charCodeAt(0);
  database.exec('update saved_search set record=? where url=?', { bind: [bytes, source + 'wrong-projection-identity'] });
  await verify(records);
  database.exec('delete from saved_text_index where url=?', { bind: [page.url] });
  database.exec('delete from saved_search where url=?', { bind: [source + 'wrong-projection-identity'] });
  await verify(records);
  const reopened = reopen();
  assert.equal(reopened.page(page.url).text, page.text);
  assert.equal(reopened.batch('pages', undefined, 5).records.find(record => record.url === page.url)?.text, page.text);
  await verify(reopened);
  const browsed = await reopened.run({ ...find, query: '' });
  assert.equal(browsed.results[0]?.url, page.url, 'Keyword-free date browsing must use the authoritative page as well');
});

test('a combining mark after a title hit does not let a weaker body hit prune that title', async context => {
  const { records } = await fixture(context);
  const wanted = { ...record('preferred-title'), title: 'alpha\u0345', text: 'A note about stars.' };
  const weaker = { ...record('newer-report', 20), text: 'An alpha test of the report.' };
  records.save(wanted); records.save(weaker);
  const command = { op: 'searchText', query: 'alpha', limit: 1, filters: {} };
  assert.equal((await records.run(command)).results[0]?.url, wanted.url);
  assert.equal((await records.run({ ...command, scopeUrls: [wanted.url, weaker.url] })).results[0]?.url, wanted.url);
});

test('a page with many distinct words still finds a late passage outside the word shortcut budget', async context => {
  const { records } = await fixture(context);
  const noise = Array.from({ length: 1800 }, (_entry, index) => 'vocabulary' + index).join(' ');
  const page = { ...record('long-vocabulary'), text: noise + '\n\nThe late entry contains an amber sextant.' };
  records.save(page);
  const reply = await records.run({ op: 'searchText', query: '"amber sextant"', limit: 1, filters: {} });
  assert.equal(reply.results[0]?.url, page.url);
  const { start, end } = reply.results[0].match;
  assert.equal(page.text.slice(start, end), 'amber sextant');
});

test('a stopped in-progress lexical scan yields and releases its cursor for the next write', async context => {
  let now = 0, yielded;
  const { records } = await fixture(context, {
    performance: { now: () => now += 30 },
    setTimeout: resume => { yielded = resume; }
  });
  const page = record('cancellable');
  records.save(page);
  const { createLibraryQueue } = await loadSource('src/offscreen/libraryQueue.ts');
  const queue = createLibraryQueue();
  const pending = queue.enqueue('search', check => records.run({ op: 'searchText', query: 'Captured', limit: 1, filters: {} }, check));
  const stopped = assert.rejects(pending, /operation cancelled/u);
  await Promise.resolve();
  assert.equal(typeof yielded, 'function');
  queue.cancel('search');
  yielded();
  await stopped;
  await queue.enqueue('update', () => records.save({ ...page, text: 'Still writable' }));
  assert.equal(records.page(page.url).text, 'Still writable');
});

test('a job that cannot commit rolls back the page, its text projection and the authority counts', async context => {
  const { records, library, database } = await fixture(context);
  const page = record('atomic');
  records.save(page);
  const prior = structuredClone(records.page(page.url));
  const job = { url: source + 'different-page', title: page.title, status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, lastAttemptAt: 0 };
  assert.throws(() => records.save({ ...page, text: 'Never committed' }, { captureEntry: job }), /job does not match/u);
  assert.deepEqual(structuredClone(records.page(page.url)), prior);
  assert.equal(records.page(page.url, true).text, page.text);
  assert.equal(records.job(job.url), undefined);
  assert.deepEqual(structuredClone(library.inspectStagedLibrary(database)), { id, sourceVersion: null, pages: 1, processing: 0 });
});

test('the adapter reads the whole text library in bounded batches and preserves stable recent pagination for tied captures', async context => {
  const { records } = await fixture(context);
  const paths = Array.from({ length: 77 }, (_, index) => String(100 + index));
  for (const path of paths) records.save(record(path));
  records.save({ ...record('100'), text: '', chunks: [{ text: 'Earliest body supplied by a stored section.', embedding: [1, 0] }] });
  const replies = [];
  const { createSqliteBackend } = await loadSource('src/background/storage/sqlite.ts', '', {
    '../offscreen/index': {
      ensureOffscreenDocument: async () => {},
      sendOffscreenMessage: async message => {
        assert.equal(message.request.id, id);
        const value = records.run(message.request.action);
        if (message.request.action.op === 'search') replies.push(value.records.length);
        return { value };
      }
    }
  });
  const backend = createSqliteBackend(id, { listLogs: async () => [], clearLogs: async () => {} });
  const found = [];
  await backend.scanSearchPages(page => found.push(structuredClone(page)));
  assert.deepEqual(found.map(page => page.url), paths.map(path => source + path));
  assert.equal(found[0].text, 'Earliest body supplied by a stored section.');
  assert.ok(found.every(page => page.chunks.length === 0));
  assert.ok(replies.length > 1, 'The transport must not materialize the whole search library as one reply');
  const first = await backend.listRecentPageSummaries(2);
  const second = await backend.listRecentPageSummaries(2, first.nextCursor);
  assert.deepEqual([...first.pages, ...second.pages].map(page => page.url), ['176', '175', '174', '173'].map(path => source + path));
  const filtered = [];
  await backend.scanSearchPages(page => filtered.push(page.url), { scopeUrls: [source + '160', source + '100', source + '160', source + 'missing'] });
  assert.deepEqual(filtered, [source + '100', source + '160']);
});

test('cancelling a write while the storage host opens leaves the committed evidence unchanged', async context => {
  const { records } = await fixture(context);
  const before = record('retained');
  records.save(before);
  let releaseHost;
  const started = new Promise(resolve => { releaseHost = resolve; });
  const { createSqliteBackend } = await loadSource('src/background/storage/sqlite.ts', '', {
    '../offscreen/index': {
      ensureOffscreenDocument: () => started,
      sendOffscreenMessage: async message => ({ value: records.run(message.request.action) })
    }
  });
  const backend = createSqliteBackend(id, { listLogs: async () => [], clearLogs: async () => {} });
  const controller = new AbortController();
  const pending = backend.savePageRecord({ ...before, text: 'Cancelled edit' }, { signal: controller.signal });
  controller.abort(new Error('Stopped before sending'));
  releaseHost();
  await assert.rejects(pending, /Stopped before sending/u);
  assert.equal(records.page(before.url).text, before.text);
});

test('a search refuses to mix batches across a concurrent library update', async context => {
  const { records } = await fixture(context);
  const paths = Array.from({ length: 67 }, (_, index) => String(100 + index));
  for (const path of paths) records.save(record(path));
  let changed = false;
  const { createSqliteBackend } = await loadSource('src/background/storage/sqlite.ts', '', {
    '../offscreen/index': {
      ensureOffscreenDocument: async () => {},
      sendOffscreenMessage: async message => {
        const value = records.run(message.request.action);
        if (message.request.action.op === 'search' && !changed) {
          changed = true;
          records.delete([source + '165']);
          records.save(record('999'));
        }
        return { value };
      }
    }
  });
  const backend = createSqliteBackend(id, { listLogs: async () => [], clearLogs: async () => {} });
  const observed = [];
  await assert.rejects(backend.scanSearchPages(page => observed.push(page.url)), /library changed during the scan/u);
  assert.ok(observed.length > 0, 'The first complete snapshot batch reached the visitor');
  assert.ok(!observed.includes(source + '999'), 'The visitor must not see records belonging to the next revision');
  const fresh = [];
  await backend.scanSearchPages(page => fresh.push(page.url));
  assert.deepEqual(fresh, [...paths.filter(path => path !== '165'), '999'].map(path => source + path));
});

test('a cancelled queued operation cannot mutate the current page or admit a retry job', async context => {
  const { records } = await fixture(context);
  const before = record('retained');
  records.save(before);
  const { createLibraryQueue } = await loadSource('src/offscreen/libraryQueue.ts');
  const queue = createLibraryQueue();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const preceding = queue.enqueue(undefined, async () => held);
  const job = { url: before.url, title: before.title, status: 'queued', attempts: 0, createdAt: 10, updatedAt: 10, lastAttemptAt: 0 };
  const queued = queue.enqueue('cancelled', async () => records.save({ ...before, text: 'Cancelled capture' }, { captureEntry: job }));
  queue.cancel('cancelled');
  release();
  await preceding;
  await assert.rejects(queued, /operation cancelled/u);
  assert.equal(records.page(before.url).text, before.text);
  assert.equal(records.job(before.url), undefined);
  await queue.enqueue('accepted', async () => records.save({ ...before, text: 'Accepted capture' }, { captureEntry: job }));
  assert.equal(records.page(before.url).text, 'Accepted capture');
  assert.deepEqual(structuredClone(records.job(before.url)), job);
});

test('malformed mutation arguments cannot release retained evidence or make a stale job current', async context => {
  const { records } = await fixture(context);
  const before = { ...record('protected'), kept: true, versionId: 'retained' };
  records.save(before);
  assert.throws(() => records.run({ op: 'editVersion', url: before.url, versionId: 'retained', action: 'typo' }), /Invalid active library operation/u);
  assert.equal(records.page(before.url).kept, true);
  const stale = { url: before.url, title: before.title, status: 'queued', attempts: 2, createdAt: 20, updatedAt: 20, lastAttemptAt: 20 };
  assert.throws(() => records.run({ op: 'setJob', create: 'false', entry: stale }), /Invalid active library operation/u);
  assert.throws(() => records.run({ op: 'save', record: { ...before, text: 'Partial capture' }, options: { captureEntry: { ...stale, payload: { url: stale.url } } } }), /Invalid active library operation/u);
  assert.equal(records.page(before.url).text, before.text);
  assert.equal(records.job(before.url), undefined);
  assert.equal(records.run({ op: 'setJob', create: false, entry: stale }), false);
});

test('Ask recent full-page reads reject a concurrent change rather than mixing metadata with different content', async context => {
  const { records } = await fixture(context);
  const paths = Array.from({ length: 67 }, (_, index) => String(200 + index));
  for (const path of paths) records.save(record(path));
  let changed = false;
  const { createSqliteBackend } = await loadSource('src/background/storage/sqlite.ts', '', { '../offscreen/index': {
    ensureOffscreenDocument: async () => {},
    sendOffscreenMessage: async ({ request }) => {
      const value = records.run(request.action);
      if (!changed) { changed = true; records.save({ ...record('200'), text: 'Newer evidence on the final batch' }); }
      return { value };
    }
  } });
  const backend = createSqliteBackend(id, { listLogs: async () => [], clearLogs: async () => {} });
  await assert.rejects(backend.listRecentPages(67), /library changed during the scan/u);
  const snapshot = await backend.listRecentPages(67);
  assert.deepEqual(Array.from(snapshot, page => page.url), paths.toReversed().map(path => source + path));
  assert.equal(snapshot.at(-1).text, 'Newer evidence on the final batch');
});

test('active SQLite export cursors preserve the backup format order for raw Unicode URLs', async context => {
  const { records } = await fixture(context);
  const { BackupFrameDecoder, encodePageFrames, FRAMED_BACKUP_HEADER } = await loadSource('src/shared/backupFrames.ts');
  const supplementary = record('\u{10000}'), privateUse = record('\uE000');
  records.save(privateUse);
  records.save(supplementary);
  const decoder = new BackupFrameDecoder();
  decoder.consume(FRAMED_BACKUP_HEADER);
  const pages = [];
  let after;
  for (;;) {
    const batch = records.batch('pages', after, 1);
    const page = batch.records[0];
    if (!page) break;
    pages.push(page.url);
    for (const frame of encodePageFrames(page)) decoder.consume(frame);
    after = page.url;
  }
  decoder.consume('{"type":"end","pages":2}');
  decoder.finish();
  assert.deepEqual(pages, [supplementary.url, privateUse.url]);
});
