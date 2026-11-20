import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource, tick, waitFor } from './helpers.mjs';

const retained = 'Evidence from the earlier saved page.';
const current = 'Current evidence 🐢 '.repeat(20000);
const recoveryKey = 'WR1-' + Buffer.alloc(32, 41).toString('base64url');
const records = [
  { url: 'https://example.test/alpha', title: 'Alpha', timestamp: 3000, text: current, versionId: 'current',
    chunks: [{ text: current.slice(0, 20), embedding: [1, 2, 3] }],
    versions: [{ title: 'Earlier alpha', timestamp: 1000, text: retained, versionId: 'earlier', kept: true, chunks: [] }] },
  { url: 'https://example.test/beta', title: 'Beta', timestamp: 2000, text: 'Second saved page.', chunks: [] }
];

async function fixture({ onChunk = () => {}, allow = true, hasKey = true, legacy = false } = {}) {
  let revision = 10;
  let scheduled, alarm;
  const data = {};
  const connections = [];
  const codec = await loadSource('src/shared/encryptedBackup.ts', '', {}, { atob, btoa, ReadableStream });
  const key = await codec.importRecoveryKey(recoveryKey);
  const worker = await loadSource('src/background/manage/folderBackup.ts', '', {
    '../providers/apple': { APPLE_HOST: 'approved-host' },
    '../../shared/backupKey': { requireBackupKey: async () => {
      if (!hasKey) throw new Error('Set up a recovery key in Backup & restore first.');
      return key;
    } },
    '../storage/manager': { storageManager: { async getBackupBatch(cursor) {
      return { libraryId: '13eae341-6bf5-4e48-8daf-66a247086021', revision, page: records.find(record => !cursor || record.url > cursor) };
    } } },
    '../lifetime': { beginWorkerLease: () => () => {} }
  }, { btoa, chrome: {
    alarms: {
      async clear() { alarm = undefined; }, async get() { return alarm; }, create(name, delivery) { alarm = { name, delivery }; },
      onAlarm: { addListener(callback) { scheduled = callback; } }
    },
    storage: { local: { async get(key) { return { [key]: data[key] }; }, async set(update) { Object.assign(data, update); } } },
    permissions: { async contains() { return allow; } },
    runtime: { connectNative() {
      let receive;
      const connection = { chunks: [], finished: false, closed: false };
      connections.push(connection);
      return {
        onDisconnect: { addListener() {} }, onMessage: { addListener(callback) { receive = callback; } },
        disconnect() { connection.closed = true; },
        postMessage(message) {
          let type;
          if (message.action === 'backup_begin_encrypted') { connection.begin = message; type = legacy ? 'backup_ready' : 'backup_ready_encrypted'; }
          if (message.action === 'backup_chunk') {
            const bytes = Buffer.from(message.data, 'base64');
            assert.ok(bytes.length < 1024 * 1024, 'A single native message must not carry the full library or large frame');
            connection.chunks.push(bytes);
            onChunk(connection);
            type = 'backup_ack';
          }
          if (message.action === 'backup_finish') { connection.finished = true; type = 'backup_saved'; }
          receive({ id: message.id, type });
        }
      };
    } }
  } });
  return { worker, connections, decrypt: file => codec.decryptBackup(file, key, new AbortController().signal),
    changeRevision: () => revision++, fireAlarm: () => scheduled(alarm), getAlarm: () => alarm };
}

