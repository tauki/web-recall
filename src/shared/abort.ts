export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason || new Error('Request cancelled'));
    if (signal.aborted) {
      promise.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
