import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, plain } from './helpers.mjs';

const { readGroundedAnswer, streamedAnswer } = await loadSource('src/background/ask/answer.ts');

test('an explicit insufficient-evidence outcome needs no invented reference', () => {
  assert.deepEqual(plain(readGroundedAnswer(JSON.stringify({ outcome: 'insufficient_evidence', answer: 'The saved pages do not contain that date.' }), [1])), { outcome: 'insufficient_evidence', answer: 'The saved pages do not contain that date.' });
  assert.equal(readGroundedAnswer(JSON.stringify({ outcome: 'answered', answer: 'The date is May 19.' }), [1]), null);
});

test('unknown citations cannot be approved by either outcome and known citations preserve their identity', () => {
  for (const outcome of ['answered', 'insufficient_evidence']) assert.equal(readGroundedAnswer(JSON.stringify({ outcome, answer: 'Claim [99]' }), [7]), null);
  assert.equal(readGroundedAnswer(JSON.stringify({ outcome: 'answered', answer: 'A fact [7]' }), [7]).answer, 'A fact [7]');
});

test('a truncated structured response cannot be approved as legacy text just because it contains a known citation', () => {
  assert.equal(readGroundedAnswer('{"outcome":"answered","answer":"A fact [7]', [7]), null);
});

test('streaming a structured answer reveals only its answer field across escaped and unicode fragments', () => {
  const answer = 'A café says "hello".\nFact [7]';
  const json = JSON.stringify({ outcome: 'answered', answer });
  for (let end = 1; end <= json.length; end++) {
    const partial = streamedAnswer(json.slice(0, end));
    assert.ok(answer.startsWith(partial), `unexpected partial at byte ${end}: ${partial}`);
  }
  assert.equal(streamedAnswer(json), answer);
});