test('folder backup defaults to three copies, is opt-in, and streams restorable historical pages on enable', async () => {
  const { worker, connections, getAlarm, fireAlarm, decrypt } = await fixture();
  worker.bindFolderBackups();
  await tick();
  assert.equal(getAlarm(), undefined);
  assert.equal(connections.length, 0);
  assert.equal((await worker.getFolderBackup()).keep, 3);
  await worker.setFolderBackup(true, 3);
  await waitFor(() => connections[0]?.closed, 'enabled backup to finish');
  assert.equal(connections[0].begin.keep, 3);
  assert.ok(connections[0].finished);
  const transfer = Buffer.concat(connections[0].chunks);
  assert.ok(!transfer.includes(retained) && !transfer.includes(records[0].url) && !transfer.includes(recoveryKey));
  assert.ok(!JSON.stringify(connections[0].begin).includes(recoveryKey));
  const files = await loadSource('src/shared/backupFrames.ts', '', {}, { ReadableStream });
  const archive = new Blob([transfer]);
  assert.equal(await files.validateBackup(decrypt(archive)), 2);
  const saved = (await new Response(decrypt(archive)).text()).trim().split('\n').map(JSON.parse);
  assert.equal(saved.find(frame => frame.type === 'version').version.text, retained);
  assert.equal(saved.find(frame => frame.type === 'page').page.text, current);
  assert.ok((await worker.getFolderBackup()).savedAt);
  fireAlarm();
  await tick();
  assert.equal(connections.length, 1, 'Repeated delivery on the same day must not create another backup');
  await worker.setFolderBackup(false, 2);
  assert.equal(getAlarm(), undefined);
  await worker.runFolderBackup();
  assert.equal(connections[1].begin.keep, 2);
});

test('folder backup cannot schedule or send any content without a key and rejects an older companion', async () => {
  const missing = await fixture({ hasKey: false });
  await assert.rejects(missing.worker.setFolderBackup(true, 3), /Set up a recovery key/);
  await assert.rejects(missing.worker.runFolderBackup(), /Set up a recovery key/);
  assert.equal(missing.getAlarm(), undefined);
  assert.equal(missing.connections.length, 0);
  const legacy = await fixture({ legacy: true });
  await assert.rejects(legacy.worker.runFolderBackup(), /Update the Mac companion/);
  assert.equal(legacy.connections[0].chunks.length, 0);
  assert.equal(legacy.connections[0].finished, false);
});

test('a mid-stream library write never publishes a mixed backup', async () => {
  let changeRevision;
  const { worker, connections, changeRevision: change } = await fixture({ onChunk: () => changeRevision() });
  changeRevision = change;
  await assert.rejects(worker.runFolderBackup(), /library changed while exporting/);
  assert.ok(connections[0].closed);
  assert.equal(connections[0].finished, false);
  assert.equal((await worker.getFolderBackup()).savedAt, undefined);
});

test('folder backups do not contact the companion without permission', async () => {
  const { worker, connections } = await fixture({ allow: false });
  await assert.rejects(worker.runFolderBackup(), /Allow the Mac companion/);
  assert.equal(connections.length, 0);
});

test('portable JSON and Markdown export only the requested current pages, without embeddings or old versions', async () => {
  const exporter = await loadSource('src/background/manage/backupSnapshot.ts', '', {
    '../storage/manager': { storageManager: { async getBackupBatch(cursor) {
      return { libraryId: 'one-library', revision: 1, page: records.find(record => !cursor || record.url > cursor) };
    } } }
  });
  const signal = new AbortController().signal;
  const getExport = async (format, urls) => {
    const options = exporter.exportOptions(format, urls);
    let output = '';
    for await (const chunk of exporter.exportSnapshot(await exporter.openBackupSnapshot(signal), signal, options.format, options.scope)) output += chunk.line;
    return output;
  };
  assert.deepEqual(JSON.parse(await getExport('json', [records[0].url])).pages, [
    { title: 'Alpha', url: 'https://example.test/alpha', capturedAt: '1970-01-01T00:00:03.000Z', text: current }
  ]);
  const markdown = await getExport('markdown', [records[1].url]);
  assert.match(markdown, /^## Beta$/m);
  assert.match(markdown, /Second saved page\./);
  assert.doesNotMatch(markdown, /Alpha|Earlier alpha/);
  assert.deepEqual(JSON.parse(await getExport('json')).pages.map(page => page.url), [records[0].url, records[1].url]);
});
