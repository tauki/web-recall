export function installRecallObserver() {
  globalThis.benchmarkObservation = null;
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  const accept = (current, response) => {
    current.response = response;
    current.error = chrome.runtime.lastError?.message;
    current.completed = true;
    current.expectedRows = response?.results;
  };
  chrome.runtime.onMessage.addListener(message => {
    const current = globalThis.benchmarkObservation;
    if (current?.requestId && message.type === 'SEARCH_RESULTS_UPDATE' && message.requestId === current.requestId) current.expectedRows = message.results;
  });
  chrome.runtime.sendMessage = (message, ...rest) => {
    const current = globalThis.benchmarkObservation;
    if (message.type === 'SEARCH_QUERY' && current) {
      current.requestId = message.requestId;
      if (typeof rest.at(-1) === 'function') {
        const callback = rest.pop();
        rest.push(response => { accept(current, response); callback(response); });
      }
    }
    const result = send(message, ...rest);
    if (message.type === 'SEARCH_QUERY' && current && result?.then) result.then(response => accept(current, response), error => { current.error = String(error); current.completed = true; });
    return result;
  };
  document.addEventListener('submit', event => {
    if (event.target.id !== 'beta-search-form') return;
    globalThis.benchmarkObservation = { start: performance.now(), requestId: null, completed: false, firstVisibleMs: null, initialRows: new Set(document.querySelectorAll('#beta-search-results > article')) };
  }, true);
  const rendered = current => {
    if (!current.expectedRows?.length) return false;
    const rows = [...document.querySelectorAll('#beta-search-results > article')];
    return rows.length === current.expectedRows.length && rows.every((row, index) => {
      const expected = current.expectedRows[index];
      return !current.initialRows.has(row) && row.querySelector(':scope > details')?.dataset.url === expected.url && row.querySelector('.result-title')?.textContent === (expected.title || expected.url) && (row.querySelector('.result-snippet')?.textContent || '') === (expected.snippet || '').replace(/\s+/gu, ' ').trim() && row.querySelector('.wr-match-details p')?.textContent.endsWith(new Date(expected.timestamp).toLocaleString());
    });
  };
  new MutationObserver(() => {
    const current = globalThis.benchmarkObservation;
    if (!current?.requestId || current.firstVisibleMs !== null || current.paintPending || !rendered(current)) return;
    current.paintPending = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (globalThis.benchmarkObservation !== current) return;
      const row = document.querySelector('#beta-search-results > article');
      const bounds = row?.getBoundingClientRect();
      if (rendered(current) && bounds && bounds.width > 0 && bounds.height > 0 && bounds.top < innerHeight && bounds.bottom > 0 && getComputedStyle(row).visibility !== 'hidden') current.firstVisibleMs = performance.now() - current.start;
      current.paintPending = false;
    }));
  }).observe(document, { childList: true, subtree: true });
}

export async function observeSavedReader(element, passages = []) {
  const text = element.textContent;
  const marker = element.querySelector('mark'), rectangle = marker?.getBoundingClientRect();
  const preceding = document.createRange();
  if (marker) { preceding.setStart(element, 0); preceding.setEndBefore(marker); }
  const painted = target => {
    if (!target || getComputedStyle(target).visibility !== 'visible') return false;
    for (let parent = target; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  const nodes = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push({ node, start: offset, end: offset + node.length, painted: painted(node.parentElement) }); offset += node.length; }
  const bounds = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  for (let parent = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
    if (/hidden|clip|auto|scroll/u.test(style.overflowX)) { bounds.left = Math.max(bounds.left, box.left + parent.clientLeft); bounds.right = Math.min(bounds.right, box.left + parent.clientLeft + parent.clientWidth); }
    if (/hidden|clip|auto|scroll/u.test(style.overflowY)) { bounds.top = Math.max(bounds.top, box.top + parent.clientTop); bounds.bottom = Math.min(bounds.bottom, box.top + parent.clientTop + parent.clientHeight); }
  }
  const visibleBodyRanges = [];
  for (const passage of passages) {
    const lines = [];
    for (const word of text.slice(passage.start, passage.end).matchAll(/\S+/gu)) {
      const start = passage.start + word.index, end = start + word[0].length;
      const first = nodes.find(entry => entry.start <= start && entry.end > start);
      const last = nodes.find(entry => entry.start < end && entry.end >= end);
      if (!first || !last) continue;
      const wordPainted = nodes.every(entry => entry.end <= start || entry.start >= end || entry.painted);
      const range = document.createRange();
      range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
      for (const box of range.getClientRects()) {
        if (!box.width || !box.height) continue;
        const line = lines.find(entry => entry.top < box.bottom && entry.bottom > box.top);
        if (line) { line.left = Math.min(line.left, box.left); line.right = Math.max(line.right, box.right); line.top = Math.min(line.top, box.top); line.bottom = Math.max(line.bottom, box.bottom); line.painted &&= wordPainted; }
        else lines.push({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, painted: wordPainted });
      }
    }
    const visibleLines = lines.filter(line => line.painted && line.left >= bounds.left && line.right <= bounds.right && line.top >= bounds.top && line.bottom <= bounds.bottom && [line.top + 0.01, (line.top + line.bottom) / 2, line.bottom - 0.01].every(vertical => [line.left + 0.01, (line.left + line.right) / 2, line.right - 0.01].every(horizontal => element.contains(document.elementFromPoint(horizontal, vertical)))));
    if (visibleLines.length) visibleBodyRanges.push({ start: passage.start, end: passage.end, lines: visibleLines.length });
  }
  return {
    digest: [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join(''),
    marker: marker ? { text: marker.textContent, start: preceding.toString().length, end: preceding.toString().length + marker.textContent.length, visible: painted(marker) && rectangle.width > 0 && rectangle.height > 0 && rectangle.top < innerHeight && rectangle.bottom > 0 } : null,
    visibleBodyRanges
  };
}

export function blockBenchmarkModels(allowStorage = false) {
  globalThis.benchmarkCalls = { http: [], native: 0, offscreen: 0, modelDispatches: [], storageOpens: 0 };
  globalThis.fetch = async input => { globalThis.benchmarkCalls.http.push(String(input)); throw Error('Model access disabled during recall measurement'); };
  for (const name of ['connectNative', 'sendNativeMessage']) {
    chrome.runtime[name] = () => { globalThis.benchmarkCalls.native++; throw Error('Native access disabled during recall measurement'); };
  }
  if (chrome.runtime.sendMessage) {
    const dispatch = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const type = args.find(value => typeof value?.type === 'string')?.type;
      if (type?.startsWith('OFFSCREEN_') && type !== 'OFFSCREEN_SAVED_LIBRARY') {
        globalThis.benchmarkCalls.modelDispatches.push(type);
        throw Error('Offscreen model dispatch disabled during recall measurement');
      }
      return dispatch(...args);
    };
  }
  if (chrome.offscreen?.createDocument) {
    const openDocument = chrome.offscreen.createDocument.bind(chrome.offscreen);
    chrome.offscreen.createDocument = async options => {
      if (allowStorage && options?.url === chrome.runtime.getURL('dist/beta/offscreen/index.html') && options.reasons?.includes('WORKERS')) {
        globalThis.benchmarkCalls.storageOpens++;
        return openDocument(options);
      }
      globalThis.benchmarkCalls.offscreen++;
      throw Error('Offscreen inference disabled during recall measurement');
    };
  }
}
