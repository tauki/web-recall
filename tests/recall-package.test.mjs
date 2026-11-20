import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageRecallPackage } from '../scripts/lib/recall-package.mjs';

test('recall stages the selected ZIP byte-for-byte, including the original executable and panel document', async context => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-recall-benchmark-archive-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const stage = path.join(directory, 'stage');
  await mkdir(path.join(source, 'dist/beta/ui'), { recursive: true });
  await mkdir(stage);
  const manifest = { manifest_version: 3, version: '0.3.0', background: { service_worker: 'dist/beta/worker.js' }, side_panel: { default_path: 'dist/beta/ui/panel.html' } };
  const files = {
    'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    'dist/beta/worker.js': Buffer.from('globalThis.packageAsset = "signed bytes";\n'),
    'dist/beta/ui/panel.html': Buffer.from('<title>Original packaged panel</title>\n'),
    'dist/beta/fixture.wasm': Buffer.from([0, 97, 115, 109, 255])
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(source, name), bytes);
  const candidate = path.join(directory, 'candidate.zip');
  execFileSync('zip', ['-q', candidate, ...Object.keys(files)], { cwd: source });
  const expectedArchive = await readFile(candidate);
  const actual = await stageRecallPackage(candidate, stage);
  assert.equal(actual.sha256, createHash('sha256').update(expectedArchive).digest('hex'));
  for (const [name, bytes] of Object.entries(files)) {
    assert.deepEqual(await readFile(path.join(actual.extension, name)), bytes, 'Do not regenerate package entries from local source');
    assert.equal(actual.files[name], createHash('sha256').update(bytes).digest('hex'));
  }
  assert.deepEqual(await readFile(candidate), expectedArchive);

  const brokenPackage = path.join(directory, 'missing-panel.zip');
  const brokenStage = path.join(directory, 'broken');
  await mkdir(brokenStage);
  execFileSync('zip', ['-q', brokenPackage, 'manifest.json', 'dist/beta/worker.js'], { cwd: source });
  await assert.rejects(stageRecallPackage(brokenPackage, brokenStage), /missing a packaged entry point:.*panel\.html/u);
});
