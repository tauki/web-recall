import { shouldCaptureUrl } from '../settings/index';

export async function captureTab(tabId?: number | null): Promise<{ ok: boolean; received: boolean }> {
  if (typeof tabId !== 'number' || tabId < 0) throw new Error('No active tab');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url)) {
    throw new Error('Cannot capture this page (unsupported or restricted URL).');
  }
  if (!await shouldCaptureUrl(tab.url, { ignorePaused: true })) {
    throw new Error('Capture blocked by your allowlist or denylist rules for this page.');
  }
  let response: { ok?: boolean } | undefined;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: 'FORCE_CAPTURE' });
  } catch (err) {
    if (!String(err).includes('Receiving end does not exist')) throw err;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/beta/content.js'] });
    response = await chrome.tabs.sendMessage(tabId, { type: 'FORCE_CAPTURE' });
  }
  return { ok: true, received: response?.ok === true };
}
