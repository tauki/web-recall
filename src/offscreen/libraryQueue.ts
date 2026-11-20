const MAX_EARLY_CANCELLATIONS = 256;

export function createLibraryQueue() {
  let completed: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, boolean>();
  const cancelledEarly = new Set<string>();
  return {
    cancel(key: string): void {
      if (pending.has(key)) pending.set(key, true);
      else {
        cancelledEarly.add(key);
        if (cancelledEarly.size > MAX_EARLY_CANCELLATIONS) cancelledEarly.delete(cancelledEarly.values().next().value!);
      }
    },
    enqueue<Result>(key: string | undefined, run: (check: () => void) => Promise<Result>): Promise<Result> {
      if (key && pending.has(key)) return Promise.reject(new Error('Saved library operation is already queued.'));
      if (key) pending.set(key, cancelledEarly.delete(key));
      const check = (): void => {
        if (key && pending.get(key)) throw new Error('Saved library operation cancelled.');
      };
      const result = completed.then(async () => {
        try { check(); return await run(check); }
        finally { if (key) pending.delete(key); }
      });
      completed = result.catch(() => {});
      return result;
    }
  };
}
