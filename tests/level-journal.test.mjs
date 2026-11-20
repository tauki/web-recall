import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureLevelJournals, inspectLevelJournal, replayClosedJournalTail } from '../scripts/lib/level-journal.mjs';

const empty = Buffer.from('052b2843000001', 'hex');
const passage = Buffer.from('bfc4f1df0e0001536176656420706173736167652e', 'hex');
const lastFragment = Buffer.from('2d0c0a650e0004536176656420706173736167652e', 'hex');

test('an incomplete LevelDB final write is distinct from a full bad checksum', () => {
  const truncatedHeader = inspectLevelJournal(Buffer.concat([empty, passage.subarray(0, 3)]));
  assert.deepEqual(truncatedHeader.incompleteTail, { kind: 'partial-header', offset: empty.length });
  assert.equal(truncatedHeader.firstIssue, undefined);
  const partial = Buffer.concat([empty, passage.subarray(0, -1)]);
  const truncated = inspectLevelJournal(partial);
  assert.equal(truncated.verifiedFragments, 1);
  assert.deepEqual(truncated.incompleteTail, { kind: 'partial-payload', offset: empty.length });
  assert.equal(truncated.firstIssue, undefined);
  const complete = Buffer.concat([empty, passage]);
  assert.deepEqual(inspectLevelJournal(complete), { verifiedFragments: 2, lastVerifiedEnd: complete.length, zeroHeaderBlocks: 0 });
  complete[complete.length - 1] ^= 1;
  assert.deepEqual(inspectLevelJournal(complete).firstIssue, { kind: 'checksum-mismatch', offset: empty.length });
});

test('LevelDB trailer bytes cannot be interpreted as a new header or left nonzero', () => {
  const firstBlock = Buffer.concat([Buffer.from('d8d81e0cf47f01', 'hex'), Buffer.alloc(32756, 97), Buffer.alloc(5)]);
  const snapshot = Buffer.concat([firstBlock, passage]);
  assert.equal(firstBlock.length, 32768);
  assert.equal(inspectLevelJournal(snapshot).verifiedFragments, 2);
  assert.equal(inspectLevelJournal(firstBlock.subarray(0, -2)).incompleteTail, undefined);
  snapshot[32768 + passage.length - 1] ^= 1;
  assert.deepEqual(inspectLevelJournal(snapshot).firstIssue, { kind: 'checksum-mismatch', offset: 32768 });
  snapshot[32765] = 1;
  assert.deepEqual(inspectLevelJournal(snapshot).firstIssue, { kind: 'nonzero-block-trailer', offset: 32763 });
  const impossible = Buffer.from('00000000ffff01', 'hex');
  assert.deepEqual(inspectLevelJournal(impossible).firstIssue, { kind: 'length-outside-block', offset: 0 });
  assert.equal(inspectLevelJournal(impossible).incompleteTail, undefined);
});

test('a checksummed FIRST fragment at EOF only proves physical bytes; its LAST can complete the next block', () => {
  const start = Buffer.concat([Buffer.from('660a1dd5f97f02', 'hex'), Buffer.alloc(32761, 97)]);
  assert.equal(start.length, 32768);
  assert.deepEqual(inspectLevelJournal(start), { verifiedFragments: 1, lastVerifiedEnd: 32768, zeroHeaderBlocks: 0 });
  const finished = Buffer.concat([start, lastFragment]);
  assert.deepEqual(inspectLevelJournal(finished), { verifiedFragments: 2, lastVerifiedEnd: finished.length, zeroHeaderBlocks: 0 });
});

