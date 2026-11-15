import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain } from './helpers.mjs';

export function providerFixture(baseUrl = 'https://models.example.test', acknowledged = [], offscreenOverrides = {}) {
  const stored = {
    betaSettings: { paused: true, captureSetupComplete: true, acknowledgedRemoteProviderOrigins: acknowledged },
    betaProviderSettings: { ollama: { baseUrl } }
  };
  const requests = [], listeners = [];
  const failingWrites = new Set();
  const chrome = {
    runtime: { sendMessage() {}, getURL: path => path, onMessage: { addListener: listener => listeners.push(listener) } },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, callback) { callback(Object.fromEntries(keys.map(key => [key, stored[key]]))); },
        set(values, callback) {
          const key = Object.keys(values).find(key => failingWrites.has(key));
          if (key) {
            failingWrites.delete(key);
            chrome.runtime.lastError = new Error('Storage write failed');
            callback?.();
            delete chrome.runtime.lastError;
          } else { Object.assign(stored, plain(values)); callback?.(); }
        }
      }
    }
  };
  const mocks = {
    '../../shared/logger/index': { setLogLevel() {}, log: async () => {} },
    '../models/index': { getModelSettings: async () => ({ chatModel: 'chosen-model' }), updateModelSettings: async () => assert.fail('Consent must not change model selection') },
    '../offscreen/index': { ensureOffscreenDocument: async () => {}, sendOffscreenMessage: async () => ({}), invalidateOffscreenIndex: async () => {}, ...offscreenOverrides }
  };
  const context = {
    chrome, indexedDB: new IDBFactory(), IDBKeyRange,
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method || 'GET', body, acknowledged: [...stored.betaSettings.acknowledgedRemoteProviderOrigins] });
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/api/tags')) return Response.json({ models: [{ name: 'chosen-model' }] });
      if (pathname.endsWith('/api/chat')) {
        if (body.stream) return new Response('{"message":{"content":"A sourced answer."}}\n{"done":true}\n');
        return Response.json({ message: { content: 'A sourced answer.' } });
      }
      if (pathname.endsWith('/api/embed')) return Response.json({ embeddings: [[0.25, 0.75]] });
      if (pathname === '/' || pathname === '/path/') return new Response('Ollama is running');
      assert.fail(`Unexpected provider request: ${url}`);
    }
  };
  const load = (source, overrides = {}) => loadSource(source, '', mocks, { TextEncoder, ...context, ...overrides });
  const send = message => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`No response to ${message.type}`)), 5000);
    const respond = value => { clearTimeout(timer); resolve(value); };
    try {
      for (const listener of listeners) {
        let answered = false;
        const pending = listener(message, {}, value => { answered = true; respond(value); });
        if (answered || pending === true) return;
      }
      throw Error(`No listener handles ${message.type}`);
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  return { stored, requests, load, send, failNextWrite: key => failingWrites.add(key), connect: async () => (await load('src/background/orchestration/index.ts')).orchestrateLifecycle() };
}
