import { setTimeout as delay } from 'node:timers/promises';

export function createRecoveryProvider(optionsForPhase = () => ({})) {
  let mode = 'ready';
  const requests = [], pending = new Map();
  const failure = 'Qualification embedding model is unavailable';

  function reply(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  function complete(record, response, dimensions) {
    if (response.destroyed || response.writableEnded) return;
    record.state = 'completed';
    const page = record.pageMarker || 0;
    reply(response, 200, { embeddings: record.body.input.map((_input, index) => dimensions ? [(page + 1) / 256, (index + 1) / 256, ...Array.from({ length: dimensions - 2 }, (_, dimension) => (1 + (dimension % 256)) / 256)] : [index + 1, index + 2]) });
  }

  async function handle(request, response, phase) {
    const record = { path: new URL(request.url, 'http://qualification.test').pathname, method: request.method, phase, state: 'received', at: new Date().toISOString() };
    requests.push(record);
    response.on('close', () => {
      if (!response.writableEnded) record.state = 'disconnected';
      pending.delete(record);
    });
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024 * 1024) throw Error('Qualification request exceeds the fixture budget');
      }
      record.body = raw ? JSON.parse(raw) : {};
      const { embeddingDelayMs = 0, contextLength = 4096, dimensions } = optionsForPhase(phase);
      if (record.path === '/api/embed' && request.method === 'POST') {
        if (record.body.model !== 'qualification-vector' || !Array.isArray(record.body.input) || !record.body.input.length || !record.body.input.every(input => typeof input === 'string')) throw Error('Unexpected embedding request');
        if (dimensions) {
          const marker = record.body.input[0].match(/unique harbor ledger (\d+) quartz ribbon/u)?.[1];
          if (!marker) throw Error('Sustained embedding request lacks its page marker');
          record.pageMarker = Number(marker);
        }
        if (mode === 'hold') { record.state = 'held'; pending.set(record, { response, dimensions }); }
        else if (mode === 'fail') { record.state = 'failed'; reply(response, 404, { error: failure }); }
        else {
          if (embeddingDelayMs) await delay(embeddingDelayMs);
          complete(record, response, dimensions);
        }
        return;
      }
      if (record.path === '/api/tags' && request.method === 'GET') reply(response, 200, { models: [{ name: 'qualification-chat' }] });
      else if (record.path === '/api/ps' && request.method === 'GET') reply(response, 200, { models: [{ name: 'qualification-chat', context_length: contextLength }] });
      else if (record.path === '/api/chat' && request.method === 'POST' && record.body.model === 'qualification-chat' && record.body.stream === false) reply(response, 200, { message: { content: 'This fixture describes saved evidence and recovery.' } });
      else throw Error('Unexpected qualification provider endpoint or request');
      record.state = 'completed';
    } catch (error) {
      record.state = 'invalid'; record.error = String(error);
      if (!response.destroyed && !response.writableEnded) reply(response, 400, { error: record.error });
    }
  }

  return {
    requests, handle, failure,
    setMode(value) {
      if (!['ready', 'hold', 'fail'].includes(value)) throw Error('Unknown qualification provider mode');
      mode = value;
    },
    release() {
      for (const [record, { response, dimensions }] of pending) complete(record, response, dimensions);
      pending.clear();
    },
    close() {
      for (const { response } of pending.values()) response.destroy();
      pending.clear();
    }
  };
}
