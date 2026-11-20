export function latencySummary(samples, limitMs) {
  if (!samples.length) return { count: 0, failures: 0, p95Ms: null, maxMs: null, passed: false };
  const timings = samples.map(sample => Number.isFinite(sample) && sample >= 0 ? sample : Infinity).sort((first, second) => first - second);
  const percentile = timings[Math.ceil(timings.length * 0.95) - 1];
  return { count: timings.length, failures: timings.filter(value => !Number.isFinite(value)).length, p95Ms: Number.isFinite(percentile) ? percentile : null, maxMs: Number.isFinite(timings.at(-1)) ? timings.at(-1) : null, passed: timings.every(Number.isFinite) && percentile <= limitMs };
}

export function resourceSummary(measurements, limits) {
  const within = (value, limit) => Number.isFinite(value) && value > 0 && value <= limit;
  const checks = {
    storage: within(measurements.storageBytes, limits.storageBytes),
    activeSamples: Number.isSafeInteger(measurements.sampleCount) && measurements.sampleCount > 0 && within(measurements.activeSampleBytes, limits.activeSampleBytes),
    idle: within(measurements.initializedIdleBytes, limits.idleBytes) && within(measurements.clearedIdleBytes, limits.idleBytes)
  };
  return { ...checks, passed: Object.values(checks).every(Boolean), measurements, limits };
}

export function matchesFixtureScope(snapshot, filters = {}) {
  const host = new URL(snapshot.url).hostname;
  if (filters.domain && host !== filters.domain && !host.endsWith('.' + filters.domain)) return false;
  if (filters.from && snapshot.timestamp < Date.parse(filters.from + 'T00:00:00Z')) return false;
  if (filters.through && snapshot.timestamp >= Date.parse(filters.through + 'T00:00:00Z') + 86400000) return false;
  return true;
}

export function verifyPassage(scenario, marker, snapshot, visibleBodyRanges = []) {
  if (!['exact-phrase', 'vague', 'old-evidence'].includes(scenario.kind)) return true;
  if (!marker?.visible || !snapshot) return false;
  const normalize = value => value.replace(/\s+/gu, ' ').trim().toLowerCase();
  const literal = normalize(scenario.query.replace(/^["“]|["”]$/gu, ''));
  if (scenario.kind === 'exact-phrase' && normalize(marker.text) !== literal) return false;
  if (scenario.kind !== 'exact-phrase') return snapshot.passages?.some(range => visibleBodyRanges.some(visible => visible.start === range.start && visible.end === range.end && Number.isSafeInteger(visible.lines) && visible.lines > 0)) === true;
  if (snapshot.passages?.some(range => marker.start >= range.start && marker.end <= range.end)) return true;
  const heading = snapshot.heading;
  return scenario.kind === 'exact-phrase' && Boolean(heading && normalize(heading.text).includes(literal) && marker.start >= heading.start && marker.end <= heading.end);
}

export function evaluateFinding(scenario, observation, oracle) {
  const rows = observation.results || [];
  const expected = new Set(scenario.expected.map(id => oracle.topics[id]?.url));
  const rank = rows.findIndex(row => expected.has(row.url));
  const target = rank >= 0 ? rows[rank] : undefined;
  const violations = rows.flatMap(row => {
    const snapshots = oracle.pages[row.url];
    const snapshot = snapshots?.find(version => version.versionId === row.versionId);
    if (!snapshot || row.timestamp !== snapshot.timestamp || row.title !== snapshot.title) return [`Unknown or substituted snapshot: ${row.url}`];
    return matchesFixtureScope({ ...snapshot, url: row.url }, scenario.filters) ? [] : [`Outside filter scope: ${row.url}`];
  });
  if (new Set(rows.map(row => row.url)).size !== rows.length) violations.push('Search must group results to one saved snapshot per URL.');
  const expectedVersion = scenario.version || (target ? oracle.pages[target.url]?.[0]?.versionId : undefined);
  const sourceMatches = Boolean(target && target.versionId === expectedVersion);
  const empty = scenario.kind === 'empty';
  const passed = !observation.error && violations.length === 0 && (empty ? rows.length === 0 : rank >= 0 && rank < 5 && sourceMatches && observation.readerVerified === true);
  return { id: scenario.id, kind: scenario.kind, split: scenario.split || 'development', passed, rank: rank < 0 ? null : rank + 1, expectedVersion, sourceMatches, readerVerified: observation.readerVerified === true, violations, error: observation.error || null };
}

