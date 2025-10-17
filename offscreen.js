// Offscreen context: maintains simple in-memory views of the DB and
// performs background ranking so the service worker stays responsive.

// DB constants and openDB are centralized in db.js, included via offscreen.html before this script.


// Weights for ranking components.  Adjust these to tune retrieval.
//  - W_SIM: similarity weight (max cosine similarity across query variations)
//  - W_EXACT: boost if the exact query string appears in the snippet
//  - W_TOKEN: boost if any query token (>=3 chars) appears in the snippet or title
//  - W_RECENCY: weight for recency (exponential decay over 30 days)
// The weights should sum to roughly 1.0; they will be added together.
const W_SIM = 0.75;
const W_EXACT = 0.12;
const W_TITLE_EXACT = 0.03; // small exact-match boost for title
const W_TOKEN = 0.05;
const W_RECENCY = 0.05;


async function getAllPages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Lazy-built centroid index
let centroidIndex = null; // Array<{id, centroid, timestamp}>
async function ensureCentroidIndex() {
  if (centroidIndex) return centroidIndex;
  const pages = await getAllPages();
  const idx = [];
  for (const p of pages) {
    // Prefer latest version centroid if present
    let c = null;
    let ts = p.timestamp;
    if (Array.isArray(p.versions) && typeof p.latestVersionIndex === 'number' && p.versions.length > 0) {
      const latest = p.versions[p.latestVersionIndex] || p.versions[p.versions.length - 1];
      c = latest?.centroid || (latest?.items ? computeCentroid(latest.items) : null);
      ts = latest?.timestamp || p.timestamp;
    } else {
      c = p.centroid || (p.items ? computeCentroid(p.items) : null);
    }
    if (c) idx.push({ id: p.id, centroid: c, timestamp: ts });
  }
  centroidIndex = idx;
  return centroidIndex;
}

async function topPagesByCentroid(variationEmbeddings, topN) {
  if (!Array.isArray(variationEmbeddings) || variationEmbeddings.length === 0) return [];
  const idx = await ensureCentroidIndex();
  // score by max cosine across variations, then apply recency weight
  const scored = [];
  for (const entry of idx) {
    let maxSim = -Infinity;
    for (const ve of variationEmbeddings) {
      const sim = cosineSimilarity(ve, entry.centroid);
      if (sim > maxSim) maxSim = sim;
    }
    const weighted = maxSim * recencyWeight(entry.timestamp);
    scored.push({ id: entry.id, score: maxSim, weightedScore: weighted, timestamp: entry.timestamp });
  }
  scored.sort((a, b) => b.weightedScore - a.weightedScore);
  return scored.slice(0, Math.min(topN, scored.length));
}

async function getPagesByIds(ids) {
  const db = await openDB();
  const out = [];
  await new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    let remaining = ids.length;
    if (remaining === 0) return resolve();
    ids.forEach((id) => {
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) out.push(req.result); if (--remaining === 0) resolve(); };
      req.onerror = () => { if (--remaining === 0) resolve(); };
    });
  });
  return out;
}

async function scoreChunksInPages(pageIds, variationEmbeddings, originalQuery) {
  if (!Array.isArray(variationEmbeddings) || variationEmbeddings.length === 0) return [];
  const pages = await getPagesByIds(pageIds);
  const candidates = [];
  const q = (originalQuery || '').toLowerCase().trim();
  const qTokens = q.split(/\W+/).filter(t => t.length >= 3);
  for (const page of pages) {
    const titleLower = String(page.title || '').toLowerCase();
    const processItem = (item, ts, chunkIndex) => {
      // Compute maximum cosine similarity across all query variation embeddings
      let maxSim = -Infinity;
      for (const ve of variationEmbeddings) {
        const sim = cosineSimilarity(ve, item.embedding);
        if (sim > maxSim) maxSim = sim;
      }
      // Recency component
      const rw = recencyWeight(ts);
      // Check exact and token presence in snippet and title
      const rawSnippet = String(item.text || '');
      const snippetLower = rawSnippet.toLowerCase();
      let hasExact = false;
      let hasToken = false;
      if (q && q.length >= 3) {
        if (snippetLower.includes(q)) {
          hasExact = true;
        } else if (qTokens.length) {
          if (qTokens.some(tok => snippetLower.includes(tok))) {
            hasToken = true;
          }
        }
      }
      try {
        if (q && titleLower.includes(q)) {
          // exact title contains full query
        } else if (qTokens.length && qTokens.some(tok => titleLower.includes(tok))) {
          hasToken = true;
        }
      } catch (_) {}
      // Compute additive weighted score
      const simComponent = W_SIM * maxSim;
      const exactComponent = hasExact ? W_EXACT : 0;
      const titleExactComponent = (q && titleLower.includes(q)) ? W_TITLE_EXACT : 0;
      const tokenComponent = hasToken ? W_TOKEN : 0;
      const recencyComponent = W_RECENCY * rw;
      // Start with additive scoring components
      let weighted = simComponent + exactComponent + titleExactComponent + tokenComponent + recencyComponent;
      // Do not apply hard‑coded domain penalties here.  The weighted score
      // reflects similarity, query token presence and recency only.  If
      // certain sites consistently produce noise, users can block those
      // domains via the allowlist/denylist settings in the UI.
      const displaySnippet = (() => {
        const max = 200;
        const text = rawSnippet.trim();
        if (text.length <= max) return text;
        const cut = text.slice(0, max);
        // Backtrack to last whitespace to avoid mid-word cut
        const i = cut.lastIndexOf(' ');
        const end = i > 150 ? cut.slice(0, i) : cut;
        return end.replace(/[\s\.,;:!\-]+$/,'') + '…';
      })();
      candidates.push({
        url: page.url,
        title: page.title,
        snippet: displaySnippet,
        chunkIndex: typeof chunkIndex === 'number' ? chunkIndex : undefined,
        score: maxSim,
        weightedScore: weighted,
        recencyWeight: rw,
        containsExact: hasExact,
        timestamp: ts
      });
    };
    if (Array.isArray(page.versions) && page.versions.length > 0) {
      for (const v of page.versions) {
        const ts = typeof v.timestamp === 'number' ? v.timestamp : page.timestamp;
        const arr = v.items || [];
        for (let i = 0; i < arr.length; i++) processItem(arr[i], ts, i);
      }
    } else {
      const arr = page.items || [];
      for (let i = 0; i < arr.length; i++) processItem(arr[i], page.timestamp, i);
    }
  }
  return candidates;
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_TOP_PAGES') {
    const { variationEmbeddings, topN } = message;
    topPagesByCentroid(variationEmbeddings || [], topN || 20)
      .then(pages => sendResponse({ pages }))
      .catch(err => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_SCORE_CHUNKS') {
    const { pageIds, variationEmbeddings, originalQuery } = message;
    scoreChunksInPages(pageIds || [], variationEmbeddings || [], originalQuery)
      .then(candidates => sendResponse({ candidates }))
      .catch(err => sendResponse({ error: err?.message || String(err) }));
    return true;
  }
  if (message.type === 'OFFSCREEN_INVALIDATE_INDEX') {
    try { centroidIndex = null; } catch (_) {}
    try { sendResponse({ ok: true }); } catch (_) {}
    return true;
  }
});
