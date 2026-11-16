import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const extensionId = args[args.indexOf('--extension-id') + 1];
if (!args.includes('--extension-id') || !/^[a-p]{32}$/.test(extensionId || '')) {
  throw new Error('Use --extension-id with the 32-letter ID shown in chrome://extensions.');
}
if (process.platform !== 'darwin') throw new Error('The Apple helper is only supported on macOS.');
const app = path.join(os.homedir(), 'Applications/Web Recall.app');
const destination = path.join(app, 'Contents/MacOS/web-recall-apple');
const legacyDestination = path.join(os.homedir(), 'Library/Application Support/WebRecall/Apple/web-recall-apple');
const manifestPath = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.webrecall.apple.json');
const manifest = { name: 'com.webrecall.apple', description: 'Web Recall Apple Foundation Models helper', path: destination, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
if (args.includes('--dry-run')) {
  console.log(JSON.stringify({ app, manifestPath, manifest }, null, 2));
} else {
  const source = path.join(root, 'dist/apple/Web Recall.app');
  await fs.access(source);
  try {
    const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (existing.name !== manifest.name || ![destination, legacyDestination].includes(existing.path)) throw new Error('Refusing to replace an unrelated native host registration.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const exists = await fs.stat(app).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (exists) {
    const identifier = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (identifier !== 'com.webrecall.companion') throw new Error('Refusing to replace an unrelated application.');
  }
  await fs.mkdir(path.dirname(app), { recursive: true });
  const staged = `${app}.new-${process.pid}`;
  const backup = `${app}.previous-${process.pid}`;
  await fs.cp(source, staged, { recursive: true, errorOnExist: true, force: false });
  if (exists) await fs.rename(app, backup);
  try { await fs.rename(staged, app); }
  catch (error) { if (exists) await fs.rename(backup, app); throw error; }
  if (exists) await fs.rm(backup, { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath + '.new', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(manifestPath + '.new', manifestPath);
  console.log(`Installed ${app} and registered ${manifest.name} for extension ${extensionId}. Open Web Recall from Applications before selecting Apple in Chrome.`);
}
