import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers.mjs';

const url = 'https://example.test/saved';
const saved = { url, title: 'Saved article', timestamp: 1, text: 'A'.repeat(5000), summary: 'Saved summary', chunks: [{ text: 'A'.repeat(5000) }, { text: 'Second passage' }] };
async function fixture(options = {}) {
  const { ToolsRuntime } = await loadSource('src/shared/tools/runtime.ts');
  return new ToolsRuntime({ allowedUrls: new Set([url]), pageText: new Map([[url, saved.text]]), pages: [saved], maxSlice: 1200, searchMemory: async () => [], ...options });
}
const run = async (runtime, name, args) => JSON.parse((await runtime.runToolCall(name, args)).content);

test('repeating invalid tool arguments preserves failure instead of inventing a successful result', async () => {
  const runtime = await fixture();
  const first = await run(runtime, 'fetch_more', {});
  const again = await run(runtime, 'fetch_more', {});
  assert.equal(first.ok, false);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'invalid_args');
});

test('repeating a successful read returns its evidence and source identity, including reordered arguments', async () => {
  const runtime = await fixture({ recordEvidence: () => 7 });
  const first = await run(runtime, 'fetch_more', { url, chunkIndex: 1 });
  const identical = await run(runtime, 'fetch_more', { url, chunkIndex: 1 });
  const again = await run(runtime, 'fetch_more', { chunkIndex: 1, url });
  assert.equal(first.data.text, 'Second passage');
  assert.equal(again.data.text, first.data.text);
  assert.equal(again.data.sourceIndex, first.data.sourceIndex);
  assert.equal(identical.data.text, first.data.text);
});

