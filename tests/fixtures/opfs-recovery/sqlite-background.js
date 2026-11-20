const offscreenUrl = chrome.runtime.getURL('offscreen.html');
let opening;

function ensureOffscreen() {
  opening ??= (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] });
    if (contexts.length === 0) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Host the SQLite qualification storage worker without a visible tab.'
    });
  })().finally(() => { opening = undefined; });
  return opening;
}

async function operate(request) {
  if (request.kind === 'close-host') {
    await chrome.offscreen.closeDocument();
    return { closed: true };
  }
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ channel: 'sqlite-offscreen', request });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.channel !== 'sqlite-probe' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('probe.html')) return false;
  void operate(message.request).then(respond, error => respond({ error: error.message }));
  return true;
});
