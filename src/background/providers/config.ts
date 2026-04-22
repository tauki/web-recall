import { DEFAULT_EMBEDDING_CONFIG } from '../../shared/config/index';

const PROVIDER_SETTINGS_KEY = 'betaProviderSettings';
const DEFAULT_PROVIDER_ID = 'ollama';

export type ProviderSettingsMap = Record<string, Record<string, string>>;

let settingsCache: ProviderSettingsMap | null = null;

function sanitizeBaseUrl(url: string | undefined): string {
  if (!url) return DEFAULT_EMBEDDING_CONFIG.baseUrl;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function normalizeProviderSettings(input: unknown): ProviderSettingsMap {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const next: ProviderSettingsMap = {};
  for (const [providerId, rawSettings] of Object.entries(input as Record<string, unknown>)) {
    if (!rawSettings || typeof rawSettings !== 'object') {
      continue;
    }
    const providerSettings: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawSettings as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        continue;
      }
      providerSettings[key] = key === 'baseUrl' ? sanitizeBaseUrl(value.trim()) : value.trim();
    }
    next[providerId] = providerSettings;
  }
  return next;
}

function mergeWithDefaults(settings: ProviderSettingsMap): ProviderSettingsMap {
  const baseUrl = sanitizeBaseUrl(settings[DEFAULT_PROVIDER_ID]?.baseUrl) || DEFAULT_EMBEDDING_CONFIG.baseUrl;
  return {
    ...settings,
    [DEFAULT_PROVIDER_ID]: {
      ...(settings[DEFAULT_PROVIDER_ID] || {}),
      baseUrl
    }
  };
}

async function readProviderSettings(): Promise<ProviderSettingsMap> {
  if (settingsCache) {
    return settingsCache;
  }
  settingsCache = await new Promise((resolve) => {
    chrome.storage.local.get([PROVIDER_SETTINGS_KEY], (result: Record<string, unknown>) => {
      resolve(mergeWithDefaults(normalizeProviderSettings(result?.[PROVIDER_SETTINGS_KEY])));
    });
  });
  return settingsCache || mergeWithDefaults({});
}

async function writeProviderSettings(settings: ProviderSettingsMap): Promise<void> {
  settingsCache = mergeWithDefaults(settings);
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [PROVIDER_SETTINGS_KEY]: settingsCache }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

export async function getProviderSettings(providerId: string): Promise<Record<string, string>> {
  const settings = await readProviderSettings();
  return { ...(settings[providerId] || {}) };
}

export async function updateProviderSettings(providerId: string, partial: Record<string, string>): Promise<Record<string, string>> {
  const settings = await readProviderSettings();
  const next = {
    ...settings,
    [providerId]: {
      ...(settings[providerId] || {}),
        ...Object.fromEntries(
          Object.entries(partial)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => {
              const trimmed = value.trim();
              return [key, key === 'baseUrl' ? sanitizeBaseUrl(trimmed) : trimmed];
            })
      )
    }
  };
  await writeProviderSettings(next);
  return { ...(next[providerId] || {}) };
}

export async function getProviderBaseUrl(providerId: string): Promise<string> {
  const settings = await getProviderSettings(providerId);
  return sanitizeBaseUrl(settings.baseUrl) || DEFAULT_EMBEDDING_CONFIG.baseUrl;
}

try {
  chrome.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    const entry = changes[PROVIDER_SETTINGS_KEY];
    if (!entry) return;
    settingsCache = mergeWithDefaults(normalizeProviderSettings(entry.newValue));
  });
} catch (err) {
  console.warn('[beta-background:providers] unable to bind provider storage listener', err);
}
