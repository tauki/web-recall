// Export the approved Outline variant at Chrome's required icon sizes.
// Sharp is already supplied by the pinned Transformers.js dependency.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.resolve('@huggingface/transformers'));
const sharp = require('sharp');
const folder = fileURLToPath(new URL('../src/assets/icons/', import.meta.url));
for (const size of [16, 32, 48, 128]) {
  await sharp(path.join(folder, 'outline-mark.png'))
    .resize(size, size)
    .png()
    .toFile(path.join(folder, `icon-${size}.png`));
}
console.log('Exported Web Recall icons at 16, 32, 48 and 128px.');
