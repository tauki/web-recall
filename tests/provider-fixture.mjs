import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { loadSource, plain } from './helpers.mjs';
import { installRuntimePorts } from './runtime-ports.mjs';

export function providerFixture(baseUrl = 'https://models.example.test', acknowledged = [], offscreenOverrides = {}) {
  const stored = {
    betaSettings: { paused: true, captureSetupComplete: true, acknowledgedRemoteProviderOrigins: acknowledged },
    betaProviderSettings: { ollama: { baseUrl } }
  };
  const requests = [], listeners = [];
  const failingWrites = new Set();
  let activeTabUrl = 'https://example.test/article';
  const chrome = {
    tabs: { query: async () => [{ id: 7, url: activeTabUrl }] },
    runtime: { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sendMessage() {}, getURL: path => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${path}`, onMessage: { addListener: listener => listeners.push(listener) } },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, callback) {
          const names = typeof keys === 'string' ? [keys] : keys;
          const values = Object.fromEntries(names.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]));
          return callback ? callback(values) : Promise.resolve(values);
        },
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
  const ports = installRuntimePorts(chrome.runtime);
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
  const send = (message, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('dist/beta/ui/sidepanel/index.html') }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`No response to ${message.type}`)), 5000);
    const respond = value => { clearTimeout(timer); resolve(value); };
    try {
      for (const listener of listeners) {
        let answered = false;
        const pending = listener(message, sender, value => { answered = true; respond(value); });
        if (answered || pending === true) return;
      }
      throw Error(`No listener handles ${message.type}`);
    } catch (error) { clearTimeout(timer); reject(error); }
  });
  return { stored, requests, load, send, chrome, runtime: chrome.runtime, ports, setActiveTab: url => { activeTabUrl = url; }, failNextWrite: key => failingWrites.add(key), connect: async () => (await load('src/background/orchestration/index.ts')).orchestrateLifecycle() };
}
