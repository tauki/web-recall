import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { providerFixture } from './provider-fixture.mjs';
import { loadSource, tick } from './helpers.mjs';

const page = { url: 'https://saved.test/article#evidence', title: 'Saved field notes', text: 'Original saved observation.', timestamp: 10, manual: true, chunks: [] };
async function backendWithPage(record = page) {
  const backend = providerFixture('http://localhost:11434');
  const database = await backend.load('src/shared/db/index.ts');
  await database.savePageRecord(record);
  await backend.connect();
  return { ...backend, database };
}

test('saved reading returns the whole captured text, not its summary or a clipped preview', async () => {
  const text = 'Opening context.\n'.repeat(150) + 'A copper tern nests here.\nThe surrounding evidence remains available.';
  const backend = await backendWithPage({ ...page, text, summary: 'A short summary.', chunks: [{ text, embedding: [0.2, 0.8] }] });
  const response = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, timestamp: page.timestamp, query: '"copper tern"' });
  assert.equal(response.page.text, text);
  assert.equal(response.page.timestamp, 10);
  assert.equal(response.page.url, page.url);
  assert.equal(text.slice(response.page.match.start, response.page.match.end), 'copper tern');
  assert.equal('chunks' in response.page, false, 'The reader must not transfer vectors');
  assert.equal(backend.requests.length, 0, 'Reading a capture must not contact a model or the live site');
});

test('timestamp-only reading cannot choose between title-distinct versions with identical body and time', async () => {
  const backend = await backendWithPage({ ...page, versionId: 'current-title', versions: [{ versionId: 'earlier-title', title: 'Earlier field notes', timestamp: page.timestamp, text: page.text, chunks: [] }] });
  const ambiguous = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, timestamp: page.timestamp });
  assert.match(ambiguous.error, /Several captures share this time/);
  assert.equal(ambiguous.page, undefined);
  const exact = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, versionId: 'earlier-title' });
  assert.equal(exact.page.title, 'Earlier field notes');
  assert.equal(exact.page.text, page.text);
  assert.equal(backend.requests.length, 0);
});

test('saved previews use the matched version summary and limitations instead of the current replacement', async () => {
  const captureInfo = { source: 'main', warnings: ['Collapsed replies were not captured.'] };
  const backend = await backendWithPage({ ...page, versionId: 'current', text: 'Replacement text.', summary: 'Replacement overview.', versions: [{ versionId: 'earlier', title: 'Earlier notes', timestamp: 1, text: 'Original text.', summary: 'Earlier overview.', chunks: [], captureInfo }] });
  const earlier = await backend.send({ type: 'GET_PAGE_PREVIEW', url: page.url, timestamp: 1, versionId: 'earlier' });
  assert.equal(earlier.page.title, 'Earlier notes');
  assert.equal(earlier.page.snippet, 'Earlier overview.');
  assert.equal(earlier.page.previewKind, 'summary');
  assert.equal(earlier.page.versionId, 'earlier');
  assert.equal(earlier.page.timestamp, 1);
  assert.deepEqual(earlier.page.captureInfo, captureInfo);
  const missing = await backend.send({ type: 'GET_PAGE_PREVIEW', url: page.url, versionId: 'removed' });
  assert.match(missing.error, /no longer available/);
  assert.equal(missing.page, undefined);
  assert.equal((await backend.send({ type: 'GET_PAGE_PREVIEW', url: page.url })).page.snippet, 'Replacement overview.');
  assert.equal(backend.requests.length, 0);
});

test('opening an earlier retained capture returns that capture rather than newer page text', async () => {
  const backend = await backendWithPage({ ...page, timestamp: 20, text: 'A changed live article.', versions: [{ timestamp: 10, text: 'The original evidence.', chunks: [] }] });
  const response = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, timestamp: 10 });
  assert.equal(response.page.text, 'The original evidence.');
  assert.equal(response.page.current, false);
  assert.equal(response.page.timestamp, 10);
});

test('the reader highlights the complete matching phrase rather than an unrelated earlier keyword', async () => {
  const text = 'Copper is a metal. Much later, the copper tern migration is discussed.';
  const backend = await backendWithPage({ ...page, text });
  const { page: snapshot } = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, query: 'copper tern' });
  assert.equal(text.slice(snapshot.match.start, snapshot.match.end), 'copper tern');
  assert.ok(snapshot.match.start > text.indexOf('Much later'));
});

test('deleted or missing capture versions produce actionable errors, never substitute unrelated text', async () => {
  const backend = await backendWithPage();
  const missingVersion = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, timestamp: 99 });
  assert.match(missingVersion.error, /capture is no longer available.*Search again/);
  await backend.database.deletePages([page.url]);
  const deleted = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url });
  assert.match(deleted.error, /page is no longer available/);
  assert.equal(deleted.page, undefined);
});

test('saved readers retain fragment identity and exclude webpage senders', async () => {
  const backend = await backendWithPage();
  const other = await backend.send({ type: 'GET_SAVED_PAGE', url: 'https://saved.test/article#other' });
  assert.match(other.error, /no longer available/);
  const denied = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url }, { id: backend.runtime.id, url: 'https://untrusted.test/' });
  assert.match(denied.error, /Only Web Recall extension pages/);
  assert.equal(denied.page, undefined);
});

