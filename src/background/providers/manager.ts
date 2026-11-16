import {
  describeOllamaProvider,
  getOllamaStatus,
  listOllamaModels,
  updateOllamaSetting,
  type ProviderDescriptor,
  type ProviderStatus
} from './ollama';

import type { ProviderConsentOptions } from './access';
import { getAppleStatus } from './apple';
import { getSettings } from '../settings/index';

export type ProviderActionPayload = { baseOverride?: string };
export type ProviderActionResult = { status?: ProviderStatus; models?: string[] };

export type ProviderAdapter = {
  id: string;
  describe: () => Promise<ProviderDescriptor>;
  setSetting: (key: string, value: string, options?: ProviderConsentOptions) => Promise<void>;
  action: (action: string, payload?: ProviderActionPayload) => Promise<ProviderActionResult>;
  listModels?: () => Promise<string[]>;
};

export class ProviderManager {
  private providers = new Map<string, ProviderAdapter>();

  register(provider: ProviderAdapter): void {
    this.providers.set(provider.id, provider);
  }

  async getProviders(): Promise<ProviderDescriptor[]> {
    return Promise.all(Array.from(this.providers.values()).map((provider) => provider.describe()));
  }

  async setProviderSetting(providerId: string, key: string, value: string, options?: ProviderConsentOptions): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Unknown provider');
    await provider.setSetting(key, value, options);
  }

  async runAction(providerId: string, action: string, payload?: ProviderActionPayload): Promise<ProviderActionResult> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Unknown provider');
    return provider.action(action, payload);
  }

  async listModels(providerId: string): Promise<string[]> {
    const provider = this.providers.get(providerId);
    if (!provider || !provider.listModels) return [];
    return provider.listModels();
  }
}

const providerManager = new ProviderManager();

providerManager.register({
  id: 'apple',
  describe: async () => {
    const settings = await getSettings();
    return {
      id: 'apple', name: 'Apple Foundation Models',
      status: { online: false, lastChecked: '', lastError: 'Use Test connection to check the Mac helper.' },
      settings: [], actions: [{ id: 'test', label: 'Test connection' }],
      models: [settings.applePrivateCloud ? 'private-cloud' : 'on-device'],
      selectedModel: settings.applePrivateCloud ? 'private-cloud' : 'on-device',
      notes: 'Requires the Web Recall companion app running on macOS 26.4+. Open it from Applications; its menu bar provides status, Pause, Stop and Quit. Embeddings remain separately configured. Private Cloud Compute additionally requires macOS 27 and Apple approval for the app entitlement.'
    };
  },
  setSetting: async () => { throw new Error('Apple uses its system model, not an HTTP endpoint.'); },
  action: async (action) => {
    if (action !== 'test') throw new Error('Unknown provider action');
    const settings = await getSettings();
    try {
      const status = await getAppleStatus(settings.applePrivateCloud ? 'private-cloud' : 'on-device', settings.applePrivateCloud);
      return { status: { online: status.available, lastChecked: new Date().toISOString(), contextTokens: status.contextTokens } };
    } catch (error) {
      return { status: { online: false, lastChecked: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) } };
    }
  }
});

providerManager.register({
  id: 'ollama',
  describe: async () => describeOllamaProvider((await getSettings()).activeProviderId !== 'apple'),
  setSetting: updateOllamaSetting,
  action: async (action, payload) => {
    if (action === 'test') {
      const status = await getOllamaStatus(payload?.baseOverride, true);
      return { status };
    }
    if (action === 'refreshModels') {
      const models = await listOllamaModels(payload?.baseOverride);
      return { models };
    }
    throw new Error('Unknown provider action');
  },
  listModels: () => listOllamaModels()
});

export { providerManager };
