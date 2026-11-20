import { acceptLibraryFrames, LIBRARY_PORT, type LibraryPort } from '../shared/libraryTransfer';

let worker: Worker | undefined;
let sequence = 0;
const responses = new Map<number, (reply: unknown) => void>();
export type SavedLibrarySender = { id?: string; url?: string; tab?: unknown };

function startWorker(): Worker {
  const instance = new Worker(new URL('./libraryWorker.js', import.meta.url), { type: 'module' });
  instance.addEventListener('message', ({ data }: MessageEvent<{ token: number; result?: unknown; error?: string }>) => {
    if (worker !== instance) return;
    const callback = responses.get(data.token);
    responses.delete(data.token);
    callback?.(data.error === undefined ? data.result : { error: data.error });
  });
  const failed = (): void => {
    if (worker !== instance) return;
    instance.terminate();
    worker = undefined;
    const callbacks = [...responses.values()];
    responses.clear();
    for (const callback of callbacks) callback({ error: 'The saved library worker closed. Retry the operation.' });
  };
  instance.addEventListener('error', failed);
  instance.addEventListener('messageerror', failed);
  return instance;
}

function isBackground(sender?: SavedLibrarySender): boolean {
  return Boolean(sender && sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('dist/beta/background.js'));
}

export function bindSavedLibraryTransfer(): void {
  chrome.runtime.onConnect?.addListener((port: LibraryPort & { sender?: SavedLibrarySender }) => {
    if (port.name !== LIBRARY_PORT) return;
    if (!port.sender || !isBackground(port.sender)) { port.disconnect(); return; }
    const sender = port.sender;
    acceptLibraryFrames(port, (request, reply) => { forwardSavedLibraryRequest(request, sender, reply); });
  });
}

export function forwardSavedLibraryRequest(request: unknown, sender: SavedLibrarySender, reply: (result: unknown) => void): boolean {
  if (!isBackground(sender)) return false;
  const token = ++sequence;
  try {
    worker ??= startWorker();
    responses.set(token, reply);
    worker.postMessage({ token, request });
    return true;
  } catch (error) {
    responses.delete(token);
    reply({ error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
