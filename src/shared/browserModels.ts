// Keep the existing Transformers.js cache so earlier downloads remain discoverable.
export const BROWSER_MODEL_CACHE = 'transformers-cache';

export type BrowserModelDownload = {
  model: string;
  revision: string;
  fileCount: number;
  sizeBytes: number | null;
  hasWeights: boolean;
};

export type BrowserModelTransfer = {
  requestId: string;
  model: string;
  revision: string;
  startedAt: number;
  state: 'queued' | 'downloading' | 'preparing' | 'cancelling' | 'cancelled' | 'ready' | 'error';
  file?: string;
  loadedBytes: number;
  totalBytes?: number;
  error?: string;
};
