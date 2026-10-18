import { getProviderBaseUrl, updateProviderSettings } from './config';
import { probeChat } from './chat';
import { listOllamaModels, resolveOllamaChatModel } from './ollamaModels';
export { listOllamaModels } from './ollamaModels';

export type ProviderStatus = {
  online: boolean;
  lastChecked: string;
  lastError?: string;
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

async function pingOllama(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl}/`, { method: 'GET', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOllamaStatus(baseUrl?: string, testInference = false): Promise<ProviderStatus> {
  const target = baseUrl || (await getProviderBaseUrl('ollama'));
  try {
    await pingOllama(target);
    if (!testInference) return { online: true, lastChecked: new Date().toISOString() };
    const probeModel = await resolveOllamaChatModel(target);
    const probe = await probeChat({
      providerId: 'ollama',
      baseUrl: target,
      model: probeModel
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

export async function describeOllamaProvider(): Promise<ProviderDescriptor> {
  const baseUrl = await getProviderBaseUrl('ollama');
  const status = await getOllamaStatus().catch(() => ({
    online: false,
    lastChecked: new Date().toISOString(),
    lastError: 'Unknown error'
  }));
  const models = await listOllamaModels();
  const selectedModel = await resolveOllamaChatModel(baseUrl, models);
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

export async function updateOllamaSetting(key: string, value: string): Promise<void> {
  if (key === 'baseUrl') {
    await updateProviderSettings('ollama', { baseUrl: value });
    return;
  }
  throw new Error(`Unknown provider setting: ${key}`);
}
