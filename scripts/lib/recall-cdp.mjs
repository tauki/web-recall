let serial = 0;

export function pageCommand(session, browser, method, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const settle = (error, result) => {
      clearTimeout(timer); browser.off('disconnected', disconnect);
      if (error) reject(error); else resolve(result);
    };
    const disconnect = () => settle(Error('Benchmark browser disconnected while sampling the UI.'));
    const timer = setTimeout(() => settle(Error(`Benchmark UI CDP sample timed out: ${method}`)), timeoutMs);
    browser.on('disconnected', disconnect);
    session.send(method).then(result => settle(null, result), error => settle(error));
  });
}

export function workerCommand(session, browser, sessionId, method, timeoutMs = 5000, params) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const settle = (error, result) => {
      clearTimeout(timer);
      session.off('Target.receivedMessageFromTarget', receive);
      session.off('Target.detachedFromTarget', detach);
      browser.off('disconnected', disconnect);
      if (error) reject(error); else resolve(result);
    };
    const receive = event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id === id) settle(message.error ? Error(message.error.message) : null, message.result);
    };
    const detach = event => { if (event.sessionId === sessionId) settle(Error('Benchmark worker detached while sampling.')); };
    const disconnect = () => settle(Error('Benchmark browser disconnected while sampling.'));
    const timer = setTimeout(() => settle(Error(`Benchmark CDP sample timed out: ${method}`)), timeoutMs);
    session.on('Target.receivedMessageFromTarget', receive); session.on('Target.detachedFromTarget', detach); browser.on('disconnected', disconnect);
    session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => settle(error));
  });
}

export function flatCdp(socket, onEvent) {
  let serial = 0, closed = false;
  const pending = new Map();
  const receive = event => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) { onEvent(message); return; }
    const command = pending.get(message.id);
    if (!command || command.sessionId !== message.sessionId) return;
    command.settle(message.error ? Error(message.error.message) : null, message.result);
  };
  const disconnected = () => {
    if (closed) return;
    closed = true;
    socket.removeEventListener('message', receive);
    socket.removeEventListener('close', disconnected);
    socket.removeEventListener('error', disconnected);
    for (const command of pending.values()) command.settle(Error('The disposable DevTools socket closed.'));
  };
  socket.addEventListener('message', receive);
  socket.addEventListener('close', disconnected);
  socket.addEventListener('error', disconnected);
  return {
    send(method, params, sessionId, timeoutMs = 5000) {
      if (closed) return Promise.reject(Error('The disposable DevTools socket closed.'));
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const settle = (error, result) => {
          clearTimeout(timer); pending.delete(id);
          if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => settle(Error(`Benchmark CDP sample timed out: ${method}`)), timeoutMs);
        pending.set(id, { sessionId, settle });
        try { socket.send(JSON.stringify({ id, method, params, sessionId })); }
        catch (error) { settle(error); }
      });
    },
    close() { disconnected(); socket.close(); }
  };
}
