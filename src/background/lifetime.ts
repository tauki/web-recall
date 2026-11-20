export function beginWorkerLease(): () => void {
  let timer = typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo
    ? setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 20_000)
    : undefined;
  return () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
}
