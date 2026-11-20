import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { workerCommand, pageCommand, flatCdp } from '../scripts/lib/recall-cdp.mjs';

function fixture() {
  const session = new EventEmitter(), browser = new EventEmitter();
  let request;
  session.send = async (_method, payload) => { request = JSON.parse(payload.message); };
  return { session, browser, request: () => request, clean() { assert.equal(session.listenerCount('Target.receivedMessageFromTarget'), 0); assert.equal(session.listenerCount('Target.detachedFromTarget'), 0); assert.equal(browser.listenerCount('disconnected'), 0); } };
}

test('CDP sampling resolves only the matching target and request response and releases its listeners', async () => {
  const state = fixture();
  const pending = workerCommand(state.session, state.browser, 'owned-worker', 'Runtime.getHeapUsage');
  let settled = false; pending.finally(() => { settled = true; });
  state.session.emit('Target.receivedMessageFromTarget', { sessionId: 'unrelated', message: JSON.stringify({ id: state.request().id, result: { usedSize: 1 } }) });
  state.session.emit('Target.receivedMessageFromTarget', { sessionId: 'owned-worker', message: JSON.stringify({ id: state.request().id + 1, result: { usedSize: 1 } }) });
  await Promise.resolve(); assert.equal(settled, false);
  state.session.emit('Target.receivedMessageFromTarget', { sessionId: 'owned-worker', message: JSON.stringify({ id: state.request().id, result: { usedSize: 400 } }) });
  assert.deepEqual(await pending, { usedSize: 400 }); state.clean();
});

test('worker detachment and browser interruption settle pending samples without waiting for a CDP reply', async () => {
  for (const fault of ['detach', 'disconnect']) {
    const state = fixture();
    const pending = workerCommand(state.session, state.browser, 'owned-worker', 'Runtime.getHeapUsage');
    const rejection = assert.rejects(pending, /detached|disconnected/);
    if (fault === 'detach') state.session.emit('Target.detachedFromTarget', { sessionId: 'owned-worker' }); else state.browser.emit('disconnected');
    await rejection; state.clean();
  }
});

test('a silent CDP target or rejected send cannot strand the benchmark or its cleanup', async () => {
  const silent = fixture();
  await assert.rejects(workerCommand(silent.session, silent.browser, 'owned-worker', 'Runtime.getHeapUsage', 5), /sample timed out/); silent.clean();
  const rejected = fixture(); rejected.session.send = async () => { throw Error('Protocol connection closed'); };
  await assert.rejects(workerCommand(rejected.session, rejected.browser, 'owned-worker', 'Runtime.getHeapUsage'), /Protocol connection closed/); rejected.clean();
});

test('a silent UI sampler settles within its instrumentation budget and removes its disconnect listener', async () => {
  const browser = new EventEmitter();
  await assert.rejects(pageCommand({ send: () => new Promise(() => {}) }, browser, 'Runtime.getHeapUsage', 5), /UI CDP sample timed out/);
  assert.equal(browser.listenerCount('disconnected'), 0);
  const pending = pageCommand({ send: () => new Promise(() => {}) }, browser, 'HeapProfiler.collectGarbage');
  const rejection = assert.rejects(pending, /disconnected/); browser.emit('disconnected'); await rejection;
  assert.equal(browser.listenerCount('disconnected'), 0);
});

test('the isolated CDP transport identifies a child reply by session and cancels every measurement on close', async () => {
  const sent = [], observed = [];
  class Socket extends EventTarget {
    send(text) { sent.push(JSON.parse(text)); }
    close() { this.dispatchEvent(new Event('close')); }
    receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  }
  const socket = new Socket();
  const protocol = flatCdp(socket, event => observed.push(event));
  const pending = protocol.send('Runtime.getHeapUsage', undefined, 'child');
  const { id } = sent[0];
  const attach = { method: 'Target.attachedToTarget', sessionId: 'offscreen-host', params: { sessionId: 'child', targetInfo: { type: 'worker' } } };
  socket.receive(attach);
  assert.deepEqual(observed, [attach]);
  socket.receive({ id, sessionId: 'sibling', result: { usedSize: 12 } });
  socket.receive({ id, sessionId: 'child', result: { usedSize: 100 } });
  assert.deepEqual(await pending, { usedSize: 100 });
  const closed = assert.rejects(protocol.send('Runtime.getHeapUsage', undefined, 'child'), /socket closed/u);
  protocol.close();
  await closed;
  await assert.rejects(protocol.send('Runtime.getHeapUsage', undefined, 'child'), /socket closed/u);
});
