import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export async function buildBrowserStorageRuntime(extension, backgroundPreamble = '') {
  const runtime = path.join(extension, 'dist/beta');
  const offscreen = path.join(runtime, 'offscreen');
  await mkdir(path.join(offscreen, 'sqlite'), { recursive: true });
  const options = { bundle: true, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent' };
  await Promise.all([
    build({ ...options, entryPoints: ['src/background/index.ts'], outfile: path.join(runtime, 'background.js'), banner: { js: backgroundPreamble } }),
    build({ ...options, entryPoints: { index: 'src/offscreen/index.ts', libraryWorker: 'src/offscreen/libraryWorker.ts' }, outdir: offscreen })
  ]);
  const engine = path.dirname(fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')));
  for (const name of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) await copyFile(path.join(engine, name), path.join(offscreen, 'sqlite', name));
  await copyFile('src/offscreen/index.html', path.join(offscreen, 'index.html'));
}
