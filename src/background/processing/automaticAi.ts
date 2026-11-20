import { abortable } from '../../shared/abort';

class AutomaticAiDisabledError extends Error {}
const active = new Set<AbortController>();

export function trackAutomaticAi(controller: AbortController): () => void {
  active.add(controller);
  return () => { active.delete(controller); };
}

export function stopAutomaticAi(): void {
  for (const controller of active) controller.abort(new AutomaticAiDisabledError('Automatic AI is off. Saved text remains available.'));
}

export async function runAutomaticAi<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const untrack = trackAutomaticAi(controller);
  try {
    const { getSettings } = await import('../settings/index');
    const settings = await getSettings();
    signal?.throwIfAborted();
    controller.signal.throwIfAborted();
    if (settings.automaticAi === false) return;
    return await abortable(run(controller.signal), controller.signal);
  } catch (error) {
    if (!(signal?.reason instanceof AutomaticAiDisabledError)) signal?.throwIfAborted();
    if (controller.signal.reason instanceof AutomaticAiDisabledError) return;
    throw error;
  } finally { untrack(); signal?.removeEventListener('abort', cancel); }
}
