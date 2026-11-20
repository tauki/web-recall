import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fingerprint } from './capture-qualification.mjs';

const BLOCK_BYTES = 32768;
const HEADER_BYTES = 7;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 8;
const CRC32C = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  return crc;
});

function maskedChecksum(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset++) crc = (crc >>> 8) ^ CRC32C[(crc ^ bytes[offset]) & 0xff];
  crc ^= 0xffffffff;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

export function inspectLevelJournal(bytes) {
  const evidence = { verifiedFragments: 0, lastVerifiedEnd: 0, zeroHeaderBlocks: 0 };
  for (let block = 0; block < bytes.length; block += BLOCK_BYTES) {
    const blockLimit = block + BLOCK_BYTES;
    const blockEnd = Math.min(blockLimit, bytes.length);
    for (let offset = block; offset < blockEnd;) {
      if (blockLimit - offset < HEADER_BYTES) {
        if (bytes.subarray(offset, blockEnd).some(byte => byte !== 0)) {
          evidence.firstIssue = { kind: 'nonzero-block-trailer', offset };
          return evidence;
        }
        break;
      }
      if (blockEnd - offset < HEADER_BYTES) {
        evidence.incompleteTail = { kind: 'partial-header', offset };
        break;
      }
      const length = bytes.readUInt16LE(offset + 4), type = bytes[offset + 6];
      const end = offset + HEADER_BYTES + length;
      if (end > blockLimit) {
        evidence.firstIssue = { kind: 'length-outside-block', offset };
        return evidence;
      }
      if (end > blockEnd) {
        evidence.incompleteTail = { kind: 'partial-payload', offset };
        return evidence;
      }
      if (type === 0 && length === 0) { evidence.zeroHeaderBlocks++; break; }
      if (bytes.readUInt32LE(offset) !== maskedChecksum(bytes, offset + 6, end)) {
        evidence.firstIssue = { kind: 'checksum-mismatch', offset };
        return evidence;
      }
      evidence.verifiedFragments++;
      evidence.lastVerifiedEnd = end;
      offset = end;
    }
  }
  return evidence;
}

async function readJournalBytes(handle) {
  const metadata = await handle.stat({ bigint: true });
  if (!metadata.isFile() || metadata.size > BigInt(MAX_FILE_BYTES)) throw new Error('Not a supported small regular journal file');
  const bytes = Buffer.alloc(Number(metadata.size));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  const after = await handle.stat({ bigint: true });
  if (bytesRead !== bytes.length || metadata.size !== after.size || metadata.mtimeNs !== after.mtimeNs || metadata.ctimeNs !== after.ctimeNs) throw new Error('The journal changed during the snapshot');
  return bytes;
}

async function readClosedFile(filename, previous) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = await readJournalBytes(handle);
    return {
      bytes: bytes.length,
      sha256: fingerprint(bytes),
      ...inspectLevelJournal(bytes),
      ...(previous?.sha256 ? { previousBytes: previous.bytes, previousBytesUnchanged: bytes.length >= previous.bytes && fingerprint(bytes.subarray(0, previous.bytes)) === previous.sha256 } : {})
    };
  } finally { await handle.close(); }
}

