import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers.mjs';
import { execFileSync } from 'node:child_process';

const { readSearchFilters, matchesSearchFilters } = await loadSource('src/shared/searchFilters.ts');

test('a site filter includes its subdomains but not a lookalike suffix or query string', () => {
  const filters = readSearchFilters({ domain: 'Example.COM' });
  assert.equal(matchesSearchFilters({ url: 'https://example.com/article', timestamp: 1 }, filters), true);
  assert.equal(matchesSearchFilters({ url: 'https://notes.example.com/article', timestamp: 1 }, filters), true);
  assert.equal(matchesSearchFilters({ url: 'https://notexample.com/article', timestamp: 1 }, filters), false);
  assert.equal(matchesSearchFilters({ url: 'https://elsewhere.test/?site=example.com', timestamp: 1 }, filters), false);
});

test('date filters include the first instant and exclude the first instant after the chosen range', () => {
  const from = Date.UTC(2026, 9, 1), before = Date.UTC(2026, 10, 1);
  const filters = readSearchFilters({ from, before });
  const hit = timestamp => matchesSearchFilters({ url: 'https://saved.test/', timestamp }, filters);
  assert.equal(hit(from - 1), false);
  assert.equal(hit(from), true);
  assert.equal(hit(before - 1), true);
  assert.equal(hit(before), false);
});

test('domain and date filters both constrain a result, including when the search has no keywords', () => {
  const filters = readSearchFilters({ domain: 'saved.test', from: 10, before: 20 });
  assert.equal(matchesSearchFilters({ url: 'https://saved.test/one', timestamp: 12 }, filters), true);
  assert.equal(matchesSearchFilters({ url: 'https://saved.test/old', timestamp: 9 }, filters), false);
  assert.equal(matchesSearchFilters({ url: 'https://other.test/one', timestamp: 12 }, filters), false);
});

test('invalid filters fail explicitly rather than silently widening the search', () => {
  for (const invalid of [null, [], { domain: 'https://saved.test' }, { domain: 'saved.test/path' }, { domain: 'user@saved.test' }, { from: NaN }, { before: 'tomorrow' }, { from: 20, before: 10 }]) {
    assert.throws(() => readSearchFilters(invalid));
  }
});

test('internationalized domains and trailing DNS dots refer to the same site', () => {
  const filters = readSearchFilters({ domain: 'bücher.example.' });
  assert.equal(matchesSearchFilters({ url: 'https://xn--bcher-kva.example/book', timestamp: 1 }, filters), true);
});

test('root-dot and empty-label domains are rejected instead of removing the site constraint', () => {
  for (const domain of ['.', '%2e', '。', '..', 'example..test']) assert.throws(() => readSearchFilters({ domain }), /site domain/);
});

test('Through uses the next calendar midnight even when the chosen day starts after a DST jump', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', "import { loadSource } from './tests/helpers.mjs'; const { readCaptureDateRange } = await loadSource('src/shared/searchFilters.ts'); console.log(JSON.stringify(readCaptureDateRange('2026-09-06','2026-09-06')));"], { encoding: 'utf8', env: { ...process.env, TZ: 'America/Santiago' } });
  const range = JSON.parse(output);
  assert.equal(range.from, Date.UTC(2026, 8, 6, 4));
  assert.equal(range.before, Date.UTC(2026, 8, 7, 3));
});
