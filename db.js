/**
 * IndexedDB utilities for Web Recall.
 * Exposes globals on `self`: DB_NAME, DB_VERSION, STORE_NAME, HIGHLIGHTS_STORE, openDB.
 */

(function(scope){
  const DB_NAME = 'webMemoryDB';
  const DB_VERSION = 4; // keep versioning for schema creation and future upgrades
  const STORE_NAME = 'pages';
  const HIGHLIGHTS_STORE = 'highlights';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          // Create the object store with an autoIncrement id.
          store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        } else {
          store = event.target.transaction.objectStore(STORE_NAME);
        }
        // Ensure the timestamp index exists for sorting by recency.
        if (!store.indexNames.contains('timestamp')) {
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        // Index on canonicalUrl to support versioned docs per URL.
        try {
          if (!store.indexNames.contains('canonicalUrl')) {
            store.createIndex('canonicalUrl', 'canonicalUrl', { unique: false });
          }
        } catch (_) {
          // Ignore if upgrade path doesn't support creating index here
        }
        // Daily highlights cache keyed by date (YYYY-MM-DD)
        try {
          if (!db.objectStoreNames.contains(HIGHLIGHTS_STORE)) {
            db.createObjectStore(HIGHLIGHTS_STORE, { keyPath: 'date' });
          }
        } catch (_) {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Attach to global scope for MV3 scripts (service worker, offscreen, pages)
  scope.DB_NAME = DB_NAME;
  scope.DB_VERSION = DB_VERSION;
  scope.STORE_NAME = STORE_NAME;
  scope.HIGHLIGHTS_STORE = HIGHLIGHTS_STORE;
  scope.openDB = openDB;
})(typeof self !== 'undefined' ? self : this);
