export type RuntimeResponse<T> = T & { error?: string };

export function sendRuntimeMessage<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response: RuntimeResponse<T>) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve((response || {}) as T);
    });
  });
}
