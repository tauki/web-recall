export type ProviderOriginInfo = {
  isValid: boolean;
  isRemote: boolean;
  origin?: string;
  hostname?: string;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function getNormalizedOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.trim()).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export function getProviderOriginInfo(url: string | undefined): ProviderOriginInfo {
  if (!url) {
    return { isValid: false, isRemote: false };
  }
  try {
    const parsed = new URL(url.trim());
    const hostname = parsed.hostname.toLowerCase();
    const origin = parsed.origin.toLowerCase();
    const isRemote = !LOOPBACK_HOSTS.has(hostname);
    return {
      isValid: true,
      isRemote,
      origin,
      hostname
    };
  } catch {
    return { isValid: false, isRemote: false };
  }
}
