import { abortable } from '../../shared/abort';

type Operation = 'search' | 'backfill';
const active = new Map<string, AbortController>();

export async function runOperation<T>(kind: Operation, requestId: string | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const key = `${kind}:${requestId || crypto.randomUUID()}`;
  if (active.has(key)) throw new Error('Request is already running');
  const controller = new AbortController();
  active.set(key, controller);
  try {
    return await abortable(run(controller.signal), controller.signal);
  } finally {
    active.delete(key);
  }
}

export function cancelOperation(kind: Operation, requestId: string): boolean {
  const controller = active.get(`${kind}:${requestId}`);
  if (!controller) return false;
  controller.abort(new Error('Stopped by user'));
  return true;
}