test('closed-profile evidence distinguishes an appended journal from a replaced prefix without disclosing the payload', async context => {
  const profile = await mkdtemp(path.join(tmpdir(), 'level-journal-test-'));
  context.after(() => rm(profile, { recursive: true, force: true }));
  const extensionId = 'abcdefghijklmnop'.repeat(2);
  const directory = path.join(profile, 'Default', 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`);
  await mkdir(directory, { recursive: true });
  const journal = path.join(directory, '000003.log');
  await writeFile(journal, passage);
  await writeFile(path.join(directory, '000004.log'), Buffer.alloc(1024 * 1024 + 1));
  await symlink(journal, path.join(directory, '000005.log'));
  const before = await captureLevelJournals(profile, extensionId);
  assert.equal(before['000003.log'].verifiedFragments, 1);
  assert.match(before['000004.log'].observationError, /small regular journal/u);
  assert.equal(before['000005.log'], undefined);
  await writeFile(journal, Buffer.concat([passage, empty]));
  const appended = await captureLevelJournals(profile, extensionId, before);
  assert.equal(appended['000003.log'].previousBytesUnchanged, true);
  assert.equal(appended['000003.log'].verifiedFragments, 2);
  assert.ok(!JSON.stringify(appended).includes('Saved passage.'));
  await writeFile(journal, Buffer.concat([empty, passage]));
  const replaced = await captureLevelJournals(profile, extensionId, before);
  assert.equal(replaced['000003.log'].previousBytesUnchanged, false);
  assert.equal(replaced['000003.log'].verifiedFragments, 2);
});

test('journal observation refuses a symlinked parent even when the target contains plausible files', async context => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'level-journal-path-test-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const profile = path.join(temporary, 'profile');
  const external = path.join(temporary, 'outside-profile');
  const extensionId = 'abcdefghijklmnop'.repeat(2);
  const directory = path.join(external, 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`);
  await mkdir(profile);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, '000003.log'), passage);
  await symlink(external, path.join(profile, 'Default'), 'dir');
  await assert.rejects(captureLevelJournals(profile, extensionId), /does not resolve inside the owned profile/u);
});

test('the disposable replay preserves the prior journal and makes the checksum fail at the torn write', async context => {
  const owned = await mkdtemp(path.join(tmpdir(), 'web-recall-capture-qualification-'));
  context.after(() => rm(owned, { recursive: true, force: true }));
  const profile = path.join(owned, 'fixture'), extensionId = 'abcdefghijklmnop'.repeat(2);
  const directory = path.join(profile, 'Default', 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`);
  await mkdir(directory, { recursive: true });
  const journal = path.join(directory, '000003.log');
  const otherwiseSimilar = path.join(directory, 'MANIFEST-000001');
  await writeFile(journal, passage);
  await writeFile(otherwiseSimilar, empty);
  const result = await replayClosedJournalTail(owned, profile, extensionId);
  const bytes = await readFile(journal);
  assert.deepEqual(bytes.subarray(0, passage.length), passage);
  assert.deepEqual(await readFile(otherwiseSimilar), empty);
  assert.deepEqual(inspectLevelJournal(bytes.subarray(0, passage.length + 7)).incompleteTail, { kind: 'partial-payload', offset: passage.length });
  assert.deepEqual(inspectLevelJournal(bytes).firstIssue, { kind: 'checksum-mismatch', offset: passage.length });
  assert.equal(result.unchangedPrefix, true);
  assert.ok(!JSON.stringify(result).includes('Saved passage.'));
  await assert.rejects(replayClosedJournalTail(owned, profile, extensionId), /checksummed journal/u);
  assert.deepEqual(await readFile(journal), bytes, 'Replay must not append to an already damaged file');
});

test('the fault writer refuses a profile outside its explicitly owned scratch directory', async context => {
  const owned = await mkdtemp(path.join(tmpdir(), 'web-recall-capture-qualification-'));
  const other = await mkdtemp(path.join(tmpdir(), 'level-journal-other-'));
  context.after(() => Promise.all([owned, other].map(directory => rm(directory, { recursive: true, force: true }))));
  const extensionId = 'abcdefghijklmnop'.repeat(2);
  const backing = path.join(other, 'Default', 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`);
  await mkdir(backing, { recursive: true });
  const journal = path.join(backing, '000003.log');
  await writeFile(journal, passage);
  const linkedProfile = path.join(owned, 'profile');
  await symlink(other, linkedProfile, 'dir');
  await assert.rejects(replayClosedJournalTail(owned, linkedProfile, extensionId), /disposable qualification/u);
  const profile = path.join(owned, 'hard-link');
  const profileBacking = path.join(profile, 'Default', 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`);
  await mkdir(profileBacking, { recursive: true });
  await link(journal, path.join(profileBacking, '000003.log'));
  await assert.rejects(replayClosedJournalTail(owned, profile, extensionId), /linked outside/u);
  assert.deepEqual(await readFile(journal), passage);
});
