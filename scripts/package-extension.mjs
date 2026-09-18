import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const entries = [manifest.background.service_worker, manifest.side_panel.default_path,
  manifest.options_page, ...manifest.content_scripts.flatMap((entry) => entry.js)];
for (const entry of entries) await fs.access(path.join(root, entry));
await fs.access(path.join(root, 'dist/beta/offscreen/index.html'));
const runtimeFiles = await fs.readdir(path.join(root, 'dist/beta/transformers'));
if (!runtimeFiles.some((name) => name.endsWith('.wasm'))) throw new Error('Missing ONNX runtime assets');
const archive = path.join(root, `dist/web-recall-${manifest.version}.zip`);
await fs.rm(archive, { force: true });
execFileSync('zip', ['-qr', archive, 'manifest.json', 'dist/beta', '-x', '*.map'], { cwd: root });
const contents = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).split('\n');
for (const entry of entries) {
  if (!contents.includes(entry)) throw new Error(`Missing packaged entrypoint: ${entry}`);
}
if (contents.some((entry) => entry && entry !== 'manifest.json' && !entry.startsWith('dist/beta/'))) {
  throw new Error('Unexpected file in extension package');
}
console.log(archive);
