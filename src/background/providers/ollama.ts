import { getModelSettings } from '../models/index';
import { getProviderBaseUrl, updateProviderSettings } from './config';
import { probeChat } from './chat';

const DEFAULT_CHAT_MODEL = 'llama3.1';

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

export async function getOllamaStatus(baseUrl?: string): Promise<ProviderStatus> {
  const target = baseUrl || (await getProviderBaseUrl('ollama'));
  try {
    await pingOllama(target);
    const [modelSettings, models] = await Promise.all([
      getModelSettings(),
      listOllamaModels(target)
    ]);
    const probeModel =
      (modelSettings.chatModel && models.includes(modelSettings.chatModel) ? modelSettings.chatModel : null) ||
      models[0] ||
      null;
    if (!probeModel) {
      return { online: true, lastChecked: new Date().toISOString() };
    }
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

export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const target = baseUrl || (await getProviderBaseUrl('ollama'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch(`${target}/api/tags`, { method: 'GET', signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || !Array.isArray(json.models)) return [];
    return (json.models as Array<{ name?: string }>).map((model) => String(model.name || '')).filter(Boolean);
  } catch (err) {
    console.warn('[beta-background:providers] unable to list models', err);
    return [];
  } finally {
    clearTimeout(timeout);
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
  const modelSettings = await getModelSettings();
  const selectedModel = modelSettings.chatModel || models[0] || DEFAULT_CHAT_MODEL;
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
