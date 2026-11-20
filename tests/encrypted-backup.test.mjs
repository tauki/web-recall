import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { loadSource } from './helpers.mjs';

const codec = () => loadSource('src/shared/encryptedBackup.ts', '', {}, { atob, btoa, ReadableStream });
const signal = new AbortController().signal;

test('encrypted backup bytes independently decrypt using AES-256-GCM and a per-archive key', async () => {
  const { createRecoveryKey, importRecoveryKey, encryptBackup } = await codec();
  const recovery = createRecoveryKey();
  const root = await importRecoveryKey(recovery);
  const evidence = Buffer.from('A confidential saved page 🐢');
  const source = async function* () { yield evidence.subarray(0, 5); yield evidence.subarray(5); };
  const encrypt = async () => {
    const parts = [];
    for await (const part of encryptBackup(source(), root, signal)) parts.push(Buffer.from(part));
    return parts;
  };
  const [header, frame, end] = await encrypt();
  const [anotherHeader, anotherFrame] = await encrypt();
  assert.equal(root.extractable, false);
  assert.notDeepEqual(header, anotherHeader);
  assert.notDeepEqual(frame, anotherFrame);
  assert.ok(!Buffer.concat([header, frame, end]).includes(evidence));
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(recovery.slice(4), 'base64url'), header.subarray(5), Buffer.from('WRBK1'), 32));
  const independentlyOpen = (encrypted, sequence, final) => {
    const iv = Buffer.alloc(12); iv.writeUInt32BE(sequence, 8);
    const tagLength = 16;
    const body = encrypted.subarray(4, -tagLength);
    assert.equal(encrypted.readUInt32BE(0), body.length + tagLength);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.concat([header, iv.subarray(8), Buffer.from([Number(final)])]));
    decipher.setAuthTag(encrypted.subarray(-tagLength));
    return Buffer.concat([decipher.update(body), decipher.final()]);
  };
  assert.deepEqual(independentlyOpen(frame, 0, false), evidence);
  assert.deepEqual(independentlyOpen(end, 1, true), Buffer.alloc(0));
});

test('restore rejects the wrong key, changed bytes, missing authenticated end and extra data', async () => {
  const { createRecoveryKey, importRecoveryKey, encryptBackup, decryptBackup } = await codec();
  const root = await importRecoveryKey(createRecoveryKey());
  const other = await importRecoveryKey(createRecoveryKey());
  const evidence = Buffer.alloc(700000, 84);
  const source = async function* () { yield evidence; };
  const parts = [];
  for await (const part of encryptBackup(source(), root, signal)) parts.push(Buffer.from(part));
  const open = async (bytes, key = root) => {
    const chunks = [];
    for await (const part of decryptBackup(new Blob(bytes), key, signal)) chunks.push(part);
    return Buffer.concat(chunks);
  };
  assert.deepEqual(await open(parts), evidence);
  await assert.rejects(open(parts, other), /Wrong recovery key/);
  const changed = Buffer.from(parts[1]); changed[changed.length - 1] ^= 1;
  await assert.rejects(open([parts[0], changed, ...parts.slice(2)]), /damaged encrypted backup/);
  await assert.rejects(open([parts[0], parts[2], parts[1], ...parts.slice(3)]), /damaged encrypted backup/);
  await assert.rejects(open(parts.slice(0, -1)), /incomplete/);
  await assert.rejects(open([...parts, Buffer.from('trailing')]), /Unexpected data/);
});
