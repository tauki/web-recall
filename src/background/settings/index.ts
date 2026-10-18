const SETTINGS_KEY = 'betaSettings';

import { DEFAULT_SETTINGS, type BetaSettings } from '../../shared/config/index';
import { setLogLevel } from '../../shared/logger/index';
import { getNormalizedOrigin } from '../../shared/providerOrigin';

let cachedSettings: BetaSettings = { ...DEFAULT_SETTINGS };
let pendingSettingsOperation: Promise<unknown> = Promise.resolve();

// The service worker owns settings writes. Include upgrade reads in this queue
// so a delayed migration cannot overwrite a user's first settings change.
function serializeSettings<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingSettingsOperation.then(operation);
  pendingSettingsOperation = result.catch(() => {});
  return result;
}

function clampNumber(value: number | undefined, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function normalizeDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const normalized = new Set<string>();
  for (const value of input) {
    const text = String(value || '').trim().toLowerCase();
    if (text) normalized.add(text);
  }
  return Array.from(normalized);
}

function normalizeOrigins(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const normalized = new Set<string>();
  for (const value of input) {
    const origin = getNormalizedOrigin(typeof value === 'string' ? value : String(value || ''));
    if (origin) normalized.add(origin);
  }
  return Array.from(normalized);
}

function normalizeLogLevel(level: unknown): BetaSettings['logLevel'] {
  return level === 'debug' || level === 'info' || level === 'warn' || level === 'error' || level === 'off'
    ? level
    : DEFAULT_SETTINGS.logLevel;
}

function hydrateSettings(payload: Partial<BetaSettings> | undefined): BetaSettings {
  if (!payload || typeof payload !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  const hasLegacyCaptureChoice =
    typeof payload.paused === 'boolean' ||
    Array.isArray(payload.allowlist) ||
    Array.isArray(payload.denylist);
  const theme = payload.theme;
  const normalizedTheme: BetaSettings['theme'] = theme === 'dark' || theme === 'system' ? theme : 'light';
  const activeProviderId = typeof payload.activeProviderId === 'string' && payload.activeProviderId ? payload.activeProviderId : DEFAULT_SETTINGS.activeProviderId;
  return {
    paused: Boolean(payload.paused),
    captureSetupComplete:
      typeof payload.captureSetupComplete === 'boolean'
        ? payload.captureSetupComplete
        : hasLegacyCaptureChoice,
    acknowledgedRemoteProviderOrigins: normalizeOrigins(payload.acknowledgedRemoteProviderOrigins),
    allowlist: normalizeDomains(payload.allowlist),
    denylist: normalizeDomains(payload.denylist),
    contextWindowChars: clampNumber(payload.contextWindowChars, 400, 6000),
    askMaxSources: clampNumber(payload.askMaxSources, 1, 10),
    theme: normalizedTheme,
    activeProviderId,
    logLevel: normalizeLogLevel(payload.logLevel),
    answerMode: payload.answerMode === 'detailed' ? 'detailed' : 'concise',
    queryRewrite: typeof payload.queryRewrite === 'boolean' ? payload.queryRewrite : DEFAULT_SETTINGS.queryRewrite,
    searchRerank: typeof payload.searchRerank === 'boolean' ? payload.searchRerank : DEFAULT_SETTINGS.searchRerank,
    askRerank: typeof payload.askRerank === 'boolean' ? payload.askRerank : DEFAULT_SETTINGS.askRerank,
    enableTools: typeof payload.enableTools === 'boolean' ? payload.enableTools : DEFAULT_SETTINGS.enableTools,
    maxToolSteps: clampNumber(payload.maxToolSteps, 0, 100),
    toolTimeoutMs: clampNumber(payload.toolTimeoutMs, 1000, 30000),
    logFullBodies: typeof payload.logFullBodies === 'boolean' ? payload.logFullBodies : DEFAULT_SETTINGS.logFullBodies
  };
}

function setCached(settings: BetaSettings): BetaSettings {
  cachedSettings = settings;
  return cachedSettings;
}

export function getCachedSettingsSnapshot(): BetaSettings {
  return cachedSettings;
}

async function readSettingsFromStorage(): Promise<BetaSettings> {
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    chrome.storage.local.get([SETTINGS_KEY, 'paused', 'whitelistDomains', 'blacklistDomains'], (stored: Record<string, unknown>) => {
      if (chrome.runtime?.lastError) reject(chrome.runtime.lastError);
      else resolve(stored);
    });
  });
  const current = result[SETTINGS_KEY];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return setCached(hydrateSettings(current as Partial<BetaSettings>));
  }
  const hasLegacyPolicy = typeof result.paused === 'boolean' ||
    Array.isArray(result.whitelistDomains) || Array.isArray(result.blacklistDomains);
  if (hasLegacyPolicy) {
    const migrated = hydrateSettings({
      ...DEFAULT_SETTINGS,
      paused: typeof result.paused === 'boolean' ? result.paused : DEFAULT_SETTINGS.paused,
      allowlist: normalizeDomains(result.whitelistDomains),
      denylist: normalizeDomains(result.blacklistDomains),
      captureSetupComplete: true
    });
    // Persist once and keep the legacy keys as a backup. Existing beta settings
    // always win, including intentionally cleared domain lists.
    await writeSettingsToStorage(migrated);
    return setCached(migrated);
  }
  return setCached({ ...DEFAULT_SETTINGS });
}

