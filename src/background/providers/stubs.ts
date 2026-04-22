import type { ProviderDescriptor, ProviderStatus } from './ollama';

type StubProviderConfig = {
  id: string;
  name: string;
  notes: string;
};

function buildStatus(): ProviderStatus {
  return {
    online: false,
    lastChecked: new Date().toISOString(),
    lastError: 'Not implemented in 0.2.0'
  };
}

function buildDescriptor(config: StubProviderConfig): ProviderDescriptor {
  return {
    id: config.id,
    name: config.name,
    status: buildStatus(),
    settings: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        value: ''
      }
    ],
    actions: [{ id: 'test', label: 'Test connection' }],
    models: [],
    selectedModel: '',
    notes: config.notes
  };
}

export const testProviderDescriptor = (): ProviderDescriptor =>
  buildDescriptor({
    id: 'test',
    name: 'Test Provider (stub)',
    notes: 'Stub provider for UI/registry testing; no network calls.'
  });

export const vllmProviderDescriptor = (): ProviderDescriptor =>
  buildDescriptor({
    id: 'vllm',
    name: 'vLLM (stub)',
    notes: 'Planned provider; not wired in 0.2.0.'
  });

export const llamaCppProviderDescriptor = (): ProviderDescriptor =>
  buildDescriptor({
    id: 'llama.cpp',
    name: 'llama.cpp (stub)',
    notes: 'Planned provider; not wired in 0.2.0.'
  });
