import { getProviderBaseUrl, updateProviderSettings } from './config';
import { probeChat } from './chat';
import { fetchProvider, type ProviderConsentOptions } from './access';
import { listOllamaModels, resolveOllamaChatModel } from './ollamaModels';
export { listOllamaModels } from './ollamaModels';

export type ProviderStatus = {
  online: boolean;
  lastChecked: string;
  lastError?: string;
  contextTokens?: number;
};

export type ProviderSetting = {
  key: string;
  label: string;
  type: 'text';
  value: string;
};

export type ProviderAction = {
  id: string;
  label: string;
};

export type ProviderDescriptor = {
  id: string;
  name: string;
  status: ProviderStatus;
  settings: ProviderSetting[];
  actions: ProviderAction[];
  models: string[];
  selectedModel: string;
  notes?: string;
};

async function pingOllama(baseUrl: string, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchProvider(`${baseUrl}/`, { method: 'GET', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOllamaStatus(baseUrl?: string, testInference = false, signal?: AbortSignal): Promise<ProviderStatus> {
  const target = baseUrl || (await getProviderBaseUrl('ollama'));
  try {
    await pingOllama(target, signal);
    if (!testInference) return { online: true, lastChecked: new Date().toISOString() };
    const probeModel = await resolveOllamaChatModel(target, undefined, signal);
    const probe = await probeChat({
      providerId: 'ollama',
      baseUrl: target,
      model: probeModel,
      signal
    });
    if (!probe.ok) {
      return {
        online: false,
        lastChecked: new Date().toISOString(),
        lastError: probe.suggestion ? `${probe.lastError} ${probe.suggestion}` : probe.lastError
      };
    }
    return { online: true, lastChecked: new Date().toISOString() };
  } catch (err) {
    return {
      online: false,
      lastChecked: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function describeOllamaProvider(probe = true, signal?: AbortSignal): Promise<ProviderDescriptor> {
  const baseUrl = await getProviderBaseUrl('ollama');
  const status = probe ? await getOllamaStatus(baseUrl, false, signal).catch(() => ({
    online: false,
    lastChecked: new Date().toISOString(),
    lastError: 'Unknown error'
  })) : { online: false, lastChecked: '', lastError: 'Inactive provider' };
  if (probe) signal?.throwIfAborted();
  const models = status.online ? await listOllamaModels(baseUrl, signal) : [];
  const selectedModel = await resolveOllamaChatModel(baseUrl, models, probe ? signal : undefined);
  return {
    id: 'ollama',
    name: 'Ollama',
    status,
    settings: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        value: baseUrl
      }
    ],
    actions: [{ id: 'test', label: 'Test connection' }],
    models,
    selectedModel
  };
}

export async function updateOllamaSetting(key: string, value: string, options?: ProviderConsentOptions): Promise<void> {
  if (key === 'baseUrl') {
    await updateProviderSettings('ollama', { baseUrl: value }, options);
    return;
  }
  throw new Error(`Unknown provider setting: ${key}`);
}
