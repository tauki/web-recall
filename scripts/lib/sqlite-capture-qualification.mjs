import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { withObservationDeadline } from './capture-qualification.mjs';
import { flatCdp, workerCommand } from './recall-cdp.mjs';

export async function withQualificationWorker(page, run) {
  const location = new URL(page.url());
  assert.equal(location.protocol, 'chrome-extension:', 'Worker probes require a disposable extension page');
  const context = page.context();
  const url = 'chrome-extension://' + location.host + '/dist/beta/background.js';
  const existing = context.serviceWorkers().find(worker => worker.url() === url);
  if (existing) {
    try { return await run((input, argument) => existing.evaluate(input, argument)); }
    catch (error) {
      if (!/Execution context was destroyed|Cannot find context with specified id|Target page, context or browser has been closed|Service worker restarted/u.test(String(error))) throw error;
    }
  }
  const reply = await withObservationDeadline(() => page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })),
    'wake the disposable background through its public settings read');
  assert.ok(reply?.settings && !reply.error, reply?.error || 'The public settings read must wake the disposable background');
  const browser = context.browser();
  const session = await withObservationDeadline(() => browser.newBrowserCDPSession(), 'connect to the disposable browser');
  let sessionId;
  try {
    const { targetInfos } = await withObservationDeadline(() => session.send('Target.getTargets'), 'locate the live disposable worker');
    const targets = targetInfos.filter(target => target.type === 'service_worker' && target.url === url);
    assert.equal(targets.length, 1, 'Expected one live background target for the disposable extension');
    ({ sessionId } = await withObservationDeadline(() => session.send('Target.attachToTarget', { targetId: targets[0].targetId, flatten: false }), 'attach to live disposable worker'));
    return await run(async (input, argument, timeoutMs = 15000) => {
      const expression = typeof input === 'string' ? input : '(' + input.toString() + ')(' + (JSON.stringify(argument) ?? '') + ')';
      const result = await workerCommand(session, browser, sessionId, 'Runtime.evaluate', timeoutMs, { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    });
  } finally {
    if (sessionId) await withObservationDeadline(() => session.send('Target.detachFromTarget', { sessionId }), 'detach the worker observer', 2000).catch(() => {});
    await withObservationDeadline(() => session.detach(), 'detach the browser observer', 2000).catch(() => {});
  }
}

export async function inspectSqliteAuthority(page, action) {
  const authority = await withObservationDeadline(() => page.evaluate(async () => (await chrome.storage.local.get('savedLibraryAuthority')).savedLibraryAuthority),
    'read the packaged authority identity');
  assert.ok(authority?.id && authority.phase === 'active' && authority.retired === true, 'An active and retired SQLite authority is required');
  const request = { id: authority.id, kind: action ? 'operate' : 'inspect', replacement: authority.source === 'backup', ...(action ? { action } : {}) };
  assert.ok(!action || ['read', 'job', 'jobs'].includes(action.op), 'The qualification observer may only read storage');
  const reply = await withQualificationWorker(page, evaluate => withObservationDeadline(
    () => evaluate(request => chrome.runtime.sendMessage({ type: 'OFFSCREEN_SAVED_LIBRARY', request }), request),
    'read the packaged SQLite ' + (action?.op || 'seal')));
  assert.ok(reply && !reply.error, reply?.error || 'Missing SQLite response');
  if (action) {
    assert.ok(Object.hasOwn(reply, 'value'), 'A SQLite read must return its result');
    return reply.value;
  }
  assert.equal(reply.library?.id, authority.id);
  assert.ok(Number.isSafeInteger(reply.library.pages) && Number.isSafeInteger(reply.library.processing));
  return reply.library;
}

let fixtureReader;
export async function inspectSqliteFrames(page, expression) {
  const modulePath = JSON.stringify(fileURLToPath(new URL('../../src/shared/libraryTransfer.ts', import.meta.url)));
  const contents = [
    'import { LIBRARY_PORT, requestLibraryFrames } from ' + modulePath + ';',
    'globalThis.qualificationReadSavedFrames = async action => {',
    '  if (action.op !== "pages") throw Error("The qualification frame reader may only read saved pages");',
    '  const authority = (await chrome.storage.local.get("savedLibraryAuthority")).savedLibraryAuthority;',
    '  if (!authority?.id || authority.phase !== "active" || authority.retired !== true) throw Error("Saved library is not active");',
    '  const result = await requestLibraryFrames(chrome.runtime.connect({ name: LIBRARY_PORT }),',
    '    { kind:"operate", id:authority.id, replacement:authority.source === "backup", action });',
    '  if (!Object.hasOwn(result, "value")) throw Error("Missing saved page result");',
    '  return result.value;',
    '};'
  ].join('\n');
  fixtureReader ??= build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, target: 'es2022', platform: 'browser', format: 'iife', logLevel: 'silent'
  }).then(result => result.outputFiles[0].text);
  const script = await fixtureReader;
  return withQualificationWorker(page, async evaluate => {
    await withObservationDeadline(() => evaluate(script), 'attach the read-only saved frame observer');
    return withObservationDeadline(() => evaluate(expression, undefined, 60000), 'inspect every saved version through the bounded SQLite reader', 60000);
  });
}

