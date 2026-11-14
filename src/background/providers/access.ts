import { getProviderOriginInfo } from '../../shared/providerOrigin';
import { acknowledgeRemoteProviderOrigin, getSettings } from '../settings/index';

export type ProviderConsentOptions = { acknowledgeRemoteOrigin?: boolean };

export class ProviderAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAccessError';
  }
}

export async function assertProviderOriginAcknowledged(baseUrl: string): Promise<void> {
  const info = getProviderOriginInfo(baseUrl);
  if (!info.isValid || !info.origin) throw new ProviderAccessError('Provider URL must use HTTP or HTTPS.');
  if (!info.isRemote) return;
  const settings = await getSettings();
  if (!(settings.acknowledgedRemoteProviderOrigins || []).includes(info.origin)) {
    throw new ProviderAccessError(`Remote provider ${info.origin} requires acknowledgement in Settings before it can be used.`);
  }
}

export async function fetchProvider(url: string, options: RequestInit = {}): Promise<Response> {
  options.signal?.throwIfAborted();
  await assertProviderOriginAcknowledged(url);
  options.signal?.throwIfAborted();
  const response = await fetch(url, { ...options, redirect: 'manual' });
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderAccessError('Provider redirects are not allowed. Configure the final endpoint URL in Settings.');
  }
  return response;
}

export async function authorizeProviderOrigin(baseUrl: string, options: ProviderConsentOptions): Promise<void> {
  const info = getProviderOriginInfo(baseUrl);
  if (info.isValid && info.isRemote && info.origin && options.acknowledgeRemoteOrigin === true) {
    await acknowledgeRemoteProviderOrigin(info.origin);
  }
  await assertProviderOriginAcknowledged(baseUrl);
}
