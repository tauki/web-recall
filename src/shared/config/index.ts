export type BetaSettings = {
  paused: boolean;
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
  paused: false,
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

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'embeddinggemma',
  provider: 'ollama',
  browserModel: 'onnx-community/embeddinggemma-300m-ONNX',
  browserRevision: '75a84c732f1884df76bec365346230e32f582c82'
};
