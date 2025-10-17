/**
 * Vector helpers shared across background/offscreen contexts.
 * Exposes globals on `self`: cosineSimilarity, recencyWeight, computeCentroid.
 */

(function(scope){
  function safeArray(x){ return (Array.isArray(x) ? x : null); }

  function cosineSimilarity(a, b) {
    const va = safeArray(a); const vb = safeArray(b);
    if (!va || !vb || va.length === 0 || vb.length === 0) return 0;
    // Require equal dimension; if mismatch, use min length but guard zero-norm
    const len = Math.min(va.length, vb.length);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < len; i++) {
      const ai = +va[i] || 0; const bi = +vb[i] || 0;
      dot += ai * bi;
      na += ai * ai;
      nb += bi * bi;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function recencyWeight(ts) {
    const WINDOW = 30 * 24 * 60 * 60 * 1000; // 30 days
    if (!Number.isFinite(ts)) return 1;
    const age = Math.max(0, Date.now() - ts);
    return Math.exp(-age / WINDOW);
  }

  function computeCentroid(items) {
    if (!items || items.length === 0) return null;
    const dim = items[0]?.embedding?.length || 0;
    if (!dim) return null;
    const acc = new Array(dim).fill(0);
    let count = 0;
    for (const it of items) {
      const e = it && it.embedding;
      if (!Array.isArray(e) || e.length !== dim) continue;
      for (let i = 0; i < dim; i++) acc[i] += (+e[i] || 0);
      count++;
    }
    if (count === 0) return null;
    for (let i = 0; i < dim; i++) acc[i] /= count;
    return acc;
  }

  scope.cosineSimilarity = cosineSimilarity;
  scope.recencyWeight = recencyWeight;
  scope.computeCentroid = computeCentroid;
})(typeof self !== 'undefined' ? self : this);
