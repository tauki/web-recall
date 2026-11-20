export function installRuntimePorts(runtime) {
  const listeners = new Set(), connections = [];
  const event = () => {
    const subscribers = new Set();
    return { addListener: listener => subscribers.add(listener), removeListener: listener => subscribers.delete(listener), emit: (...args) => { for (const listener of subscribers) listener(...args); } };
  };
  runtime.onConnect = { addListener: listener => listeners.add(listener) };
  runtime.connect = (options, sender = { id: runtime.id, url: runtime.getURL('dist/beta/ui/manage/index.html') }) => {
    let closed = false;
    const client = { name: options.name, onMessage: event(), onDisconnect: event() };
    const worker = { name: options.name, sender, onMessage: event(), onDisconnect: event() };
    const connection = { client, worker, sent: [], dropResponses: false };
    const disconnect = () => { if (closed) return; closed = true; queueMicrotask(() => { client.onDisconnect.emit(); worker.onDisconnect.emit(); }); };
    client.disconnect = worker.disconnect = disconnect;
    for (const [source, target] of [[client, worker], [worker, client]]) source.postMessage = message => {
      if (closed) throw Error('Port disconnected');
      const encoded = JSON.stringify(message);
      connection.sent.push({ direction: source === client ? 'request' : 'response', bytes: new TextEncoder().encode(encoded).length, action: message.action, id: message.id });
      const copied = JSON.parse(encoded);
      queueMicrotask(() => { if (!closed && !(source === worker && connection.dropResponses)) target.onMessage.emit(copied); });
    };
    connections.push(connection);
    queueMicrotask(() => { if (!closed) for (const listener of listeners) listener(worker); });
    return client;
  };
  return connections;
}