export async function sqliteJobIdentities(page) {
  const entries = [];
  let after, revision;
  do {
    const batch = await inspectSqliteAuthority(page, { op: 'jobs', after });
    assert.ok(Number.isSafeInteger(batch.revision) && (revision === undefined || revision === batch.revision), 'Job evidence changed during the scan');
    assert.ok(batch.after === null || (batch.after === batch.records.at(-1)?.url && (after === undefined || batch.after > after)),
      'The SQLite job cursor must advance');
    revision = batch.revision;
    after = batch.after ?? undefined;
    entries.push(...batch.records.map(({ url, status, textSaved, error, payload }) => ({ url, status, textSaved, error, captureId: payload?.captureId })));
  } while (after !== undefined);
  return entries;
}

async function connectDisposableDevTools(profile, onEvent) {
  const [port, pathname] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  assert.ok(/^\d{1,5}$/u.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[a-f0-9-]+$/u.test(pathname), 'Invalid disposable DevTools endpoint');
  const socket = new WebSocket('ws://127.0.0.1:' + port + pathname);
  const connection = flatCdp(socket, onEvent);
  try {
    await withObservationDeadline(() => new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(Error('Cannot observe the disposable browser')), { once: true });
    }), 'connect to the disposable browser');
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

async function attachOffscreen(page, connection) {
  const prefix = 'chrome-extension://' + new URL(page.url()).host + '/dist/beta/offscreen/';
  const filter = [{}];
  await connection.send('Target.setDiscoverTargets', { discover: true, filter });
  const { targetInfos } = await connection.send('Target.getTargets', { filter });
  const host = targetInfos.find(target => target.type === 'background_page' && target.url === prefix + 'index.html');
  assert.ok(host, 'The disposable saved library must have an active offscreen host');
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId: host.targetId, flatten: true });
  return { sessionId, prefix };
}

export async function auditOffscreenHttp(page, profile, probe) {
  const requests = [];
  let sessionId;
  const connection = await connectDisposableDevTools(profile, event => {
    if (event.sessionId !== sessionId || event.method !== 'Network.requestWillBeSent') return;
    if (/^https?:/u.test(event.params.request.url)) requests.push(event.params.request.url);
  });
  try {
    ({ sessionId } = await attachOffscreen(page, connection));
    await connection.send('Network.enable', undefined, sessionId);
    const result = await probe();
    await connection.send('Network.disable', undefined, sessionId);
    assert.deepEqual(requests, [], 'Probing recoverable local model state must not fetch files from the offscreen document');
    return result;
  } finally { connection.close(); }
}

export async function holdSqliteCommit(page, profile) {
  const children = new Map();
  const connection = await connectDisposableDevTools(profile, event => {
    if (event.method !== 'Target.attachedToTarget' || !event.sessionId || event.params.targetInfo.type !== 'worker') return;
    const workers = children.get(event.sessionId) ?? [];
    workers.push(event.params);
    children.set(event.sessionId, workers);
  });
  try {
    const { sessionId: hostSession, prefix } = await attachOffscreen(page, connection);
    const evaluate = async (targetSession, expression) => {
      const reply = await connection.send('Runtime.evaluate', { expression, returnByValue: true }, targetSession);
      assert.ok(!reply.exceptionDetails, reply.exceptionDetails?.exception?.description || 'OPFS observation failed');
      return reply.result.value;
    };
    const findChild = async (parent, expected) => {
      await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'worker' }] }, parent);
      const observed = new Map(), deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        for (const child of children.get(parent) || []) {
          if (!observed.has(child.sessionId)) observed.set(child.sessionId, child.targetInfo.url || await evaluate(child.sessionId, 'self.location.href'));
          if (observed.get(child.sessionId) === expected) return child.sessionId;
        }
        await delay(15);
      }
      throw Error('Missing disposable worker ' + expected + '; observed ' + [...observed.values()].join(', '));
    };
    const librarySession = await findChild(hostSession, prefix + 'libraryWorker.js');
    const sessionId = await findChild(librarySession, prefix + 'sqlite/sqlite3-opfs-async-proxy.js?vfs=opfs-wl');
    await evaluate(sessionId, '(' + function () {
      const original = FileSystemDirectoryHandle.prototype.removeEntry;
      FileSystemDirectoryHandle.prototype.removeEntry = async function (name, options) {
        if (name !== 'web-recall-library.sqlite3-journal') return original.call(this, name, options);
        const journal = await (await this.getFileHandle(name)).getFile();
        globalThis.qualificationCommit = { name, journalBytes: journal.size };
        return new Promise(() => {});
      };
    }.toString() + ')()');
    return {
      observe: () => evaluate(sessionId, 'globalThis.qualificationCommit'),
      close: () => connection.close()
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
