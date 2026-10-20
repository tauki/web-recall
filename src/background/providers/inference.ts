// Local model loading and inference have no predictable duration. Keep the MV3
// worker alive only while work is pending, including response-body streaming.
export async function runInference<T>(operation: () => Promise<T>): Promise<T> {
  const keepAlive = typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo
    ? setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 20_000)
    : undefined;
  try {
    return await operation();
  } finally {
    if (keepAlive !== undefined) clearInterval(keepAlive);
  }
}
