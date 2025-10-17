/**
 * Central logger shared across background/offscreen/UI contexts.
 * Persists entries to chrome.storage so logs.html can display them later.
 */

(function(scope){
  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const STORAGE_KEY = 'logs';
  const MAX_LOGS = 2000;

  function nowTs(){ return Date.now(); }

  async function appendLogRow(row){
    try {
      if (!scope.chrome || !chrome.storage || !chrome.storage.local) return; // cannot persist
      await new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          const arr = Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
          arr.push(row);
          // cap size
          if (arr.length > MAX_LOGS) arr.splice(0, arr.length - MAX_LOGS);
          chrome.storage.local.set({ [STORAGE_KEY]: arr }, () => resolve());
        });
      });
    } catch (_) {}
  }

  const Logger = {
    level: 'info',
    setLevel(lvl){ if (LEVELS[lvl]) this.level = lvl; },
    shouldLog(lvl){ return (LEVELS[lvl] || 0) >= (LEVELS[this.level] || 0); },
    async log(lvl, message, meta){
      if (!this.shouldLog(lvl)) return;
      // Console output
      try {
        const out = (meta === undefined) ? '' : (typeof meta === 'string' ? meta : JSON.stringify(meta));
        if (lvl === 'error') console.error('[WM]', message, out);
        else if (lvl === 'warn') console.warn('[WM]', message, out);
        else if (lvl === 'info') console.info('[WM]', message, out);
        else console.debug('[WM]', message, out);
      } catch (_) {}
      // Persist for logs.html consumers
      try {
        const row = { level: lvl, message: String(message || ''), meta: meta ?? null, ts: nowTs() };
        await appendLogRow(row);
      } catch (_) {}
    },
    debug(msg, meta){ return this.log('debug', msg, meta); },
    info(msg, meta){ return this.log('info', msg, meta); },
    warn(msg, meta){ return this.log('warn', msg, meta); },
    error(msg, meta){ return this.log('error', msg, meta); },
  };

  // Load configured log level from storage (best-effort)
  (async () => {
    try {
      if (scope.chrome?.storage?.local) {
        await new Promise((resolve) => {
          chrome.storage.local.get(['logLevel'], (res) => {
            const lvl = res?.logLevel;
            if (LEVELS[lvl]) Logger.level = lvl;
            resolve();
          });
        });
      }
    } catch (_) {}
  })();

  // Export
  scope.LOGGER = Logger;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LOGGER: Logger };
  }
})(typeof self !== 'undefined' ? self : this);