export function validateEvaluationSources(cases, oracle) {
  for (const scenario of cases) {
    if (!Array.isArray(scenario.expected) || (scenario.kind === 'empty' ? scenario.expected.length !== 0 : scenario.expected.length === 0)) throw Error(`${scenario.id}: invalid expected-source list`);
    if (scenario.version !== undefined && (typeof scenario.version !== 'string' || !scenario.version)) throw Error(`${scenario.id}: invalid expected saved version`);
    for (const reference of scenario.expected) {
      const url = typeof reference === 'string' ? oracle.topics[reference]?.url : undefined;
      if (!url || !oracle.pages[url]?.length) throw Error(`${scenario.id}: expected topic is absent from the authored corpus: ${String(reference)}`);
      const snapshot = scenario.version === undefined ? oracle.pages[url][0] : oracle.pages[url].find(version => version.versionId === scenario.version);
      if (!snapshot) throw Error(`${scenario.id}: expected saved version is absent from the authored corpus: ${scenario.version}`);
      if (!matchesFixtureScope({ ...snapshot, url }, scenario.filters)) throw Error(`${scenario.id}: expected saved version is outside the fixture filters`);
    }
  }
}

export function evaluationSchedule(development, heldout = [], acceptance = false) {
  const categories = ['exact-title', 'exact-phrase', 'url', 'vague', 'old-evidence', 'filter'];
  const inspect = (cases, minimum, cold) => {
    const finding = cases.filter(value => value.kind !== 'empty');
    if (finding.length < minimum || new Set(cases.map(value => value.id)).size !== cases.length || categories.some(kind => !finding.some(value => value.kind === kind)) || finding.some(value => !value.expected?.length) || finding.filter(value => value.cold).length !== cold || categories.some(kind => !finding.some(value => value.cold && value.kind === kind))) throw Error('The frozen evaluation schedule is incomplete or duplicated.');
  };
  inspect(development, 40, 12);
  if (acceptance) inspect(heldout, 20, 8);
  if (new Set([...development, ...heldout].map(value => value.id)).size !== development.length + heldout.length) throw Error('Evaluation IDs must be unique across splits.');
  return { development: development.length, heldout: heldout.length, cold: [...development, ...heldout].filter(value => value.cold).map(value => value.id) };
}

export function summarizeObservations(samples, cold, split) {
  const observations = [...samples, ...cold].filter(value => value.split === split);
  const ids = [...new Set(observations.map(value => value.id))];
  return findingSummary(ids.map(id => {
    const cases = observations.filter(value => value.id === id);
    return { ...cases[0], passed: cases.every(value => value.passed) };
  }));
}

export function findingSummary(results) {
  const finding = results.filter(result => result.kind !== 'empty');
  const exact = finding.filter(result => ['exact-title', 'exact-phrase'].includes(result.kind));
  const passed = finding.filter(result => result.passed).length;
  const summarize = group => ({ count: group.length, passed: group.filter(result => result.passed).length });
  const byKind = Object.fromEntries([...new Set(results.map(result => result.kind))].map(kind => [kind, summarize(results.filter(result => result.kind === kind))]));
  return { count: finding.length, passed, successRate: finding.length ? passed / finding.length : null, exact: summarize(exact), byKind, passedGate: finding.length > 0 && passed / finding.length >= 0.9 && exact.every(result => result.passed) && results.filter(result => result.kind === 'empty').every(result => result.passed) };
}
