#!/usr/bin/env node
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.resolve(REPO_ROOT, 'dist/beta');

const entryPoints = {
  background: path.resolve(REPO_ROOT, 'src/background/index.ts'),
  content: path.resolve(REPO_ROOT, 'src/content/index.ts'),
  'ui/sidepanel/index': path.resolve(REPO_ROOT, 'src/ui/sidepanel/index.ts'),
  'ui/manage/index': path.resolve(REPO_ROOT, 'src/ui/manage/index.ts'),
  'ui/highlights/index': path.resolve(REPO_ROOT, 'src/ui/highlights/index.ts'),
  'ui/logs/index': path.resolve(REPO_ROOT, 'src/ui/logs/index.ts'),
  'offscreen/index': path.resolve(REPO_ROOT, 'src/offscreen/index.ts'),
  'offscreen/libraryWorker': path.resolve(REPO_ROOT, 'src/offscreen/libraryWorker.ts')
};

async function copyHtml() {
  const htmlTargets = ['sidepanel', 'manage', 'highlights', 'logs'];
  await Promise.all(
    htmlTargets.map(async (view) => {
      const src = path.resolve(REPO_ROOT, `src/ui/${view}/index.html`);
      const destDir = path.resolve(OUT_DIR, `ui/${view}`);
      await fs.mkdir(destDir, { recursive: true });
      await fs.copyFile(src, path.join(destDir, 'index.html'));
    })
  );
  const offscreenSrc = path.resolve(REPO_ROOT, 'src/offscreen/index.html');
  const offscreenDest = path.resolve(OUT_DIR, 'offscreen');
  await fs.mkdir(offscreenDest, { recursive: true });
  await fs.copyFile(offscreenSrc, path.join(offscreenDest, 'index.html'));
}

async function copyTransformersWasm() {
  // Transformers.js 4 ships its loader but gets WASM binaries from onnxruntime-web.
  // Resolve through Transformers so the bundled loader and binaries use its exact runtime.
  const require = createRequire(import.meta.resolve('@huggingface/transformers'));
  const srcDir = path.dirname(require.resolve('onnxruntime-web'));
  const destDir = path.resolve(OUT_DIR, 'transformers');
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir);
  const wasmFiles = entries.filter((name) => name.startsWith('ort-wasm'));
  if (!wasmFiles.some((name) => name.endsWith('.wasm'))) throw new Error('Missing ONNX WASM binaries');
  await Promise.all(
    wasmFiles.map(async (name) => {
      await fs.copyFile(path.join(srcDir, name), path.join(destDir, name));
    })
  );
}

async function copySavedLibraryRuntime() {
  const source = path.dirname(fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm')));
  const destination = path.join(OUT_DIR, 'offscreen', 'sqlite');
  await fs.mkdir(destination, { recursive: true });
  for (const filename of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) {
    await fs.copyFile(path.join(source, filename), path.join(destination, filename));
  }
  const compression = path.dirname(fileURLToPath(import.meta.resolve('fflate/package.json')));
  await fs.copyFile(path.join(compression, 'LICENSE'), path.join(OUT_DIR, 'offscreen', 'fflate-LICENSE.txt'));
}

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });
  await build({
    entryPoints,
    outdir: OUT_DIR,
    bundle: true,
    format: 'esm',
    target: 'es2022',
    splitting: false,
    sourcemap: true,
    platform: 'browser',
    logLevel: 'info',
    treeShaking: true
  });
  await copyHtml();
  const iconDir = path.join(OUT_DIR, 'icons');
  await fs.mkdir(iconDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const name = `icon-${size}.png`;
    await fs.copyFile(path.join(REPO_ROOT, 'src/assets/icons', name), path.join(iconDir, name));
  }
  await fs.copyFile(path.join(REPO_ROOT, 'src/assets/icons/mark.png'), path.join(iconDir, 'mark.png'));
  for (const folder of ['fonts', 'ui']) {
    await fs.cp(path.join(REPO_ROOT, 'src/assets', folder), path.join(OUT_DIR, folder), { recursive: true });
  }
  await copyTransformersWasm();
  await copySavedLibraryRuntime();
  console.info(`Beta workspace bundled to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
