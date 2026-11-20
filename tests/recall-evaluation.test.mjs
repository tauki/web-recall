import test from 'node:test';
import assert from 'node:assert/strict';
import { latencySummary, evaluateFinding, findingSummary, matchesFixtureScope, evaluationSchedule, summarizeObservations, verifyPassage, resourceSummary, validateEvaluationSources } from '../scripts/lib/recall-evaluation.mjs';

const url = 'https://notes.benchmark.test/article';
const oracle = { topics: { article: { url } }, pages: { [url]: [{ versionId: 'current', timestamp: Date.UTC(2025, 0, 2) }, { versionId: 'earlier', timestamp: Date.UTC(2020, 0, 2) }] } };
const scenario = { id: 'known-evidence', kind: 'old-evidence', query: 'Earlier evidence', expected: ['article'], version: 'earlier' };

test('nearest-rank p95 keeps failed samples in the denominator and never certifies an empty run', () => {
  assert.equal(latencySummary(Array.from({ length: 100 }, (_, index) => index + 1), 95).p95Ms, 95);
  assert.equal(latencySummary(Array.from({ length: 20 }, (_, index) => index + 1), 19).p95Ms, 19);
  const failure = latencySummary([...Array.from({ length: 19 }, () => 1), null], 500);
  assert.equal(failure.count, 20); assert.equal(failure.failures, 1); assert.equal(failure.passed, false); assert.equal(failure.maxMs, null);
  assert.equal(latencySummary([], 500).passed, false);
  assert.equal(latencySummary([NaN, -1, Infinity], 500).p95Ms, null);
});

test('resource gates retain unknown, missing and over-budget measurements as failures', () => {
  const limits = { storageBytes: 500, activeSampleBytes: 100, idleBytes: 20 };
  const measurements = { storageBytes: 500, activeSampleBytes: 100, sampleCount: 2, initializedIdleBytes: 20, clearedIdleBytes: 15 };
  assert.equal(resourceSummary(measurements, limits).passed, true);
  for (const invalid of [{ storageBytes: 501 }, { activeSampleBytes: 101 }, { clearedIdleBytes: 21 }, { sampleCount: 0 }, { initializedIdleBytes: undefined }, { storageBytes: undefined }, { activeSampleBytes: NaN }, { clearedIdleBytes: Infinity }]) assert.equal(resourceSummary({ ...measurements, ...invalid }, limits).passed, false);
});

test('page-finding success requires top-five visible evidence, the right version and a verified saved read', () => {
  const result = { url, versionId: 'earlier', timestamp: Date.UTC(2020, 0, 2) };
  assert.equal(evaluateFinding(scenario, { results: [result], readerVerified: true }, oracle).passed, true);
  assert.equal(evaluateFinding(scenario, { results: [result], readerVerified: false }, oracle).passed, false);
  assert.equal(evaluateFinding(scenario, { results: [{ ...result, versionId: 'current', timestamp: Date.UTC(2025, 0, 2) }], readerVerified: true }, oracle).passed, false);
  const others = Array.from({ length: 5 }, (_, index) => ({ url: `https://other.test/${index}`, versionId: 'unknown', timestamp: 1 }));
  const populated = { ...oracle, pages: { ...oracle.pages, ...Object.fromEntries(others.map(row => [row.url, [{ versionId: row.versionId, timestamp: row.timestamp }]])) } };
  const sixth = evaluateFinding(scenario, { results: [...others, result], readerVerified: true }, populated);
  assert.deepEqual(sixth.violations, []); assert.equal(sixth.rank, 6); assert.equal(sixth.passed, false);
});

test('a later exact, filter or saved-reader failure cannot disappear behind the first successful round', () => {
  const first = { id: 'exact', kind: 'exact-phrase', passed: true, split: 'heldout' };
  assert.equal(summarizeObservations([first, { ...first, passed: false }], [], 'heldout').passedGate, false);
  assert.equal(summarizeObservations([first], [{ ...first, passed: false }], 'heldout').passedGate, false);
  assert.equal(summarizeObservations([first, { ...first, split: 'development' }], [], 'heldout').count, 1);
});

test('the frozen evaluation policy refuses missing categories, duplicate IDs or an incomplete cold schedule', () => {
  const categories = ['exact-title', 'exact-phrase', 'url', 'vague', 'old-evidence', 'filter'];
  const cases = (count, prefix, cold) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, kind: categories[index % categories.length], query: 'Known fixture', expected: ['article'], cold: index < cold }));
  const development = cases(40, 'dev', 12), heldout = cases(20, 'held', 8);
  assert.equal(evaluationSchedule(development, heldout, true).cold.length, 20);
  const expanded = [...heldout, ...cases(4, 'additional', 0)];
  assert.equal(evaluationSchedule(development, expanded, true).heldout, expanded.length, 'Adding independently labeled warm cases must not invalidate the frozen cold schedule');
  assert.throws(() => evaluationSchedule(development, heldout.slice(1), true), /incomplete/);
  assert.throws(() => evaluationSchedule(development.map(value => ({ ...value, kind: 'exact-title' }))), /incomplete/);
  assert.throws(() => evaluationSchedule(development.map(value => ({ ...value, cold: false }))), /incomplete/);
  assert.throws(() => evaluationSchedule([...development.slice(1), development[1]]), /incomplete/);
});

test('URL grouping is a visible contract: a duplicated URL cannot hide an incorrectly selected historical version', () => {
  const rows = [{ url, versionId: 'current', timestamp: Date.UTC(2025, 0, 2) }, { url, versionId: 'earlier', timestamp: Date.UTC(2020, 0, 2) }];
  const result = evaluateFinding(scenario, { results: rows, readerVerified: true }, oracle);
  assert.equal(result.passed, false); assert.match(result.violations.join(' '), /one saved snapshot per URL/);
});

