// Shared text utilities for Web Recall
// Exposes globals on self: normalizeText, stringHash
// Works in MV3 service worker via `import './text.js'` and in documents via <script src="text.js"></script>

(function(scope){
  /**
   * Normalize text for content hashing and comparisons by collapsing
   * whitespace and trimming.
   * @param {string} s
   * @returns {string}
   */
  function normalizeText(s) {
    if (!s) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  /**
   * Compute a simple 32‑bit unsigned hash for a string. Uses a basic
   * polynomial rolling hash. Not cryptographic; intended for dedupe keys.
   * @param {string} str
   * @returns {number}
   */
  function stringHash(str) {
    const s = normalizeText(str || '');
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      const chr = s.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; // 32‑bit
    }
    return hash >>> 0; // unsigned
  }

  scope.normalizeText = normalizeText;
  scope.stringHash = stringHash;
})(typeof self !== 'undefined' ? self : this);

