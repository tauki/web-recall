export class OllamaRequestError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'OllamaRequestError';
  }
}

export async function ollamaResponseError(response: Response, operation: string): Promise<OllamaRequestError> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  const detail = typeof payload?.error === 'string' ? `: ${payload.error.slice(0, 500)}` : '';
  let message = `Ollama ${operation} failed (HTTP ${response.status})${detail}`;
  if (response.status === 403) {
    const origin = chrome.runtime.getURL('').replace(/\/$/, '');
    message += `. If Ollama rejected this extension origin, add ${origin} to OLLAMA_ORIGINS and restart Ollama.`;
  }
  return new OllamaRequestError(message, response.status === 408 || response.status === 429 || response.status >= 500);
}
