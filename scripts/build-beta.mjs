#!/usr/bin/env node
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  'offscreen/index': path.resolve(REPO_ROOT, 'src/offscreen/index.ts')
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
  const srcDir = path.resolve(REPO_ROOT, 'node_modules/@huggingface/transformers/dist');
  const destDir = path.resolve(OUT_DIR, 'transformers');
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir);
  const wasmFiles = entries.filter((name) => name.startsWith('ort-wasm'));
  await Promise.all(
    wasmFiles.map(async (name) => {
      await fs.copyFile(path.join(srcDir, name), path.join(destDir, name));
    })
  );
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
  await copyTransformersWasm();
  console.info(`Beta workspace bundled to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
