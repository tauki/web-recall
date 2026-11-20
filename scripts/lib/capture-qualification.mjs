import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const fingerprint = value => createHash('sha256').update(value).digest('hex');

export async function withObservationDeadline(operation, label, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error(`Qualification observation expired: ${label}`)), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

export function inspectCaptureStore(page, storeName, { key, count = false, jobIdentities = false } = {}) {
  return withObservationDeadline(() => page.evaluate(({ storeName, key, count, jobIdentities }) => new Promise((resolve, reject) => {
    const open = indexedDB.open('webRecallBeta');
    open.onerror = () => reject(open.error);
    open.onupgradeneeded = () => open.transaction.abort();
    open.onsuccess = () => {
      const database = open.result;
      try {
        const transaction = database.transaction(storeName);
        const store = transaction.objectStore(storeName);
        let result;
        if (jobIdentities) {
          const jobs = [];
          const request = store.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const entry = cursor.value;
            jobs.push({ url: entry.url, status: entry.status, textSaved: entry.textSaved, error: entry.error, captureId: entry.payload?.captureId });
            cursor.continue();
          };
          result = jobs;
        } else {
          const request = count ? store.count() : store.get(key);
          request.onsuccess = () => { result = request.result; };
        }
        transaction.oncomplete = () => { database.close(); resolve(result); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      } catch (error) {
        database.close();
        reject(error);
      }
    };
  }), { storeName, key, count, jobIdentities }), `inspect saved ${storeName}`);
}

export function requireRecoveryIdentity(value, label) {
  assert.ok(typeof value === 'string' && value.trim().length > 0, `${label} must be a nonempty saved identity`);
  return value;
}

export function assertIndexedChunks(chunks, expectedTexts, expectedVectors, expectedKey) {
  assert.equal(expectedVectors.length, expectedTexts.length, 'Every authored section needs its own expected vector');
  assert.equal(chunks.length, expectedTexts.length, 'Every saved section must be retained after indexing');
  for (const [index, text] of expectedTexts.entries()) {
    assert.equal(chunks[index].text, text, `Saved section ${index + 1} changed`);
    assert.deepEqual(chunks[index].embedding, expectedVectors[index], `Saved section ${index + 1} received another section’s vector`);
    assert.equal(chunks[index].embeddingKey, expectedKey, `Saved section ${index + 1} changed embedding space`);
  }
}

export function assertCapturedPage(page, scenario, url) {
  assert.equal(page.url, url, 'Capture must retain the actual visited URL');
  assert.equal(page.title, scenario.title, 'Capture must retain the document title');
  assert.ok(Number.isFinite(page.timestamp), 'Capture must expose a saved time');
  if (typeof scenario.partial === 'boolean') assert.equal(Boolean(page.captureInfo?.warnings?.length), scenario.partial, `${scenario.kind}: capture limitations must describe the selected content, not unrelated page widgets`);
  for (const fragment of scenario.required) assert.ok(page.text.includes(fragment), `${scenario.kind}: saved text is missing ${JSON.stringify(fragment)}`);
  for (const fragment of scenario.absent) assert.ok(!page.text.includes(fragment), `${scenario.kind}: excluded page furniture leaked into saved text: ${fragment}`);
}

export function assertRetainedPages(before, after) {
  assert.equal(after.length, before.length, 'Restart/upgrade must not lose or duplicate acknowledged pages');
  assert.equal(new Set(after.map(page => page.url)).size, after.length, 'Saved URLs must remain unique');
  for (const expected of before) {
    const actual = after.find(page => page.url === expected.url);
    assert.ok(actual, `Acknowledged page is missing: ${expected.url}`);
    for (const field of ['title', 'text', 'timestamp', 'manual', 'chunks', 'summary', 'versionId', 'firstCapturedAt', 'lastVisitedAt', 'lastEmbeddedAt', 'createdAt', 'kept', 'captureInfo']) {
      if (Object.hasOwn(expected, field)) assert.deepEqual(actual[field], expected[field], `${expected.url}: preserved ${field} changed`);
    }
    const versions = expected.versions || [];
    assert.equal((actual.versions || []).length, versions.length, `${expected.url}: saved history changed`);
    for (const version of versions) {
      const retained = actual.versions.find(candidate => version.versionId ? candidate.versionId === version.versionId : candidate.timestamp === version.timestamp && candidate.text === version.text && candidate.title === version.title);
      assert.ok(retained, `${expected.url}: historical evidence is missing`);
      for (const field of ['title', 'text', 'timestamp', 'chunks', 'summary', 'versionId', 'kept', 'captureInfo']) if (Object.hasOwn(version, field)) assert.deepEqual(retained[field], version[field], `${expected.url}: historical ${field} changed`);
    }
  }
}

export function durationSummary(samples) {
  assert.ok(samples.length && samples.every(value => Number.isFinite(value) && value >= 0), 'Every capture needs a finite completed measurement');
  const sorted = [...samples].sort((first, second) => first - second);
  return { count: sorted.length, p50Ms: sorted[Math.ceil(sorted.length / 2) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1) };
}
