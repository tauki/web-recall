import { getModelSettings } from '../models/index';
import { getProviderBaseUrl } from './config';

export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const target = baseUrl || (await getProviderBaseUrl('ollama'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${target}/api/tags`, { signal: controller.signal });
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
