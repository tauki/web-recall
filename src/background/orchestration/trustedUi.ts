export function isTrustedUi(sender?: { id?: string; url?: string }): boolean {
  try {
    const url = new URL(sender?.url || '');
    return sender?.id === chrome.runtime.id && url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && url.pathname.startsWith('/dist/beta/ui/');
  } catch { return false; }
}
