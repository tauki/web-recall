export type BetaSettings = {
  paused: boolean;
  captureSetupComplete: boolean;
  acknowledgedRemoteProviderOrigins: string[];
  allowlist: string[];
  denylist: string[];
  contextWindowChars: number;
  askMaxSources: number;
  theme: 'light' | 'dark' | 'system';
  activeProviderId: string;
  logLevel: 'off' | 'debug' | 'info' | 'warn' | 'error';
  answerMode: 'concise' | 'detailed';
  queryRewrite: boolean;
  searchRerank: boolean;
  askRerank: boolean;
  enableTools: boolean;
  maxToolSteps: number;
  toolTimeoutMs: number;
  logFullBodies: boolean;
};

export const DEFAULT_SETTINGS: BetaSettings = {
  paused: true,
  captureSetupComplete: false,
  acknowledgedRemoteProviderOrigins: [],
  allowlist: [],
  denylist: [],
  contextWindowChars: 1200,
  askMaxSources: 5,
  theme: 'light',
  activeProviderId: 'ollama',
  logLevel: 'info',
  answerMode: 'concise',
  queryRewrite: true,
  searchRerank: true,
  askRerank: true,
  enableTools: true,
  maxToolSteps: 2,
  toolTimeoutMs: 8000,
  logFullBodies: false
};

export type EmbeddingConfig = {
  baseUrl: string;
  model: string;
  provider?: 'ollama' | 'browser';
  browserModel?: string;
  browserRevision?: string;
  updatedAt?: string;
};

export const BROWSER_EMBEDDING_MODELS = [
  {
    id: 'onnx-community/embeddinggemma-300m-ONNX',
    label: 'EmbeddingGemma 300M (original)',
    revision: '75a84c732f1884df76bec365346230e32f582c82'
  },
  {
    id: 'onnx-community/embeddinggemma-2-ONNX',
    label: 'EmbeddingGemma 2 (text only, WebGPU)',
    revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'
  }
] as const;

export function browserEmbeddingRuntime(model?: string): { device: 'wasm' | 'webgpu'; dtype: 'q8' | 'q4' } {
  // The Gemma 2 quantized text graph uses GatherBlockQuantized, which this
  // ONNX WASM build does not implement. Keep the original model on WASM.
  return model === 'onnx-community/embeddinggemma-2-ONNX'
    ? { device: 'webgpu', dtype: 'q4' }
    : { device: 'wasm', dtype: 'q8' };
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'embeddinggemma',
  provider: 'ollama',
  browserModel: 'onnx-community/embeddinggemma-300m-ONNX',
  browserRevision: '75a84c732f1884df76bec365346230e32f582c82'
};

// Model spaces cannot be mixed even when vector dimensions happen to match.
export function embeddingSpaceKey(config: EmbeddingConfig): string {
  return config.provider === 'browser'
    ? JSON.stringify(['browser', config.browserModel, config.browserRevision, browserEmbeddingRuntime(config.browserModel).dtype, 'embeddinggemma-prefix-v1'])
    : JSON.stringify(['ollama', config.baseUrl, config.model]);
}
