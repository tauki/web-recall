const worker = new Worker('sqlite-worker.mjs', { type: 'module' });
const waiting = new Map();
const hostId = crypto.randomUUID();
let sequence = 0;
let failure;

worker.onmessage = ({ data: { sequence: token, reply } }) => {
  waiting.get(token)?.(reply);
  waiting.delete(token);
};
worker.onerror = event => {
  failure = event.message || 'The SQLite qualification worker failed';
  for (const respond of waiting.values()) respond({ error: failure });
  waiting.clear();
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel !== 'sqlite-offscreen' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js')) return false;
  if (failure) { respond({ error: failure }); return false; }
  const token = ++sequence;
  waiting.set(token, reply => {
    if (message.request.kind === 'host-status' && !reply.error) respond({ ...reply, hostId, hostIsolated: crossOriginIsolated });
    else respond(reply);
  });
  worker.postMessage({ sequence: token, request: message.request });
  return true;
});
