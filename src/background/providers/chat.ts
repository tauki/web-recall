import { runInference } from './inference';
import { ollamaResponseError } from './ollamaErrors';
import { CHAT_PROVIDER_DISABLED } from '../../shared/config/index';
import { ChatDisabledError } from '../../shared/providerErrors';
import { chatWorkSignal } from './chatWork';
import { resolveOllamaChatModel, getOllamaContextTokens } from './ollamaModels';
import { getSettings } from '../settings/index';
import { getProviderBaseUrl } from './config';
import { assertProviderOriginAcknowledged, fetchProvider } from './access';
import { callApple, getAppleStatus, type AppleMode } from './apple';

export type ChatConfig = {
  signal?: AbortSignal;
  providerId: string;
  baseUrl: string;
  model: string;
  contextTokens?: number;
  appleCloudConsent?: boolean;
};

export type ChatResponse = {
  error?: string;
  message?: {
    thinking?: string;
    content?: string;
    tool_calls?: Array<{
      type?: string;
      function?: {
        name?: string;
        arguments?: string | Record<string, unknown>;
      };
    }>;
  };
};

export type CoverageLevel = 'low' | 'medium' | 'high';
export type ChatProbeResult = {
  ok: boolean;
  lastError?: string;
  suggestion?: string;
};

export function normalizeToolArguments(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object');
  return parsed as Record<string, unknown>;
}

function buildOriginSuggestion(message: string): string | undefined {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('load failed') ||
    normalized.includes('cors')
  ) {
    return 'If Ollama is running locally, ensure OLLAMA_ORIGINS includes your chrome-extension://<extension-id> origin.';
  }
  return undefined;
}

export async function getChatConfig(requestSignal?: AbortSignal): Promise<ChatConfig> {
  const signal = chatWorkSignal(requestSignal);
  const settings = await getSettings();
  signal.throwIfAborted();
  if (settings.activeProviderId === CHAT_PROVIDER_DISABLED) throw new ChatDisabledError();
  const providerId = settings.activeProviderId === 'apple' ? 'apple' : 'ollama';
  if (providerId === 'apple') {
    const model: AppleMode = settings.applePrivateCloud ? 'private-cloud' : 'on-device';
    const status = await getAppleStatus(model, settings.applePrivateCloud, signal);
    signal.throwIfAborted();
    if (!status.libraryTools) throw new Error('Update and restart the Web Recall Mac companion to enable the saved-memory tool bridge.');
    return { providerId, baseUrl: '', model, signal, contextTokens: status.contextTokens, appleCloudConsent: settings.applePrivateCloud };
  }
  const baseUrl = await getProviderBaseUrl(providerId);
  await assertProviderOriginAcknowledged(baseUrl);
  signal.throwIfAborted();
  const model = await resolveOllamaChatModel(baseUrl, undefined, signal);
  const contextTokens = await getOllamaContextTokens(baseUrl, model, signal);
  signal.throwIfAborted();
  return {
    providerId,
    baseUrl,
    model,
    signal,
    contextTokens
  };
}

export async function ensureChatReady(config: ChatConfig): Promise<void> {
  const probe = await probeChat(config);
  if (!probe.ok) {
    throw new Error(probe.suggestion ? `${probe.lastError || 'Unable to reach the chat provider.'} ${probe.suggestion}` : probe.lastError || 'Unable to reach the chat provider.');
  }
}

export async function probeChat(config: ChatConfig): Promise<ChatProbeResult> {
  if (config.providerId === 'apple') {
    try { await getAppleStatus(config.model as AppleMode, config.appleCloudConsent, config.signal); return { ok: true }; }
    catch (error) { return { ok: false, lastError: error instanceof Error ? error.message : String(error) }; }
  }
  return runInference(async () => {
    try {
      config.signal?.throwIfAborted();
      const resp = await fetchProvider(`${config.baseUrl}/api/chat`, {
        method: 'POST',
        signal: config.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
          options: { temperature: 0 }
        })
      });
      if (!resp.ok) {
        return { ok: false, lastError: (await ollamaResponseError(resp, 'chat probe')).message };
      }
      const payload = (await resp.json()) as ChatResponse;
      const content = payload.message?.content?.trim();
      if (!content) {
        return {
          ok: false,
          lastError: 'Chat provider returned an empty response.',
          suggestion: 'Check the selected chat model and verify Ollama can answer /api/chat requests from the extension.'
        };
      }
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unable to reach the chat provider.';
      return {
        ok: false,
        lastError: message,
        suggestion: buildOriginSuggestion(message)
      };
    }
  });
}

export async function callChat(config: ChatConfig, body: Record<string, unknown>): Promise<ChatResponse> {
  config.signal?.throwIfAborted();
  if (config.providerId === 'apple') return { message: { content: await appleChat(config, body) } };
  return runInference(async () => {
    const resp = await fetchProvider(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      signal: config.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      throw await ollamaResponseError(resp, 'chat request');
    }
    const answer = (await resp.json()) as ChatResponse;
    config.signal?.throwIfAborted();
    return answer;
  });
}

async function appleChat(config: ChatConfig, body: Record<string, unknown>, onChunk?: (text: string) => void): Promise<string> {
  if (body.tools) throw new Error('Use the Apple saved-passage tools for native Ask.');
  const messages = Array.isArray(body.messages) ? body.messages as Array<{ role: string; content: string }> : [];
  return await callApple({
    action: 'generate', mode: config.model as AppleMode, cloudConsent: config.appleCloudConsent === true,
    instructions: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
    prompt: messages.filter(message => message.role !== 'system').map(message => `${message.role}: ${message.content}`).join('\n\n'),
    maxOutputTokens: (body.options as { num_predict?: number } | undefined)?.num_predict
  }, { signal: config.signal, onChunk }) as string;
}

export function stripJsonFences(content: string): string {
  return content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

export function parseJsonResponse<T>(content: string): T | null {
  if (!content) return null;
  try {
    return JSON.parse(stripJsonFences(content)) as T;
  } catch {
    return null;
  }
}

export async function callChatJson<T>(config: ChatConfig, body: Record<string, unknown>): Promise<T | null> {
  const response = await callChat(config, body);
  return parseJsonResponse<T>(response.message?.content || '');
}

export async function streamChat(
  config: ChatConfig,
  body: Record<string, unknown>,
  onChunk: (chunk: string) => void
): Promise<string> {
  config.signal?.throwIfAborted();
  if (config.providerId === 'apple') return appleChat(config, body, onChunk);
  return runInference(async () => {
    const textDecoder = new TextDecoder();
    let assembled = '';
    const resp = await fetchProvider(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      signal: config.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true })
    });
    if (!resp.ok) throw await ollamaResponseError(resp, 'streaming chat');
    if (!resp.body) throw new Error('Ollama returned no chat stream.');
    const reader = resp.body.getReader();
    const acceptLine = (line: string): void => {
      if (!line.trim()) return;
      const payload = JSON.parse(line) as ChatResponse;
      if (payload.error) throw new Error(payload.error);
      const chunk = payload.message?.content || '';
      if (chunk) {
        assembled += chunk;
        onChunk(assembled);
      }
    };
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        config.signal?.throwIfAborted();
        if (done) break;
        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(acceptLine);
      }
      acceptLine(buffer + textDecoder.decode());
      return assembled;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
}
