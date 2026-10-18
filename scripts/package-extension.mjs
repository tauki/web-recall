import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
// Validate the store icon and every declared toolbar icon before producing a ZIP.
if (!manifest.icons?.['128']) throw new Error('Missing required 128px store icon');
const iconEntries = [...Object.entries(manifest.icons), ...Object.entries(manifest.action?.default_icon ?? {})];
for (const [size, file] of iconEntries) {
  if (typeof file !== 'string' || !/^dist\/beta\/icons\/[^/]+\.png$/.test(file)) {
    throw new Error(`Icon must be a packaged PNG in dist/beta/icons: ${file}`);
  }
  const png = await fs.readFile(path.join(root, file));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature) ||
      png.toString('ascii', 12, 16) !== 'IHDR' ||
      png.readUInt32BE(16) !== Number(size) || png.readUInt32BE(20) !== Number(size)) {
    throw new Error(`Icon must be a ${size}x${size} PNG: ${file}`);
  }
}
const entries = [manifest.background.service_worker, manifest.side_panel.default_path,
  manifest.options_page, ...manifest.content_scripts.flatMap((entry) => entry.js),
  ...iconEntries.map(([, file]) => file)];
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
