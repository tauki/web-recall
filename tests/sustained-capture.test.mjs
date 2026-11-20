import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, withObservationDeadline } from '../scripts/lib/capture-qualification.mjs';
import { assertSustainedIndex, assertSustainedProvider, sustainedFixture, SUSTAINED_COUNT } from '../scripts/lib/sustained-capture.mjs';

test('sustained fixtures yield unique complete documents, including long pages and body-only match phrases', () => {
  const fixtures = Array.from({ length: SUSTAINED_COUNT }, (_, index) => sustainedFixture(index));
  assert.equal(new Set(fixtures.map(fixture => fixture.phrase)).size, fixtures.length);
  assert.ok(fixtures.some(fixture => Buffer.byteLength(fixture.normalizedText) > 64 * 1024));
  assert.ok(fixtures.some(fixture => Buffer.byteLength(fixture.normalizedText) < 8 * 1024));
  for (const [index, fixture] of fixtures.entries()) {
    assert.doesNotMatch(fixture.title, /quartz ribbon/u);
    assert.ok(fixture.normalizedText.includes(fixture.phrase));
    assert.ok(fixture.normalizedText.endsWith(`End of the retained survey for harbor report ${index}.`));
  }
});

test('sustained provider verification rejects incomplete content and missing, reordered or extra attempts per page', () => {
  const accepted = { body: { input: ['Full opening with unique harbor ledger 37 quartz ribbon', 'covering the entire saved record.'] }, state: 'completed' };
  const fixture = { phrase: 'unique harbor ledger 37 quartz ribbon', normalizedText: 'Full opening with unique harbor ledger 37 quartz ribbon covering the entire saved record.', chunkHashes: accepted.body.input.map(fingerprint) };
  const failed = { ...accepted, state: 'failed' };
  const verify = requests => assertSustainedProvider(requests, [fixture], () => ['failed', 'completed']);
  assert.doesNotThrow(() => verify([failed, accepted]));
  for (const attempts of [[failed], [accepted, failed], [failed, accepted, accepted]]) assert.throws(() => verify(attempts), /provider transitions/u);
  assert.throws(() => verify([failed, { ...accepted, body: { input: accepted.body.input.slice(0, 1) } }]), /incomplete or substituted/u);
  assert.throws(() => verify([failed, { ...accepted, body: { input: [fixture.normalizedText] } }]), /changed the saved chunk boundaries/u);
  assert.throws(() => verify([failed, { ...accepted, body: { input: ['unrelated response'] } }]), /did not identify/u);
});

test('sustained index verification requires matching text, stable identity, and each finite vector in the correct capture space', () => {
  const capture = { url: 'https://local.test/report', title: 'Independent field report', timestamp: 45, versionId: 'independent-version', manual: true, text: 'Alpha beta gamma', lastEmbeddedAt: 46 };
  const expected = { ...capture, index: 0, textHash: fingerprint('Alpha beta gamma') };
  const tail = Array.from({ length: 766 }, (_, index) => ((index % 256) + 1) / 256);
  const first = [1 / 256, 1 / 256, ...tail];
  const second = [1 / 256, 2 / 256, ...tail];
  const chunks = [{ text: 'Alpha beta', embedding: first, embeddingKey: 'test-embed-space' }, { text: 'gamma', embedding: second, embeddingKey: 'test-embed-space' }];
  const verify = record => assertSustainedIndex(record, expected, 'test-embed-space');
  assert.doesNotThrow(() => verify({ ...capture, chunks }));
  assert.throws(() => verify({ ...capture, manual: false, chunks }));
  assert.throws(() => verify({ ...capture, text: 'Altered text', chunks }), /text bytes changed/u);
  assert.throws(() => verify({ ...capture, timestamp: 46, chunks }));
  assert.throws(() => verify({ ...capture, versionId: 'replacement', chunks }));
  assert.throws(() => verify({ ...capture, chunks: [chunks[0], { ...chunks[1], embedding: first }] }), /incorrect vector association/u);
  const samePositionFromAnotherPage = [2 / 256, 1 / 256, ...tail];
  assert.throws(() => verify({ ...capture, chunks: [{ ...chunks[0], embedding: samePositionFromAnotherPage }, chunks[1]] }), /incorrect vector association/u);
  const previousCollision = [23 / 256, 7 / 256, ...tail];
  assert.throws(() => verify({ ...capture, chunks: [{ ...chunks[0], embedding: previousCollision }, chunks[1]] }), /incorrect vector association/u);
  assert.throws(() => verify({ ...capture, chunks: [chunks[0], { ...chunks[1], embedding: [] }] }), /incorrect vector dimensions/u);
  assert.throws(() => verify({ ...capture, chunks: [chunks[0], { ...chunks[1], embeddingKey: 'other-model' }] }), /incorrect embedding space/u);
});

test('a stalled observation fails with a bounded diagnostic instead of holding the qualification open', async () => {
  const stall = new Promise(() => {});
  await assert.rejects(withObservationDeadline(() => stall, 'waiting for save confirmation', 10), /observation expired: waiting for save confirmation/u);
  assert.equal(await withObservationDeadline(async () => 'observed', 'ready'), 'observed');
});
