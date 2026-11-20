import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { assertCapturedPage, assertRetainedPages, assertIndexedChunks, inspectCaptureStore, requireRecoveryIdentity, durationSummary } from '../scripts/lib/capture-qualification.mjs';
import { assertBackupEvidence, backupEvidence } from '../scripts/lib/backup-qualification.mjs';

test('qualification fails promptly rather than claiming an empty queue when the expected store is missing', { timeout: 2000 }, async () => {
  const indexedDB = new IDBFactory();
  await new Promise((resolve, reject) => {
    const request = indexedDB.open('webRecallBeta');
    request.onupgradeneeded = () => request.result.createObjectStore('pages');
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const page = { evaluate: (read, args) => runInNewContext(`(${read})(args)`, { indexedDB, args }) };
  await assert.rejects(inspectCaptureStore(page, 'processing', { count: true }), { name: 'NotFoundError' });
});

test('backup qualification rejects lost evidence and changed version relationships, not record ordering', () => {
  const first = { id: 'current', current: true, timestamp: 42, kept: false, hash: 'authored-current-digest' };
  const older = { id: 'historical', current: false, timestamp: 21, kept: true, hash: 'authored-historical-digest' };
  const expected = [{ url: 'https://fixture.test/history', snapshots: [first, older] }];
  assert.doesNotThrow(() => assertBackupEvidence(expected, [{ ...expected[0], snapshots: [older, first] }]));
  for (const snapshots of [
    [first], [first, { ...older, kept: false }], [first, { ...older, current: true }],
    [first, { ...older, timestamp: 42 }], [first, { ...older, hash: first.hash }],
    [first, { ...older, id: first.id }]
  ]) assert.throws(() => assertBackupEvidence(expected, [{ ...expected[0], snapshots }]), /version identities|saved evidence/);
  assert.throws(() => assertBackupEvidence(expected, []), /Restored URLs/);
});

test('backup evidence keeps absent optional metadata equivalent across browser transports without treating a Keep change as equal', async () => {
  const source = { url: 'https://fixture.test/legacy', title: 'Imported article', text: 'Original notes', timestamp: 17 };
  const observed = await backupEvidence([source]);
  const debuggerReply = JSON.parse(JSON.stringify(observed));
  assert.doesNotThrow(() => assertBackupEvidence(structuredClone(observed), debuggerReply));
  await assert.rejects(async () => assertBackupEvidence(observed, await backupEvidence([{ ...source, kept: false }])),
    /saved evidence or version relationship changed/);
});

const saved = { url: 'https://saved.test/field-notes#observations', title: 'Coastal field notes', text: 'Three nights revealed the faint object.', timestamp: 0, manual: false, firstCapturedAt: 0, versionId: 'original', chunks: [{ text: 'Three nights revealed the faint object.', embedding: [0.25, 0.75], embeddingKey: 'observations' }], summary: 'A field observation.', versions: [
  { versionId: 'older', timestamp: -10, title: 'Earlier field notes', text: 'An earlier observation.', chunks: [], summary: 'Earlier notes.', kept: true },
  { versionId: 'oldest', timestamp: -20, title: 'First field notes', text: 'The first observation.', chunks: [], kept: true }
] };

test('qualification checks authored capture evidence and notices rather than trusting the returned success flag', () => {
  const scenario = { kind: 'article', title: saved.title, required: ['Three nights'], absent: ['Commercial offer'], partial: true };
  const page = { ...saved, captureInfo: { source: 'article', warnings: ['Embedded material was not saved.'] } };
  assert.doesNotThrow(() => assertCapturedPage(page, scenario, saved.url));
  const complete = { ...scenario, partial: false };
  assert.doesNotThrow(() => assertCapturedPage({ ...page, captureInfo: { source: 'article', warnings: [] } }, complete, saved.url));
  assert.throws(() => assertCapturedPage(page, complete, saved.url), /capture limitations/);
  for (const change of [{ text: 'Unrelated text' }, { text: saved.text + ' Commercial offer' }, { timestamp: NaN }, { url: 'https://saved.test/unrelated' }, { captureInfo: { source: 'article', warnings: [] } }]) assert.throws(() => assertCapturedPage({ ...page, ...change }, scenario, saved.url));
});

test('restart and upgrade qualification rejects data loss, substitution, duplication and broken saved-version relationships', () => {
  const original = structuredClone(saved);
  const recovered = { ...structuredClone(saved), internalRevision: 'new storage layout', versions: [...saved.versions].reverse() };
  assert.doesNotThrow(() => assertRetainedPages([original], [recovered]));
  for (const change of [{ text: 'Substituted page' }, { timestamp: 1 }, { manual: true }, { summary: undefined }, { firstCapturedAt: 1 }, { versionId: 'replacement' }, { chunks: [{ ...saved.chunks[0], embedding: [] }] }, { versions: saved.versions.slice(1) }, { versions: saved.versions.map(version => ({ ...version, kept: false })) }, { versions: saved.versions.map(version => ({ ...version, text: 'Substituted history' })) }]) assert.throws(() => assertRetainedPages([original], [{ ...structuredClone(saved), ...change }]));
  assert.throws(() => assertRetainedPages([original], []), /lose or duplicate/);
  assert.throws(() => assertRetainedPages([original], [original, original]), /lose or duplicate/);
  assert.throws(() => assertRetainedPages([original], [{ ...saved, url: 'https://saved.test/other' }]), /missing/);
});

test('capture duration summaries keep every sample and refuse missing or invalid timing evidence', () => {
  assert.deepEqual(durationSummary(Array.from({ length: 20 }, (_, index) => index + 1)), { count: 20, p50Ms: 10, p95Ms: 19, maxMs: 20 });
  for (const samples of [[], [1, NaN], [1, null], [1, -1], [1, Infinity]]) assert.throws(() => durationSummary(samples), /finite completed measurement/);
});

test('recovery qualification cannot treat two absent identities as a preserved saved version or admission', () => {
  for (const value of [undefined, null, '', '  ', 0, false, {}]) assert.throws(() => requireRecoveryIdentity(value, 'Current saved identity'), /nonempty saved identity/);
  assert.equal(requireRecoveryIdentity('saved-version-before-crash', 'Current saved identity'), 'saved-version-before-crash');
});

test('recovery qualification rejects swapped, duplicated or missing vectors even when all saved text is correct', () => {
  const texts = ['First saved section.', 'Last saved section.'];
  const vectors = [[1, 2], [2, 3]];
  const chunks = [{ text: texts[0], embedding: [1, 2], embeddingKey: 'fixture-space' }, { text: texts[1], embedding: [2, 3], embeddingKey: 'fixture-space' }];
  assert.doesNotThrow(() => assertIndexedChunks(chunks, texts, vectors, 'fixture-space'));
  for (const change of [
    [{ ...chunks[0], embedding: [2, 3] }, { ...chunks[1], embedding: [1, 2] }],
    [chunks[0], { ...chunks[1], embedding: [1, 2] }],
    [chunks[0], { ...chunks[1], embedding: [] }],
    [chunks[0], { ...chunks[1], embeddingKey: 'another-space' }],
    [{ ...chunks[0], text: texts[1] }, chunks[1]],
    [chunks[0]]
  ]) assert.throws(() => assertIndexedChunks(change, texts, vectors, 'fixture-space'));
});

test('qualification setup failures persist a failed report and clean allocated temporary resources', async testContext => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-recall-qualification-cli-test-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const baseline = path.join(directory, 'baseline.zip'), baselineBytes = 'Independent baseline checksum fixture';
  await writeFile(baseline, baselineBytes);
  const checksum = createHash('sha256').update(baselineBytes).digest('hex');
  const invalid = path.join(directory, 'invalid.zip'); await writeFile(invalid, 'Not an extension ZIP');
  for (const [name, candidate] of [['missing', path.join(directory, 'missing.zip')], ['invalid', invalid]]) {
    const reportFile = path.join(directory, `${name}.json`);
    const result = spawnSync(process.execPath, ['scripts/qualify-capture.mjs', `--candidate=${candidate}`, `--baseline=${baseline}`, `--baseline-sha256=${checksum}`, `--report=${reportFile}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assert.equal(result.error, undefined, result.stderr);
    assert.notEqual(result.status, 0, 'A failed package setup must not return success');
    const report = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.equal(report.passed, false); assert.ok(report.error); assert.deepEqual(report.phases, []); assert.deepEqual(report.cleanupErrors, []);
    if (report.ownedDirectory) await assert.rejects(stat(report.ownedDirectory), { code: 'ENOENT' });
  }
});

test('qualification never overwrites an existing user-supplied report', async testContext => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-recall-qualification-report-test-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'report.json'), contents = 'Earlier qualification evidence';
  await writeFile(report, contents);
  const result = spawnSync(process.execPath, ['scripts/qualify-capture.mjs', '--baseline=unused.zip', `--baseline-sha256=${'a'.repeat(64)}`, `--report=${report}`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assert.equal(result.error, undefined); assert.notEqual(result.status, 0);
  assert.equal(await readFile(report, 'utf8'), contents);
});
