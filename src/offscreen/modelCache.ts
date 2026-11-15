import { BROWSER_MODEL_CACHE, type BrowserModelDownload } from '../shared/browserModels';

function modelFile(request: Request): { model: string; revision: string; file: string } | null {
  const url = new URL(request.url);
  if (url.origin !== 'https://huggingface.co') return null;
  const match = /^\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!match) return null;
  try {
    return { model: `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`, revision: decodeURIComponent(match[3]!), file: match[4]! };
  } catch { return null; }
}

async function modelCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') throw new Error('Browser model storage is unavailable.');
  if (!(await caches.has(BROWSER_MODEL_CACHE))) return null;
  return caches.open(BROWSER_MODEL_CACHE);
}

export async function listBrowserModelDownloads(): Promise<BrowserModelDownload[]> {
  const cache = await modelCache();
  if (!cache) return [];
  const models = new Map<string, BrowserModelDownload>();
  for (const request of await cache.keys()) {
    const file = modelFile(request);
    if (!file) continue;
    const response = await cache.match(request);
    if (!response) continue;
    const key = JSON.stringify([file.model, file.revision]);
    const entry = models.get(key) || { model: file.model, revision: file.revision, fileCount: 0, sizeBytes: 0, hasWeights: false };
    const rawLength = response.headers.get('content-length');
    const size = rawLength === null ? NaN : Number(rawLength);
    entry.sizeBytes = entry.sizeBytes !== null && Number.isSafeInteger(size) && size >= 0 ? entry.sizeBytes + size : null;
    entry.fileCount++;
    entry.hasWeights ||= /\.onnx$/i.test(file.file);
    models.set(key, entry);
  }
  return [...models.values()].sort((a, b) => a.model.localeCompare(b.model) || a.revision.localeCompare(b.revision));
}

export async function removeBrowserModelFiles(model: string, revision: string): Promise<number> {
  if (!model || !revision) throw new Error('Choose a downloaded model and revision to remove.');
  const cache = await modelCache();
  if (!cache) return 0;
  let deletedFiles = 0;
  for (const request of await cache.keys()) {
    const file = modelFile(request);
    if (file?.model === model && file.revision === revision) {
      if (await cache.delete(request)) deletedFiles++;
    }
  }
  return deletedFiles;
}
