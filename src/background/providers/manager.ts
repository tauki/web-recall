import {
  describeOllamaProvider,
  getOllamaStatus,
  listOllamaModels,
  updateOllamaSetting,
  type ProviderDescriptor,
  type ProviderStatus
} from './ollama';

export type ProviderActionPayload = { baseOverride?: string };
export type ProviderActionResult = { status?: ProviderStatus; models?: string[] };

export type ProviderAdapter = {
  id: string;
  describe: () => Promise<ProviderDescriptor>;
  setSetting: (key: string, value: string) => Promise<void>;
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

  async setProviderSetting(providerId: string, key: string, value: string): Promise<void> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Unknown provider');
    await provider.setSetting(key, value);
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
  id: 'ollama',
  describe: describeOllamaProvider,
  setSetting: updateOllamaSetting,
  action: async (action, payload) => {
    if (action === 'test') {
      const status = await getOllamaStatus(payload?.baseOverride);
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
