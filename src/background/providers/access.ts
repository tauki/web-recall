import { getProviderOriginInfo } from '../../shared/providerOrigin';
import { acknowledgeRemoteProviderOrigin, getSettings } from '../settings/index';

export type ProviderConsentOptions = { acknowledgeRemoteOrigin?: boolean };

export async function assertProviderOriginAcknowledged(baseUrl: string): Promise<void> {
  const info = getProviderOriginInfo(baseUrl);
  if (!info.isValid || !info.origin) throw new Error('Provider URL must use HTTP or HTTPS.');
  if (!info.isRemote) return;
  const settings = await getSettings();
  if (!(settings.acknowledgedRemoteProviderOrigins || []).includes(info.origin)) {
    throw new Error(`Remote provider ${info.origin} requires acknowledgement in Settings before it can be used.`);
  }
}

export async function authorizeProviderOrigin(baseUrl: string, options: ProviderConsentOptions): Promise<void> {
  const info = getProviderOriginInfo(baseUrl);
  if (info.isValid && info.isRemote && info.origin && options.acknowledgeRemoteOrigin === true) {
    await acknowledgeRemoteProviderOrigin(info.origin);
  }
  await assertProviderOriginAcknowledged(baseUrl);
}
