import { providerFixture } from './provider-fixture.mjs';
import { tick } from './helpers.mjs';

export const recallPage = { url: 'https://recall.test/field-notes', title: 'Coastal field notes', text: 'Copper terns migrate along the coast. Their nests sit above the high tide line.', chunks: ['Copper terns migrate along the coast. Their nests sit above the high tide line.'], timestamp: 100 };

export async function recallFixture(testContext, { fetch, initial, offscreen = {} } = {}) {
  const backend = providerFixture('http://localhost:11434', [], offscreen);
  for (const key of Object.keys(backend.stored)) delete backend.stored[key];
  Object.assign(backend.stored, initial);
  const broadcasts = [];
  let document = recallPage, nativeCalls = 0;
  backend.runtime.sendMessage = message => { broadcasts.push(message); return Promise.resolve(); };
  backend.runtime.connectNative = () => { nativeCalls++; throw Error('No native companion installed'); };
  backend.chrome.sidePanel = { setPanelBehavior: async () => {} };
  backend.chrome.tabs.get = async () => ({ id: 7, url: document.url, title: document.title });
  backend.chrome.tabs.sendMessage = async (_tab, message) => {
    if (message.type !== 'FORCE_CAPTURE') throw Error(`Unexpected content request ${message.type}`);
    const result = await backend.send({ type: 'SAVE_PAGE', ...document, manual: true, force: true }, { id: backend.runtime.id, url: document.url });
    return result.error ? { error: result.error } : { ok: true };
  };
  backend.setActiveTab(document.url);
  await backend.load('src/background/index.ts', { self: { addEventListener() {} }, console: { ...console, info() {} }, ...(fetch ? { fetch } : {}) });
  const db = await backend.load('src/shared/db/index.ts');
  const drain = async () => {
    const deadline = performance.now() + 5000;
    while ((await backend.send({ type: 'GET_PROCESSING' })).queue.length) {
      if (performance.now() >= deadline) throw Error('Capture work did not finish: ' + JSON.stringify((await backend.send({ type: 'GET_PROCESSING' })).queue));
      await tick();
    }
  };
  testContext.after(async () => {
    await backend.send({ type: 'SET_SETTINGS', payload: { automaticAi: false } });
    await drain(); await tick(); (await db.openDatabase()).close();
  });
  return { ...backend, db, broadcasts, drain, nativeCalls: () => nativeCalls, setDocument: page => { document = page; backend.setActiveTab(page.url); } };
}
