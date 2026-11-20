const MAGIC = new TextEncoder().encode('WRBK1');
const SALT_BYTES = 32;
const HEADER_BYTES = MAGIC.length + SALT_BYTES;
const FRAME_BYTES = 256 * 1024;
const TAG_BYTES = 16;

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function createRecoveryKey(): string {
  return 'WR1-' + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function importRecoveryKey(value: string): Promise<CryptoKey> {
  const token = value.trim();
  if (!/^WR1-[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('Enter a valid Web Recall recovery key.');
  const raw = Uint8Array.from(atob(token.slice(4).replace(/-/gu, '+').replace(/_/gu, '/')), letter => letter.charCodeAt(0));
  if (base64Url(raw) !== token.slice(4)) throw new Error('Enter a valid Web Recall recovery key.');
  try { return await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']); }
  finally { raw.fill(0); }
}

export async function recoveryKeyIdentifier(root: CryptoKey): Promise<string> {
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('Web Recall recovery key identifier') }, root, 128);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}

function archiveKey(root: CryptoKey, header: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: header.subarray(MAGIC.length), info: MAGIC }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function parameters(header: Uint8Array<ArrayBuffer>, sequence: number, final: boolean): AesGcmParams {
  if (sequence > 0xffffffff) throw new Error('Encrypted backup exceeds the format limit.');
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, sequence);
  const additionalData = new Uint8Array(HEADER_BYTES + 5);
  additionalData.set(header);
  additionalData.set(iv.subarray(8), HEADER_BYTES);
  additionalData[HEADER_BYTES + 4] = Number(final);
  return { name: 'AES-GCM', iv, additionalData };
}

export async function* encryptBackup(source: AsyncIterable<Uint8Array>, root: CryptoKey, signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC);
  header.set(crypto.getRandomValues(new Uint8Array(SALT_BYTES)), MAGIC.length);
  const key = await archiveKey(root, header);
  let sequence = 0;
  const pending = new Uint8Array(FRAME_BYTES);
  let used = 0;
  const frame = async (data: Uint8Array<ArrayBuffer>, final = false): Promise<Uint8Array<ArrayBuffer>> => {
    signal.throwIfAborted();
    const encoded = new Uint8Array(data.length + TAG_BYTES + 4);
    new DataView(encoded.buffer).setUint32(0, encoded.length - 4);
    encoded.set(new Uint8Array(await crypto.subtle.encrypt(parameters(header, sequence++, final), key, data)), 4);
    return encoded;
  };
  yield header;
  for await (const bytes of source) {
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const size = Math.min(FRAME_BYTES - used, bytes.length - offset);
      pending.set(bytes.subarray(offset, offset + size), used);
      used += size;
      offset += size;
      if (used === FRAME_BYTES) { yield await frame(pending); used = 0; }
    }
  }
  if (used) yield await frame(pending.subarray(0, used));
  yield await frame(pending.subarray(0, 0), true);
}

export function decryptBackup(file: Blob, root: CryptoKey, signal: AbortSignal): ReadableStream<Uint8Array> {
  async function* decode(): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    signal.throwIfAborted();
    const header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
    if (header.length !== HEADER_BYTES || !MAGIC.every((byte, index) => header[index] === byte)) throw new Error('Unsupported encrypted backup.');
    const key = await archiveKey(root, header);
    let offset = HEADER_BYTES;
    let sequence = 0;
    while (offset + 4 <= file.size) {
      signal.throwIfAborted();
      const length = new DataView(await file.slice(offset, offset + 4).arrayBuffer()).getUint32(0);
      offset += 4;
      if (length < TAG_BYTES || length > FRAME_BYTES + TAG_BYTES || offset + length > file.size) break;
      const final = length === TAG_BYTES;
      const ciphertext = await file.slice(offset, offset + length).arrayBuffer();
      let plaintext: ArrayBuffer;
      try { plaintext = await crypto.subtle.decrypt(parameters(header, sequence++, final), key, ciphertext); }
      catch { throw new Error('Wrong recovery key or damaged encrypted backup.'); }
      signal.throwIfAborted();
      offset += length;
      if (final) {
        if (offset !== file.size) throw new Error('Unexpected data after the encrypted backup.');
        return;
      }
      yield new Uint8Array(plaintext);
    }
    throw new Error('The encrypted backup is incomplete.');
  }
  const frames = decode();
  return new ReadableStream({
    async pull(controller) {
      const next = await frames.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() { await frames.return(undefined); }
  });
}
