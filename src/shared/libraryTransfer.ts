export const LIBRARY_PORT = 'web-recall-saved-library';

const FRAME_CHARS = 256 * 1024;
const REQUEST_CHARS = 192 * 1024 * 1024;

export type LibraryPort = {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

type Frame = { kind: 'part' | 'last'; data: string };

function frames(value: unknown): () => Frame {
  let source = JSON.stringify(value);
  if (typeof source !== 'string' || source.length > REQUEST_CHARS) throw new Error('The saved library operation exceeds the transfer limit.');
  let offset = 0;
  return () => {
    const data = source.slice(offset, offset + FRAME_CHARS);
    offset += data.length;
    if (offset < source.length) return { kind: 'part', data };
    source = '';
    return { kind: 'last', data };
  };
}

class FrameReader {
  private parts: string[] = [];
  private length = 0;

  append(message: unknown): boolean {
    const frame = message as Partial<Frame> | undefined;
    if (!frame || (frame.kind !== 'part' && frame.kind !== 'last') || typeof frame.data !== 'string' ||
        frame.data.length > FRAME_CHARS || (frame.kind === 'part' && frame.data.length !== FRAME_CHARS)) throw new Error('Invalid saved library frame.');
    this.length += frame.data.length;
    if (this.length > REQUEST_CHARS) throw new Error('The saved library operation exceeds the transfer limit.');
    this.parts.push(frame.data);
    return frame.kind === 'last';
  }

  value(): unknown {
    const parts = this.parts;
    this.parts = [];
    return JSON.parse(parts.join(''));
  }
}

export function requestLibraryFrames<Result>(port: LibraryPort, request: unknown, signal?: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    let settled = false, sending = true;
    const finish = (error?: unknown, value?: Result): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stopUpload);
      if (error) reject(error); else resolve(value!);
      port.disconnect();
    };
    const stopUpload = (): void => { if (sending) finish(signal?.reason ?? new Error('Saved library upload stopped.')); };
    port.onDisconnect.addListener(() => finish(new Error('The saved library connection closed.')));
    try {
      signal?.throwIfAborted();
      const next = frames(request);
      signal?.addEventListener('abort', stopUpload, { once: true });
      const send = (): void => {
        const frame = next();
        if (frame.kind === 'last') sending = false;
        port.postMessage(frame);
      };
      port.onMessage.addListener(message => {
        if (settled) return;
        try {
          const control = message as { kind?: unknown; error?: string } | undefined;
          if (control?.kind === 'error') { finish(new Error(control.error || 'Saved library operation failed.')); return; }
          if (sending) {
            if (control?.kind !== 'next') throw new Error('Unexpected saved library transfer reply.');
            send();
          } else if (reader.append(message)) {
            const result = reader.value() as Result & { error?: string };
            if (result?.error) finish(new Error(result.error)); else finish(undefined, result);
          } else port.postMessage({ kind: 'next' });
        } catch (error) { finish(error); }
      });
      send();
    } catch (error) { finish(error); }
  });
}

export function acceptLibraryFrames(port: LibraryPort, forward: (request: unknown, reply: (result: unknown) => void) => void): void {
  let reader: FrameReader | undefined = new FrameReader();
  let response: (() => Frame) | undefined;
  let closed = false;
  const send = (): void => {
    const frame = response!();
    if (frame.kind === 'last') response = undefined;
    port.postMessage(frame);
  };
  const fail = (error: unknown): void => {
    reader = undefined; response = undefined;
    if (!closed) port.postMessage({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
  };
  port.onDisconnect.addListener(() => { closed = true; reader = undefined; response = undefined; });
  port.onMessage.addListener(message => {
    if (closed) return;
    try {
      if (reader) {
        if (!reader.append(message)) { port.postMessage({ kind: 'next' }); return; }
        const value = reader.value();
        reader = undefined;
        forward(value, result => {
          if (closed) return;
          try { response = frames(result); send(); }
          catch (error) { fail(error); }
        });
      } else {
        if (!response || (message as { kind?: unknown } | undefined)?.kind !== 'next') throw new Error('Unexpected saved library transfer command.');
        send();
      }
    } catch (error) { fail(error); }
  });
}
