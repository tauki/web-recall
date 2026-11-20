import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const configuration = process.argv.includes('--debug') ? 'debug' : 'release';
const app = path.join(root, 'dist/apple/Web Recall.app');
const executableDirectory = path.join(app, 'Contents/MacOS');
const resources = path.join(app, 'Contents/Resources');
const icons = path.join(root, 'src/assets/icons');
const outline = path.join(icons, 'outline-mark.png');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const extension = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const publicKey = (await fs.readFile(path.join(root, 'native/apple/update-public-key.txt'), 'utf8')).trim();
if (Buffer.from(publicKey, 'base64').length !== 32 || Buffer.from(publicKey, 'base64').toString('base64') !== publicKey) {
  throw new Error('Invalid updater public key. Run pnpm apple:update:keygen once before building.');
}
const plist = { CFBundleIdentifier: 'com.webrecall.companion', CFBundleName: 'Web Recall', CFBundleDisplayName: 'Web Recall', CFBundleExecutable: 'WebRecallCompanion', CFBundlePackageType: 'APPL', CFBundleShortVersionString: version, CFBundleVersion: version, LSMinimumSystemVersion: '26.4', LSUIElement: true, NSHumanReadableCopyright: '' };
plist.CFBundleIconFile = 'AppIcon.icns';
plist.WebRecallUpdatePublicKey = publicKey;

async function buildApplicationIcon(destination) {
  const staging = await fs.mkdtemp(path.join(tmpdir(), 'web-recall-icon-'));
  try {
    const iconset = path.join(staging, 'AppIcon.iconset');
    await fs.mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = String(size * scale);
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        execFileSync('/usr/bin/sips', ['-z', pixels, pixels, outline, '--out', path.join(iconset, name)]);
      }
    }
    execFileSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', destination, iconset]);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

await fs.rm(app, { recursive: true, force: true });
await fs.mkdir(executableDirectory, { recursive: true });
await fs.mkdir(resources, { recursive: true });
await buildApplicationIcon(path.join(resources, plist.CFBundleIconFile));
await fs.copyFile(path.join(icons, path.basename(extension.action.default_icon['48'])), path.join(resources, 'MenuIcon.png'));
for (const binary of ['WebRecallCompanion', 'web-recall-apple', 'WebRecallUpdater']) {
  await fs.copyFile(path.join(root, 'native/apple/.build', configuration, binary), path.join(executableDirectory, binary));
  await fs.chmod(path.join(executableDirectory, binary), 0o755);
}
const encoded = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(plist) });
await fs.writeFile(path.join(app, 'Contents/Info.plist'), encoded);
const identity = process.env.APPLE_CODESIGN_IDENTITY || '-';
for (const binary of ['web-recall-apple', 'WebRecallUpdater']) {
  execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, path.join(executableDirectory, binary)]);
}
execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, app]);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
console.log(app);
