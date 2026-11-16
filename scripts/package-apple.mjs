import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Companion release packages require an Apple Silicon Mac.');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Companion releases require a stable version.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('Release tag and companion version do not match.');
}
const app = path.join(root, 'dist/apple/Web Recall.app');
const output = path.join(root, 'dist/apple-release');
const archive = path.join(output, `web-recall-companion-${version}.zip`);
const metadata = path.join(output, 'web-recall-companion-update.json');
const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }));
const pinnedKey = (await fs.readFile(path.join(root, 'native/apple/update-public-key.txt'), 'utf8')).trim();
if (info.CFBundleShortVersionString !== version || info.WebRecallUpdatePublicKey !== pinnedKey) {
  throw new Error('Rebuild the companion: its version or signing key does not match the workspace.');
}
await fs.mkdir(output, { recursive: true, mode: 0o700 });
await fs.rm(archive, { force: true });
await fs.rm(metadata, { force: true });
try {
  execFileSync('/usr/bin/zip', ['-qryX', archive, path.basename(app)], { cwd: path.dirname(app) });
  execFileSync(path.join(app, 'Contents/MacOS/WebRecallUpdater'), ['sign', archive, app, metadata], { stdio: 'inherit' });
} catch (error) {
  await fs.rm(archive, { force: true });
  await fs.rm(metadata, { force: true });
  throw error;
}
console.log(`Signed companion release: ${archive}\n${metadata}`);
