import { pageContent } from '../pageContent';
import { checksum } from './sqlitePayload';
import type { PageRecord } from './index';

const SIGNATURE_BYTES = 512;
const HEADER_BYTES = 8;
const MAX_WORDS_LENGTH = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function visitGrams(value: string, visit: (bit: number) => void): void {
  let gram = 0, run = 0;
  for (let offset = 0; offset < value.length; offset++) {
    let code = value.charCodeAt(offset);
    if (code >= 65 && code <= 90) code += 32;
    else if (code === 0x212a) code = 107;
    else if (code === 0x017f) code = 115;
    if (code < 33 || code > 126) { run = 0; gram = 0; continue; }
    gram = ((gram << 7) | code) & 0x1fffff;
    if (++run >= 3) visit(Math.imul(gram ^ (gram >>> 11), 0x45d9f3b) >>> 20);
  }
}

export function textIndexNeedles(value: string): number[] {
  const bits = new Set<number>();
  visitGrams(value, bit => bits.add(bit));
  return [...bits];
}

export function textIndexMayContain(signature: Uint8Array, needles: number[]): boolean {
  return needles.every(bit => Boolean(signature[bit >>> 3]! & (1 << (bit & 7))));
}

export function foldAsciiLetters(value: string): string {
  return value.replace(/[A-Z\u212a\u017f]/gu, letter => letter === 'ſ' ? 's' : letter.toLowerCase());
}

function wordDictionary(content: string): string | undefined {
  const words = new Set<string>();
  let size = 1;
  for (const match of content.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const original = match[0];
    if (!/[a-z0-9_ſK]/iu.test(original)) continue;
    const word = foldAsciiLetters(original);
    if (words.has(word)) continue;
    size += word.length + 1;
    if (size > MAX_WORDS_LENGTH) return undefined;
    words.add(word);
  }
  return ' ' + [...words].join(' ') + ' ';
}

export function encodeTextIndex(page: PageRecord): Uint8Array {
  const versions = [page, ...(page.versions || [])];
  const contents = versions.map(pageContent);
  const metadata = encoder.encode(JSON.stringify(versions.map((version, index) => [version.title || page.url, version.timestamp, wordDictionary(contents[index]!) ?? null])));
  const encoded = new Uint8Array(HEADER_BYTES + metadata.length + versions.length * SIGNATURE_BYTES);
  encoded.set(metadata, HEADER_BYTES);
  contents.forEach((content, index) => {
    const start = HEADER_BYTES + metadata.length + index * SIGNATURE_BYTES;
    visitGrams(content, bit => { const byte = start + (bit >>> 3); encoded[byte] = encoded[byte]! | (1 << (bit & 7)); });
  });
  const header = new DataView(encoded.buffer);
  header.setUint32(0, metadata.length);
  header.setUint32(4, checksum(encoded.subarray(HEADER_BYTES)));
  return encoded;
}

export function decodeTextIndex(value: unknown): Array<{ title: string; timestamp: number; signature: Uint8Array; words?: string }> | null {
  if (!(value instanceof Uint8Array) || value.length <= HEADER_BYTES) return null;
  const header = new DataView(value.buffer, value.byteOffset, HEADER_BYTES);
  const start = HEADER_BYTES + header.getUint32(0);
  if (start >= value.length || checksum(value.subarray(HEADER_BYTES)) !== header.getUint32(4)) return null;
  try {
    const metadata: unknown = JSON.parse(decoder.decode(value.subarray(HEADER_BYTES, start)));
    if (!Array.isArray(metadata) || !metadata.length || value.length !== start + metadata.length * SIGNATURE_BYTES ||
        !metadata.every(version => Array.isArray(version) && typeof version[0] === 'string' && typeof version[1] === 'number' && Number.isFinite(version[1]) &&
          (version[2] == null || typeof version[2] === 'string'))) return null;
    return metadata.map(([title, timestamp, words], index) => ({ title, timestamp, words: words ?? undefined,
      signature: value.subarray(start + index * SIGNATURE_BYTES, start + (index + 1) * SIGNATURE_BYTES) }));
  } catch { return null; }
}
