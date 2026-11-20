import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSource } from './helpers.mjs';

test('Stop during a framed storage upload releases the connection before any write reaches its owner', async () => {
  const { requestLibraryFrames, acceptLibraryFrames } = await loadSource('src/shared/libraryTransfer.ts');
  const frames = [], acks = [];
  let clientMessage, hostMessage, hostDisconnected, clientDisconnected, writes = 0;
  const client = {
    postMessage: message => frames.push(message),
    disconnect: () => { hostDisconnected(); clientDisconnected(); },
    onMessage: { addListener: listener => { clientMessage = listener; } },
    onDisconnect: { addListener: listener => { clientDisconnected = listener; } }
  };
  const host = {
    postMessage: message => acks.push(message),
    onMessage: { addListener: listener => { hostMessage = listener; } },
    onDisconnect: { addListener: listener => { hostDisconnected = listener; } }
  };
  acceptLibraryFrames(host, () => { writes++; });
  const controller = new AbortController();
  const result = requestLibraryFrames(client, { page: 'a'.repeat(2 * 1024 * 1024) }, controller.signal);
  const rejected = assert.rejects(result, /Stopped by user/u);
  assert.equal(frames.length, 1);
  hostMessage(frames[0]);
  assert.equal(acks.length, 1);
  controller.abort(Error('Stopped by user'));
  await rejected;
  clientMessage(acks[0]);
  assert.equal(frames.length, 1, 'A late transfer acknowledgment must not restart a stopped upload');
  assert.equal(writes, 0);
});