async function journalDirectory(profile, extensionId) {
  if (!/^[a-p]{32}$/u.test(extensionId)) throw new Error('Expected the disposable extension identity');
  const directory = path.join(await fs.realpath(profile), 'Default', 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`);
  if (await fs.realpath(directory) !== directory) throw new Error('The journal directory does not resolve inside the owned profile path');
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory()) throw new Error('Expected the disposable extension backing store directory');
  return directory;
}

export async function captureLevelJournals(profile, extensionId, previous = {}) {
  const directory = await journalDirectory(profile, extensionId);
  const files = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^(?:\d+\.log|MANIFEST-\d+)$/u.test(entry.name)).map(entry => entry.name).sort();
  if (!files.length || files.length > MAX_FILES) throw new Error('Not a supported small LevelDB backing store');
  return Object.fromEntries(await Promise.all(files.map(async name => {
    try { return [name, await readClosedFile(path.join(directory, name), previous[name])]; }
    catch (error) { return [name, { observationError: String(error) }]; }
  })));
}

function encodePhysicalRecord(payload) {
  const record = Buffer.alloc(HEADER_BYTES + payload.length);
  record.writeUInt16LE(payload.length, 4);
  record[6] = 1;
  payload.copy(record, HEADER_BYTES);
  record.writeUInt32LE(maskedChecksum(record, 6, record.length), 0);
  return record;
}

export async function replayClosedJournalTail(ownedRoot, profile, extensionId) {
  const temporary = await fs.realpath(tmpdir());
  const owned = await fs.realpath(ownedRoot);
  if (path.dirname(owned) !== temporary || !path.basename(owned).startsWith('web-recall-capture-qualification-') ||
      path.resolve(owned, path.basename(profile)) !== await fs.realpath(profile) || path.dirname(path.resolve(profile)) !== path.resolve(ownedRoot)) {
    throw new Error('Journal replay requires a profile created by this disposable qualification.');
  }
  const directory = await journalDirectory(profile, extensionId);
  const candidates = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => /^\d+\.log$/u.test(entry.name));
  if (candidates.length !== 1 || !candidates[0].isFile()) throw new Error('Replay needs exactly one regular LevelDB journal.');
  const journal = candidates[0].name;
  const handle = await fs.open(path.join(directory, journal), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if ((await handle.stat()).nlink !== 1) throw new Error('Replay refuses a journal linked outside its single owned file.');
    const before = await readJournalBytes(handle);
    const clean = inspectLevelJournal(before);
    if (!clean.verifiedFragments || clean.lastVerifiedEnd !== before.length || clean.firstIssue || clean.incompleteTail) {
      throw new Error('Replay requires a nonempty checksummed journal ending at a fragment boundary.');
    }
    const tornHeader = encodePhysicalRecord(Buffer.from('interrupted physical record')).subarray(0, HEADER_BYTES);
    const following = encodePhysicalRecord(Buffer.from('a distinct record written after opening the first journal again'));
    const room = BLOCK_BYTES - before.length % BLOCK_BYTES;
    const padding = room < tornHeader.length + following.length ? room : 0;
    const fragmentOffset = before.length + padding;
    const tail = Buffer.concat([Buffer.alloc(padding), tornHeader]);
    if (fragmentOffset + tornHeader.length + following.length > MAX_FILE_BYTES) throw new Error('Replay would exceed the small journal limit.');
    const append = async (bytes, at) => {
      if ((await handle.write(bytes, 0, bytes.length, at)).bytesWritten !== bytes.length) throw new Error('Incomplete write in the disposable replay.');
      await handle.sync();
    };
    await append(tail, before.length);
    const torn = await readJournalBytes(handle);
    const incomplete = inspectLevelJournal(torn);
    if (incomplete.firstIssue || incomplete.incompleteTail?.kind !== 'partial-payload' ||
        incomplete.incompleteTail.offset !== fragmentOffset || !torn.subarray(0, before.length).equals(before)) {
      throw new Error('Replay did not produce the expected incomplete tail.');
    }
    await append(following, torn.length);
    const replayed = await readJournalBytes(handle);
    const corrupted = inspectLevelJournal(replayed);
    if (corrupted.firstIssue?.kind !== 'checksum-mismatch' || corrupted.firstIssue.offset !== fragmentOffset ||
        !replayed.subarray(0, torn.length).equals(torn)) throw new Error('Replay did not reproduce the checksum failure at the torn header.');
    return { journal, before: { bytes: before.length, sha256: fingerprint(before) },
      torn: { bytes: torn.length, sha256: fingerprint(torn), ...incomplete },
      replayed: { bytes: replayed.length, sha256: fingerprint(replayed), ...corrupted }, unchangedPrefix: true };
  } finally { await handle.close(); }
}