test('a transient search failure can be retried rather than being cached as success or failure', async () => {
  let unavailable = true;
  const search = async () => { if (unavailable) throw Error('temporarily unavailable'); return [{ url, title: saved.title, snippet: 'Recovered evidence' }]; };
  const runtime = await fixture({ searchMemory: search });
  assert.equal((await run(runtime, 'search_memory', { query: 'evidence' })).ok, false);
  unavailable = false;
  const recovered = await run(runtime, 'search_memory', { query: 'evidence' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data[0].snippet, 'Recovered evidence');
});

test('chunk, neighborhood and raw-range reads are bounded and their continuations reconstruct the requested text', async () => {
  for (const args of [{ url, chunkIndex: 0 }, { url, aroundChunkIndex: 0, radius: 0 }, { url, start: 0, end: saved.text.length }]) {
    const runtime = await fixture();
    let next = args, reconstructed = '', reads = 0;
    while (next) {
      const result = await run(runtime, 'fetch_more', next);
      assert.equal(result.ok, true);
      assert.ok(result.data.text.length <= 1200, 'a read must fit the advertised per-result bound');
      reconstructed += result.data.text;
      next = result.nextArgs;
      assert.ok(++reads < 10, 'every continuation must advance');
    }
    assert.equal(reconstructed, saved.text);
  }
});

test('missing passages and non-finite offsets are errors, not successful empty evidence', async () => {
  const runtime = await fixture();
  assert.equal((await run(runtime, 'fetch_more', { url, chunkIndex: 99 })).ok, false);
  assert.equal((await run(runtime, 'fetch_more', { url, chunkIndex: 0, offset: NaN })).ok, false);
});

test('one tool-call allowance cannot execute two requests, and emits correlated lifecycle events', async () => {
  const activity = [];
  const runtime = await fixture({ maxCalls: 1, onActivity: event => activity.push(event) });
  assert.equal((await run(runtime, 'fetch_more', { url, chunkIndex: 1 })).ok, true);
  const excess = await run(runtime, 'get_page_summary', { url });
  assert.equal(excess.ok, false);
  assert.equal(excess.error.code, 'tool_budget_exhausted');
  assert.equal(activity[0].status, 'started');
  assert.equal(activity[1].status, 'completed');
  assert.equal(activity[0].callId, activity[1].callId);
});

test('page tools load only the requested authorized record, not an entire library', async () => {
  const reads = [];
  const runtime = await fixture({ pages: [], pageText: new Map(), loadPage: async requested => { reads.push(requested); return saved; } });
  const result = await run(runtime, 'fetch_more', { url, chunkIndex: 1 });
  assert.equal(result.data.text, 'Second passage');
  assert.deepEqual(reads, [url]);
  const outside = await run(runtime, 'fetch_more', { url: 'https://outside.test/private', chunkIndex: 0 });
  assert.equal(outside.ok, false);
  assert.deepEqual(reads, [url], 'scope must be checked before loading a record');
});

test('finding text late in a large saved chunk gives a bounded read offset that reaches the actual match', async () => {
  const text = 'Background section. '.repeat(250) + '\nThe rollout code is MAPLE-42.\nMore details.';
  const runtime = await fixture({ pages: [{ ...saved, text, chunks: [{ text }] }], pageText: new Map([[url, text]]) });
  const found = await run(runtime, 'search_within_page', { url, query: 'rollout code' });
  assert.match(found.data.matches[0].snippet, /MAPLE-42/);
  assert.ok(found.data.matches[0].offset > 0);
  const read = await run(runtime, 'fetch_more', { url, chunkIndex: found.data.matches[0].chunkIndex, offset: found.data.matches[0].offset });
  assert.match(read.data.text, /MAPLE-42/);
  assert.ok(read.data.text.length <= 1200);
});

test('case-insensitive Unicode matches lead back to the original saved passage for exact and token searches', async () => {
  for (const prefix of ['İstanbul '.repeat(120), '😀 İSTANBUL ΣΟΣ '.repeat(120)]) {
    const text = prefix + 'The rollout code is MAPLE-42. More details.';
    for (const query of ['MAPLE-42', 'MAPLE-42 absentword']) {
      const runtime = await fixture({ pages: [{ ...saved, text, chunks: [{ text }] }], pageText: new Map([[url, text]]) });
      const found = await run(runtime, 'search_within_page', { url, query });
      assert.equal(found.ok, true);
      assert.equal(found.data.matches.length, 1, `A saved match must not disappear for ${query}`);
      const match = found.data.matches[0];
      assert.match(match.snippet, /MAPLE-42/);
      assert.ok(match.offset >= 0 && match.offset < text.length);
      const read = await run(runtime, 'fetch_more', { url, chunkIndex: match.chunkIndex, offset: match.offset });
      assert.equal(read.ok, true);
      assert.match(read.data.text, /MAPLE-42/);
      assert.ok(read.data.text.length <= 1200);
    }
  }
});

test('a query matching an expanded lowercase character still previews the original Unicode text', async () => {
  const text = '😀 Background. '.repeat(120) + 'İstanbul holds the saved evidence.';
  const runtime = await fixture({ pages: [{ ...saved, text, chunks: [{ text }] }], pageText: new Map([[url, text]]) });
  const found = await run(runtime, 'search_within_page', { url, query: 'i\u0307stanbul' });
  assert.equal(found.data.matches.length, 1);
  assert.match(found.data.matches[0].snippet, /İstanbul/);
  const read = await run(runtime, 'fetch_more', { url, chunkIndex: found.data.matches[0].chunkIndex, offset: found.data.matches[0].offset });
  assert.match(read.data.text, /İstanbul/);
});

test('concurrent page tools share one authorized snapshot and keep distinct invocation identities', async () => {
  let reads = 0, release;
  const waiting = new Promise(resolve => { release = resolve; }), events = [];
  const runtime = await fixture({ pages: [], pageText: new Map(), loadPage: async () => { reads++; await waiting; return saved; }, onActivity: event => events.push(event) });
  const read = runtime.runToolCall('fetch_more', { url, chunkIndex: 1 }, 'read');
  const summary = runtime.runToolCall('get_page_summary', { url }, 'summary');
  release();
  assert.equal(JSON.parse((await read).content).data.text, 'Second passage');
  assert.equal(JSON.parse((await summary).content).data.summary, 'Saved summary');
  assert.equal(reads, 1);
  assert.deepEqual(events.filter(event => event.status === 'completed').map(event => event.callId).sort(), ['read', 'summary']);
});

test('memory pagination preserves already-delivered ranking and reaches later pages without duplicate sources', async () => {
  const records = Array.from({ length: 65 }, (_, index) => ({ url: `https://example.test/${index}`, title: `Saved ${index}`, snippet: `Evidence ${index}` }));
  let searches = 0;
  const runtime = await fixture({ allowedUrls: new Set(), allowSearchDiscovery: true, searchMemory: async (_query, size) => { searches++; const found = records.slice(0, size); return searches % 2 ? found : found.reverse(); } });
  const seen = [];
  let args = { query: 'evidence', k: 10 };
  while (args) {
    const page = await run(runtime, 'search_memory', args);
    assert.equal(page.ok, true); assert.ok(page.data.length <= 10);
    seen.push(...page.data.map(hit => hit.url)); args = page.nextArgs;
    assert.ok(searches < 12, 'pagination must advance');
  }
  assert.equal(new Set(seen).size, records.length);
  assert.equal(seen.length, records.length);
});

test('repeated unchanged reads signal stalled work without losing their real evidence or inventing success', async () => {
  const runtime = await fixture({ recordEvidence: () => 7 });
  const first = await run(runtime, 'fetch_more', { url, chunkIndex: 0, offset: 0, limit: 200 });
  let stalled;
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = await run(runtime, 'fetch_more', { url, chunkIndex: 0, offset: 0, limit: 200 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, first.data);
    assert.equal(result.newInformation, false);
    assert.ok(result.nextArgs.offset > 0);
    if (result.control?.noProgress) { stalled = result; break; }
  }
  assert.ok(stalled, 'a repeated read must be identified before spending the whole safety allowance');
  assert.equal(runtime.progressCount, 1);
  const continued = await run(runtime, 'fetch_more', stalled.nextArgs);
  assert.equal(continued.newInformation, true);
  assert.ok(continued.data.offset > 0);
});

test('alternating already-completed tools cannot disguise stalled research as new information', async () => {
  const runtime = await fixture();
  const calls = [['get_page_summary', { url }], ['get_page_chunks', { url }], ['fetch_more', { url, chunkIndex: 1 }]];
  for (const [name, args] of calls) await run(runtime, name, args);
  let stalled;
  for (let attempt = 0; attempt < 9; attempt++) {
    const [name, args] = calls[attempt % calls.length];
    const result = await run(runtime, name, args);
    assert.equal(result.ok, true);
    assert.equal(result.newInformation, false);
    if (result.control?.noProgress) { stalled = result; break; }
  }
  assert.ok(stalled, 'switching among cached tools must not reset the no-progress detector');
  assert.equal(runtime.progressCount, calls.length);
});
