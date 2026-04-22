import { DEFAULT_SETTINGS } from '../../shared/config/index';
import { getModelSettings } from '../models/index';
import { getSettings } from '../settings/index';
import { getProviderBaseUrl } from './config';

export type ChatConfig = {
  providerId: string;
  baseUrl: string;
  model: string;
};

export type ChatResponse = {
  message?: {
    content?: string;
    tool_calls?: Array<{
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
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

const DEFAULT_CHAT_MODEL = 'llama3.1';
const textDecoder = new TextDecoder();

function normalizeProviderId(providerId: string | undefined): string {
  return providerId === 'ollama' ? providerId : DEFAULT_SETTINGS.activeProviderId;
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

export async function getChatConfig(): Promise<ChatConfig> {
  const [settings, modelSettings] = await Promise.all([getSettings(), getModelSettings()]);
  const providerId = normalizeProviderId(settings.activeProviderId);
  return {
    providerId,
    baseUrl: await getProviderBaseUrl(providerId),
    model: modelSettings.chatModel || DEFAULT_CHAT_MODEL
  };
}

export async function ensureChatReady(config: ChatConfig): Promise<void> {
  const probe = await probeChat(config);
  if (!probe.ok) {
    throw new Error(probe.suggestion ? `${probe.lastError || 'Unable to reach the chat provider.'} ${probe.suggestion}` : probe.lastError || 'Unable to reach the chat provider.');
  }
}

export async function probeChat(config: ChatConfig): Promise<ChatProbeResult> {
  try {
    const resp = await fetch(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with the single word ok.' }],
        options: { temperature: 0 }
      })
    });
    if (!resp.ok) {
      const message = `Chat provider probe failed (${resp.status})`;
      return { ok: false, lastError: message, suggestion: buildOriginSuggestion(message) };
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
}

export async function callChat(config: ChatConfig, body: Record<string, unknown>): Promise<ChatResponse> {
  const resp = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`Chat request failed (${resp.status})`);
  }
  return (await resp.json()) as ChatResponse;
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
  let assembled = '';
  const resp = await fetch(`${config.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true })
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Streaming chat failed (${resp.status})`);
  }
  const reader = resp.body.getReader();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += textDecoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const payload = JSON.parse(trimmed) as ChatResponse;
        const chunk = payload.message?.content || '';
        if (!chunk) continue;
        assembled += chunk;
        onChunk(assembled);
      } catch {
        // Ignore malformed chunks.
      }
    }
  }
  const trailing = buffer.trim();
  if (trailing) {
    try {
      const payload = JSON.parse(trailing) as ChatResponse;
      const chunk = payload.message?.content || '';
      if (chunk) {
        assembled += chunk;
        onChunk(assembled);
      }
    } catch {
      // Ignore trailing malformed chunk.
    }
  }
  return assembled;
}