test('a semantic-only result opens its retrieved chunk rather than the beginning of the saved page', async () => {
  const opening = 'Unrelated opening context.\n'.repeat(160);
  const evidence = 'The birds stay on remote islands throughout the colder months.';
  const text = opening + '\n' + evidence + '\nSurrounding saved context.';
  const backend = await backendWithPage({ ...page, text, chunks: [{ text: opening.trim().replace(/\s+/g, ' '), embedding: [] }, { text: evidence, embedding: [] }, { text: 'Surrounding saved context.', embedding: [] }] });
  const response = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, timestamp: 10, query: 'wintering habitat', chunkIndex: 1 });
  assert.equal(response.error, undefined);
  assert.equal(response.page.match?.start, text.indexOf(evidence));
  assert.equal(text.slice(response.page.match.start, response.page.match.end), evidence);
});

test('a repeated stored passage opens the selected occurrence, not the first identical paragraph', async () => {
  const evidence = 'The same saved paragraph.';
  const text = evidence + '\n\n' + evidence + '\n\nClosing context.';
  const backend = await backendWithPage({ ...page, text, chunks: [{ text: evidence, embedding: [] }, { text: evidence, embedding: [] }] });
  const response = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, chunkIndex: 1, query: 'vague recollection' });
  assert.equal(response.page.match.start, text.lastIndexOf(evidence));
});

test('semantic passage locations preserve original code whitespace and literal quote characters', async () => {
  const code = 'const config = {\n  "enabled": true\n};';
  const text = 'Saved code follows.\n\n' + code + '\n\nClosing context.';
  const backend = await backendWithPage({ ...page, text, chunks: [{ text: 'Saved code follows.', embedding: [] }, { text: code.replace(/\s+/g, ' '), embedding: [] }] });
  const response = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, chunkIndex: 1, query: 'configuration example' });
  assert.equal(text.slice(response.page.match.start, response.page.match.end), code);
});

test('invalid semantic passage indices fail instead of opening unrelated saved text', async () => {
  const backend = await backendWithPage();
  for (const chunkIndex of [-1, 0, 1.5, '0']) {
    const response = await backend.send({ type: 'GET_SAVED_PAGE', url: page.url, chunkIndex });
    assert.match(response.error, /saved passage is no longer available/);
    assert.equal(response.page, undefined);
  }
});

async function readerFixture(response) {
  const dom = new JSDOM('<section id="reader"></section>', { url: 'https://extension.test' });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const messages = [];
  const chrome = { runtime: { getURL: value => value, sendMessage(message, done) { messages.push(message); Promise.resolve(typeof response === 'function' ? response(message) : response).then(done); } } };
  const { createSavedReader } = await loadSource('src/ui/shared/savedReader.ts', '', {}, { chrome, window, document: window.document, HTMLElement: window.HTMLElement });
  const host = window.document.querySelector('#reader');
  let closed = false;
  const reader = createSavedReader(host, () => { closed = true; });
  return { host, reader, messages, window, closed: () => closed, close: () => window.close() };
}

test('the saved reader highlights original evidence while rendering captured HTML as inert text', async t => {
  const text = 'Context before. <img src="https://tracker.test/" onerror="alert(1)"> Copper tern. Context after.';
  const start = text.indexOf('Copper tern');
  const fixture = await readerFixture({ page: { ...page, text, current: true, match: { field: 'text', start, end: start + 'Copper tern'.length } } }); t.after(fixture.close);
  await fixture.reader.open(page.url, 10, 'copper tern');
  assert.equal(fixture.host.querySelector('[aria-label="Saved page text"]').textContent, text);
  assert.equal(fixture.host.querySelector('mark').textContent, 'Copper tern');
  assert.equal(fixture.host.querySelector('img'), null);
  assert.equal(fixture.host.querySelector('.saved-reader-live').href, page.url);
  assert.match(fixture.host.textContent, /Saved capture/);
  fixture.host.querySelector('.saved-reader-back').click();
  assert.equal(fixture.host.hidden, true);
  assert.equal(fixture.closed(), true);
});

test('closing a reader before its database reply cannot reopen or replace the current view', async t => {
  let finish;
  const reply = new Promise(resolve => { finish = resolve; });
  const fixture = await readerFixture(() => reply); t.after(fixture.close);
  const pending = fixture.reader.open(page.url);
  fixture.reader.close();
  finish({ page: { ...page, current: true } }); await pending; await tick();
  assert.equal(fixture.host.hidden, true);
  assert.equal(fixture.host.textContent, '');
});

test('reader errors retain a working return action and do not open a live page automatically', async t => {
  const fixture = await readerFixture({ error: 'This saved capture is no longer available. Search again.' }); t.after(fixture.close);
  await fixture.reader.open(page.url, 10);
  assert.match(fixture.host.textContent, /unavailable.*no longer available/);
  assert.equal(fixture.host.querySelector('.saved-reader-live'), null);
  fixture.host.querySelector('.saved-reader-back').click();
  assert.equal(fixture.closed(), true);
});
