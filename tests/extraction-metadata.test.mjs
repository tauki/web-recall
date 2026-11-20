import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, plain } from './helpers.mjs';

const { readCaptureInfo } = await loadSource('src/shared/capture.ts');

test('capture metadata remains optional for old saves and strips unrelated imported fields', () => {
  assert.equal(readCaptureInfo(undefined), undefined);
  const imported = { source: 'main', warnings: ['Embedded content was not captured.'], complete: true, html: '<script>unsafe()</script>' };
  const metadata = readCaptureInfo(imported);
  assert.deepEqual(plain(metadata), { source: 'main', warnings: ['Embedded content was not captured.'] });
  imported.warnings.push('Later edit');
  assert.equal(metadata.warnings.length, 1, 'Imported data must not retain mutable references');
});

test('invalid provided capture metadata fails rather than disappearing from a restored save', () => {
  for (const value of [null, false, 1, 'article', [], {}, { source: 'complete', warnings: [] }, { source: 'ARTICLE', warnings: [] }, { source: 'body' }, { source: 'main', warnings: 'Incomplete' }, { source: 'article', warnings: [null] }, { source: 'article', warnings: [{}] }, { source: 'article', warnings: new Array(1) }, { source: 'article', warnings: new Array(17).fill('Warning') }, { source: 'article', warnings: ['x'.repeat(501)] }]) {
    assert.throws(() => readCaptureInfo(value), /Invalid capture/, `Must reject ${JSON.stringify(value)}`);
  }
});

test('capture warning limits accept their exact boundaries without truncating useful explanations', () => {
  const warnings = new Array(16).fill('x'.repeat(500));
  const metadata = readCaptureInfo({ source: 'body', warnings });
  assert.deepEqual(plain(metadata.warnings), warnings);
  assert.deepEqual(plain(readCaptureInfo({ source: 'article', warnings: [] })), { source: 'article', warnings: [] });
});