function writeSettingsToStorage(settings: BetaSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }, () => {
      if (chrome.runtime?.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

function broadcastSettings(settings: BetaSettings): void {
  try {
    chrome.runtime.sendMessage({ type: 'BETA_SETTINGS_UPDATED', settings });
  } catch (err) {
    console.warn('[beta-background:settings] broadcast failed', err);
  }
}

function updateActionBadge(paused: boolean): void {
  if (!chrome.action) return;
  try {
    chrome.action.setBadgeText({ text: paused ? 'II' : '' });
    chrome.action.setBadgeBackgroundColor({ color: paused ? '#6b7280' : '#00000000' }).catch(() => {});
  } catch (err) {
    console.warn('[beta-background:settings] badge update failed', err);
  }
}

export async function getSettings(): Promise<BetaSettings> {
  return serializeSettings(readSettingsFromStorage);
}

export async function updateSettings(partial: Partial<BetaSettings>): Promise<BetaSettings> {
  return serializeSettings(() => updateStoredSettings(partial));
}

async function updateStoredSettings(partial: Partial<BetaSettings>): Promise<BetaSettings> {
  const current = await readSettingsFromStorage();
  const next: BetaSettings = {
    paused: typeof partial.paused === 'boolean' ? partial.paused : current.paused,
    captureSetupComplete:
      typeof partial.captureSetupComplete === 'boolean'
        ? partial.captureSetupComplete
        : current.captureSetupComplete,
    acknowledgedRemoteProviderOrigins: Array.isArray(partial.acknowledgedRemoteProviderOrigins)
      ? normalizeOrigins(partial.acknowledgedRemoteProviderOrigins)
      : current.acknowledgedRemoteProviderOrigins,
    allowlist: Array.isArray(partial.allowlist) ? normalizeDomains(partial.allowlist) : current.allowlist,
    denylist: Array.isArray(partial.denylist) ? normalizeDomains(partial.denylist) : current.denylist,
    contextWindowChars: typeof partial.contextWindowChars === 'number' ? clampNumber(partial.contextWindowChars, 400, 6000) : current.contextWindowChars,
    askMaxSources: typeof partial.askMaxSources === 'number' ? clampNumber(partial.askMaxSources, 1, 10) : current.askMaxSources,
    theme: partial.theme === 'dark' || partial.theme === 'system' || partial.theme === 'light' ? partial.theme : current.theme,
    activeProviderId: typeof partial.activeProviderId === 'string' && partial.activeProviderId ? partial.activeProviderId : current.activeProviderId,
    logLevel: normalizeLogLevel(partial.logLevel ?? current.logLevel),
    answerMode: partial.answerMode || current.answerMode,
    queryRewrite: typeof partial.queryRewrite === 'boolean' ? partial.queryRewrite : current.queryRewrite,
    searchRerank: typeof partial.searchRerank === 'boolean' ? partial.searchRerank : current.searchRerank,
    askRerank: typeof partial.askRerank === 'boolean' ? partial.askRerank : current.askRerank,
    enableTools: typeof partial.enableTools === 'boolean' ? partial.enableTools : current.enableTools,
    maxToolSteps: typeof partial.maxToolSteps === 'number' ? clampNumber(partial.maxToolSteps, 0, 100) : current.maxToolSteps,
    toolTimeoutMs: typeof partial.toolTimeoutMs === 'number' ? clampNumber(partial.toolTimeoutMs, 1000, 30000) : current.toolTimeoutMs,
    logFullBodies: typeof partial.logFullBodies === 'boolean' ? partial.logFullBodies : current.logFullBodies
  };
  await writeSettingsToStorage(next);
  setCached(next);
  try {
    setLogLevel(next.logLevel);
  } catch (err) {
    console.warn('[beta-background:settings] unable to set log level', err);
  }
  updateActionBadge(next.paused);
  broadcastSettings(next);
  return next;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesDomain(host: string, patterns: string[]): boolean {
  if (!host) return false;
  for (const pattern of patterns) {
    if (!pattern) continue;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (host.endsWith(suffix)) return true;
      continue;
    }
    if (host === pattern || host.endsWith(`.${pattern}`)) {
      return true;
    }
  }
  return false;
}

export async function shouldCaptureUrl(
  url: string,
  options: { ignorePaused?: boolean } = {}
): Promise<boolean> {
  const settings = await getSettings();
  if (!options.ignorePaused && settings.paused) {
    return false;
  }
  const host = getHostname(url);
  if (settings.allowlist.length > 0) {
    return matchesDomain(host, settings.allowlist);
  }
  if (matchesDomain(host, settings.denylist)) {
    return false;
  }
  return true;
}

try {
  chrome.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    const entry = changes[SETTINGS_KEY];
    if (!entry || typeof entry.newValue !== 'object') return;
    setCached(hydrateSettings(entry.newValue as Partial<BetaSettings>));
    try {
      setLogLevel(cachedSettings.logLevel);
    } catch (err) {
      console.warn('[beta-background:settings] unable to sync log level from storage', err);
    }
    updateActionBadge(cachedSettings.paused);
  });
} catch (err) {
  console.warn('[beta-background:settings] unable to bind storage listener', err);
}

void getSettings()
  .then((settings) => {
    try {
      setLogLevel(settings.logLevel);
    } catch (err) {
      console.warn('[beta-background:settings] unable to set initial log level', err);
    }
    updateActionBadge(settings.paused);
  })
  .catch(() => {});
