import { getModelSettings } from '../models/index';
import { getProviderBaseUrl } from './config';
import { fetchProvider } from './access';

export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const target = baseUrl || (await getProviderBaseUrl('ollama'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchProvider(`${target}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!Array.isArray(json?.models)) return [];
    return (json.models as Array<{ name?: string }>).map(model => String(model.name || '')).filter(Boolean);
  } catch (error) {
    console.warn('[beta-background:providers] unable to list models', error);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveOllamaChatModel(baseUrl: string, installed?: string[]): Promise<string> {
  const settings = await getModelSettings();
  if (settings.chatModel) return settings.chatModel;
  const models = installed ?? await listOllamaModels(baseUrl);
  return models[0] || 'llama3.1';
}

export async function getOllamaContextTokens(baseUrl: string, model: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const response = await fetchProvider(`${baseUrl}/api/ps`, { signal });
    if (!response.ok) return undefined;
    const payload = await response.json() as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
    const active = payload.models?.find(entry => [model, `${model}:latest`].includes(entry.name || entry.model || ''));
    return Number.isSafeInteger(active?.context_length) && active!.context_length! >= 1024 ? active!.context_length! : undefined;
  } catch (error) {
    signal?.throwIfAborted();
    console.warn('[beta-background:providers] active context size unavailable; using a conservative planning budget', error);
    return undefined;
  }
}
