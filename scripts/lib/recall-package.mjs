import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fingerprint = value => createHash('sha256').update(value).digest('hex');

export async function stageRecallPackage(candidate, directory) {
  const bytes = await readFile(candidate);
  const archive = path.join(directory, 'candidate.zip');
  await writeFile(archive, bytes, { flag: 'wx' });
  const extension = path.join(directory, 'extension');
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.ok(entries.every(entry => (entry === 'manifest.json' || /^dist\/beta\/[\w./-]*$/u.test(entry)) && !entry.split('/').some(part => part === '..' || part === '.')), 'Candidate must contain only canonical extension package paths');
  const files = entries.filter(entry => !entry.endsWith('/'));
  assert.equal(new Set(files).size, files.length, 'Candidate has duplicate files');
  assert.ok(files.includes('manifest.json'), 'Candidate is missing its manifest');
  const readMember = member => execFileSync('unzip', ['-p', archive, member], { maxBuffer: 64 * 1024 * 1024 });
  const manifest = JSON.parse(readMember('manifest.json'));
  for (const entry of [manifest.background?.service_worker, manifest.side_panel?.default_path]) {
    assert.ok(entry?.startsWith('dist/beta/') && files.includes(entry), `Candidate is missing a packaged entry point: ${entry}`);
  }
  const fingerprints = {};
  for (const file of files) {
    const target = path.join(extension, file);
    const content = readMember(file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
    fingerprints[file] = fingerprint(content);
  }
  return { extension, manifest, sha256: fingerprint(bytes), files: fingerprints };
}
