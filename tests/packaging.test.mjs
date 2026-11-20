import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'web-recall-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  const files = [manifest.background.service_worker, manifest.side_panel.default_path,
    manifest.options_page, ...manifest.content_scripts.flatMap(entry => entry.js),
    'dist/beta/offscreen/index.html', 'dist/beta/offscreen/libraryWorker.js', 'dist/beta/transformers/ort-wasm-test.wasm',
    'dist/beta/background.js.map', 'privatekey.pem', 'docs/local-only.txt'];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'test fixture, not private data');
  }
  const vendor = path.dirname(fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')));
  const sqlite = path.join(root, 'dist/beta/offscreen/sqlite');
  await mkdir(sqlite);
  for (const name of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) await copyFile(path.join(vendor, name), path.join(sqlite, name));
  const compression = path.dirname(fileURLToPath(import.meta.resolve('fflate/package.json')));
  await copyFile(path.join(compression, 'LICENSE'), path.join(root, 'dist/beta/offscreen/fflate-LICENSE.txt'));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile('scripts/package-extension.mjs', path.join(root, 'scripts/package-extension.mjs'));
  await mkdir(path.join(root, 'dist/beta/icons'), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await copyFile(`src/assets/icons/icon-${size}.png`, path.join(root, `dist/beta/icons/icon-${size}.png`));
  }
  const save = () => writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, manifest, save, run: (clientId = '') => spawnSync(process.execPath, [path.join(root, 'scripts/package-extension.mjs')], {
    encoding: 'utf8', env: { ...process.env, WEB_RECALL_GOOGLE_DRIVE_CLIENT_ID: clientId }
  }) };
}

test('release ZIP includes declared icons and runtime, excluding keys, docs and source maps', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const files = execFileSync('unzip', ['-Z1', path.join(f.root, `dist/web-recall-${f.manifest.version}.zip`)], { encoding: 'utf8' }).trim().split('\n');
  for (const file of Object.values(f.manifest.icons)) assert.ok(files.includes(file), file);
  for (const file of Object.values(f.manifest.action.default_icon)) assert.ok(files.includes(file), file);
  assert.ok(files.includes(f.manifest.background.service_worker));
  assert.ok(files.includes('manifest.json'));
  assert.ok(!files.some(file => /\.pem$|\.map$|^docs\//.test(file)));
});

test('a local-backup release does not ship Google OAuth access, even with a leftover build variable', async t => {
  const f = await fixture(t);
  const publicClient = '12345-chromeextensionfixture.apps.googleusercontent.com';
  const result = f.run(publicClient);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(execFileSync('unzip', ['-p', path.join(f.root, `dist/web-recall-${f.manifest.version}.zip`), 'manifest.json'], { encoding: 'utf8' }));
  assert.equal(manifest.oauth2, undefined);
  assert.ok(!manifest.optional_permissions.includes('identity'));
  assert.ok(!manifest.permissions.includes('identity'));
});

test('packaging rejects a missing 128px store icon declaration', async t => {
  const f = await fixture(t);
  delete f.manifest.icons['128']; await f.save();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required 128px store icon/);
});

test('packaging rejects a missing toolbar-only asset', async t => {
  const f = await fixture(t);
  f.manifest.action.default_icon['32'] = 'dist/beta/icons/toolbar-missing.png'; await f.save();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /toolbar-missing\.png/);
});

test('packaging rejects an icon whose pixels do not match its declared size', async t => {
  const f = await fixture(t);
  await copyFile(path.join(f.root, f.manifest.icons['16']), path.join(f.root, f.manifest.icons['128']));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /128x128 PNG/);
});

test('packaging rejects icons outside the release asset directory', async t => {
  const f = await fixture(t);
  f.manifest.icons['128'] = 'privatekey.pem'; await f.save();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Icon must be a packaged PNG/);
});

test('packaging refuses to publish a library worker whose local Wasm binary is missing', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, 'dist/beta/offscreen/sqlite/sqlite3.wasm'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sqlite3\.wasm/u);
  await assert.rejects(readFile(path.join(f.root, `dist/web-recall-${f.manifest.version}.zip`)), { code: 'ENOENT' });
});
