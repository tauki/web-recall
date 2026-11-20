import { deflateSync, inflateSync } from 'fflate/browser';

const HEADER_BYTES = 8;
const RAW_TEXT_FLAG = 0x80000000;
const MAX_COMPRESSED_RECORD = 128 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
let crcTable: Uint32Array | undefined;

export function checksum(bytes: Uint8Array): number {
  const table = crcTable ??= Uint32Array.from({ length: 256 }, (_, byte) => {
    let value = byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    return value;
  });
  let value = 0xffffffff;
  for (let offset = 0; offset < bytes.length; offset++) value = (value >>> 8) ^ table[(value ^ bytes[offset]!) & 255]!;
  return (~value) >>> 0;
}

export function packSqlitePayload(text: string): Uint8Array | string {
  if (text.length < 1024 || text.length > MAX_COMPRESSED_RECORD) return text;
  const raw = encoder.encode(text);
  if (raw.length > MAX_COMPRESSED_RECORD) return text;
  const compressed = deflateSync(raw, { level: 1 });
  if (compressed.length + HEADER_BYTES >= raw.length) return text;
  return wrapPayload(compressed, raw.length);
}

export function packSearchProjection(text: string): Uint8Array {
  const raw = encoder.encode(text);
  if (raw.length >= RAW_TEXT_FLAG) throw new Error('Saved search projection exceeds the supported SQLite column size.');
  return wrapPayload(raw, raw.length + RAW_TEXT_FLAG);
}

function wrapPayload(bytes: Uint8Array, marker: number): Uint8Array {
  const payload = new Uint8Array(bytes.length + HEADER_BYTES);
  const header = new DataView(payload.buffer);
  header.setUint32(0, marker);
  header.setUint32(4, checksum(bytes));
  payload.set(bytes, HEADER_BYTES);
  return payload;
}

function readPayload(value: unknown) {
  if (!(value instanceof Uint8Array) || value.length <= HEADER_BYTES) throw new Error('Invalid saved library payload.');
  const header = new DataView(value.buffer, value.byteOffset, HEADER_BYTES);
  const marker = header.getUint32(0);
  const storedRaw = marker >= RAW_TEXT_FLAG;
  const size = storedRaw ? marker - RAW_TEXT_FLAG : marker;
  if (!size || (storedRaw ? size !== value.length - HEADER_BYTES : size > MAX_COMPRESSED_RECORD || value.length >= size)) {
    throw new Error('Invalid saved library payload size.');
  }
  return { size, storedRaw, checksum: header.getUint32(4), data: value.subarray(HEADER_BYTES) };
}

export function sqlitePayloadSize(value: unknown): number {
  return typeof value === 'string' ? value.length : readPayload(value).size;
}

export function unpackSqlitePayload(value: unknown): string {
  if (typeof value === 'string') return value;
  const { size, storedRaw, checksum: expected, data } = readPayload(value);
  if (checksum(data) !== expected) throw new Error('Saved library payload failed its checksum.');
  if (storedRaw) return decoder.decode(data);
  const raw = inflateSync(data, { out: new Uint8Array(size + 1) });
  if (raw.length !== size) throw new Error('Saved library payload has the wrong decoded size.');
  return decoder.decode(raw);
}