test('fixture preflight rejects unknown topics, versions and impossible scopes before measuring product quality', () => {
  assert.doesNotThrow(() => validateEvaluationSources([scenario, { ...scenario, version: undefined }, { id: 'absent-topic-query', kind: 'empty', expected: [] }], oracle));
  assert.throws(() => validateEvaluationSources([{ ...scenario, expected: [url] }], oracle), /expected topic is absent/);
  assert.throws(() => validateEvaluationSources([{ ...scenario, expected: ['missing-topic'] }], oracle), /expected topic is absent/);
  assert.throws(() => validateEvaluationSources([{ ...scenario, version: 'missing-version' }], oracle), /expected saved version is absent/);
  for (const version of ['', null, false, 0, {}]) assert.throws(() => validateEvaluationSources([{ ...scenario, version }], oracle), /expected saved version/);
  assert.throws(() => validateEvaluationSources([{ ...scenario, filters: { domain: 'unrelated.test' } }], oracle), /outside the fixture filters/);
  assert.throws(() => validateEvaluationSources([{ ...scenario, filters: { from: '2025-01-01' } }], oracle), /outside the fixture filters/);
  assert.throws(() => validateEvaluationSources([{ ...scenario, expected: [] }], oracle), /invalid expected-source list/);
  assert.throws(() => validateEvaluationSources([{ ...scenario, kind: 'empty' }], oracle), /invalid expected-source list/);
});

test('a body-only exact phrase cannot be certified by an unrelated heading marker', () => {
  const scenario = { kind: 'exact-phrase', query: '"coastal nesting"' };
  const snapshot = { passages: [{ start: 100, end: 200 }], heading: { start: 2, end: 40, text: 'Coastal observations' } };
  assert.equal(verifyPassage(scenario, { start: 2, end: 8, text: 'Coastal', visible: true }, snapshot), false);
  assert.equal(verifyPassage(scenario, { start: 2, end: 17, text: 'coastal nesting', visible: true }, snapshot), false);
  assert.equal(verifyPassage(scenario, { start: 110, end: 125, text: 'Coastal nesting', visible: true }, snapshot), true);
  assert.equal(verifyPassage(scenario, { start: 110, end: 125, text: 'Coastal nesting', visible: false }, snapshot), false);
  const namedHeading = { ...snapshot, heading: { start: 2, end: 40, text: 'Coastal nesting observations' } };
  assert.equal(verifyPassage(scenario, { start: 2, end: 17, text: 'Coastal nesting', visible: true }, namedHeading), true);
  assert.equal(verifyPassage({ ...scenario, kind: 'vague' }, { start: 2, end: 17, text: 'Coastal nesting', visible: true }, namedHeading), false);
});

test('vague navigation requires visible authored body evidence, not highlight containment or an arbitrary range', () => {
  const scenario = { kind: 'vague', query: 'air moving through a warm room' };
  const snapshot = { passages: [{ start: 100, end: 300 }] };
  const marker = { start: 90, end: 180, text: 'Notes and useful body context', visible: true };
  const visible = [{ start: 100, end: 300, lines: 2 }];
  assert.equal(verifyPassage(scenario, marker, snapshot, visible), true);
  assert.equal(verifyPassage(scenario, { ...marker, start: 110, end: 180 }, snapshot), false, 'Offsets cannot prove that the useful body is painted');
  assert.equal(verifyPassage(scenario, { ...marker, visible: false }, snapshot, visible), false);
  for (const evidence of [[], [{ start: 0, end: 100, lines: 2 }], [{ start: 100, end: 300, lines: 0 }], [{ start: 100, end: 300, lines: NaN }]]) {
    assert.equal(verifyPassage(scenario, marker, snapshot, evidence), false);
  }
});

test('a scope violation or substituted time invalidates the run even when the expected result is first', () => {
  const result = { url, versionId: 'earlier', timestamp: Date.UTC(2020, 0, 2) };
  const filtered = { ...scenario, filters: { domain: 'benchmark.test', from: '2020-01-01', through: '2020-01-02' } };
  assert.equal(evaluateFinding(filtered, { results: [result], readerVerified: true }, oracle).passed, true);
  assert.equal(evaluateFinding(filtered, { results: [result, { url, versionId: 'current', timestamp: Date.UTC(2025, 0, 2) }], readerVerified: true }, oracle).passed, false);
  assert.equal(evaluateFinding(filtered, { results: [{ ...result, timestamp: result.timestamp + 1 }], readerVerified: true }, oracle).passed, false);
  assert.equal(matchesFixtureScope({ url: 'https://notbenchmark.test/', timestamp: result.timestamp }, filtered.filters), false);
  assert.equal(matchesFixtureScope({ url, timestamp: Date.UTC(2020, 0, 3) }, filtered.filters), false);
});

test('every exact fixture is required even if aggregate top-five success exceeds ninety percent', () => {
  const cases = Array.from({ length: 20 }, (_, index) => ({ kind: index === 0 ? 'exact-phrase' : 'vague', passed: index !== 0 }));
  const summary = findingSummary(cases);
  assert.equal(summary.successRate, 0.95); assert.equal(summary.exact.passed, 0); assert.equal(summary.passedGate, false);
  assert.equal(findingSummary([{ kind: 'empty', passed: true }]).passedGate, false);
  assert.equal(findingSummary([{ kind: 'vague', passed: true }, { kind: 'empty', passed: false }]).passedGate, false);
});
