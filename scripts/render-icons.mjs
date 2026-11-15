// Export the approved raster mark at Chrome's required icon sizes.
// Sharp is already supplied by the pinned Transformers.js dependency.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.resolve('@huggingface/transformers'));
const sharp = require('sharp');
const folder = fileURLToPath(new URL('../src/assets/icons/', import.meta.url));
const master = sharp(path.join(folder, 'mark.png'));
const { width, height } = await master.metadata();
const alpha = await master.extractChannel('alpha').toBuffer();
// A neutral foreground stays legible on light and dark browser chrome without a tile.
const icon = await sharp({ create: { width, height, channels: 3, background: '#85858A' } })
  .joinChannel(alpha).png().toBuffer();
for (const size of [16, 32, 48, 128]) {
  await sharp(icon)
    .resize(size, size)
    .png()
    .toFile(path.join(folder, `icon-${size}.png`));
}
console.log('Exported Web Recall icons at 16, 32, 48 and 128px.');
