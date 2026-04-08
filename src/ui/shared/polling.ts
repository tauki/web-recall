export type PollingOptions = {
  immediate?: boolean;
  runWhenHidden?: boolean;
};

export function startPolling(
  task: () => void | Promise<void>,
  intervalMs: number,
  options: PollingOptions = {}
): () => void {
  const { immediate = true, runWhenHidden = false } = options;

  const tick = (): void => {
    if (!runWhenHidden && document.visibilityState === 'hidden') {
      return;
    }
    void Promise.resolve(task()).catch((err) => {
      console.warn('[beta-ui] polling task failed', err);
    });
  };

  if (immediate) {
    tick();
  }

  const timer = window.setInterval(tick, intervalMs);
  return () => window.clearInterval(timer);
}
