/**
 * Logs viewer:
 * - Fetches structured logs from the background worker.
 * - Provides level/text filters and optional auto-refresh.
 */

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

// ---------------------------------------------------------------------------
// Rendering + filters
// ---------------------------------------------------------------------------

function renderLogs(logs) {
  const cont = document.getElementById('logContainer');
  cont.innerHTML = '';
  if (!Array.isArray(logs) || logs.length === 0) {
    cont.textContent = 'No logs.';
    return;
  }
  // Apply filters
  const levelSel = document.getElementById('filterLevel').value;
  const textRaw = (document.getElementById('filterText').value || '');
  const text = textRaw.toLowerCase();
  const hideSelf = document.getElementById('hideSelf').checked;
  const minLevel = levelSel === 'all' ? 0 : LEVEL_ORDER[levelSel] || 0;
  // Parse include/exclude tokens: words or quoted phrases; '-' prefix means exclude
  const includes = [];
  const excludes = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(textRaw)) !== null) {
    const tok = (m[1] || m[2] || '').trim();
    if (!tok) continue;
    const isEx = tok.startsWith('-');
    const val = (isEx ? tok.slice(1) : tok).toLowerCase();
    if (!val) continue;
    (isEx ? excludes : includes).push(val);
  }
  const rows = logs.slice().reverse().filter(row => {
    const lvl = LEVEL_ORDER[row.level] || 0;
    if (lvl < minLevel) return false;
    const blob = JSON.stringify(row).toLowerCase();
    if (includes.length > 0) {
      // All include tokens must be present
      for (const inc of includes) { if (!blob.includes(inc)) return false; }
    }
    if (excludes.length > 0) {
      for (const exc of excludes) { if (blob.includes(exc)) return false; }
    }
    if (hideSelf && row.message === 'onMessage' && row.meta && (row.meta.type === 'GET_LOGS' || row.meta.type === 'CLEAR_LOGS')) {
      return false;
    }
    return true;
  });

  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'row';
    const ts = new Date(row.ts || Date.now()).toLocaleString();
    const lvl = document.createElement('strong');
    lvl.textContent = row.level || 'info';
    lvl.className = 'lvl-' + (row.level || 'info');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ` — ${ts}`;
    const msg = document.createElement('div');
    msg.textContent = row.message || '';
    div.appendChild(lvl);
    div.appendChild(meta);
    div.appendChild(msg);
    if (row.meta) {
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(row.meta, null, 2);
      div.appendChild(pre);
    }
    cont.appendChild(div);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (resp) => {
    if (resp && !resp.error) renderLogs(resp.logs);
  });
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('clearBtn').addEventListener('click', () => {
  const cont = document.getElementById('logContainer');
  cont.textContent = 'Clearing…';
  const wasAuto = auto.checked;
  if (timer) { clearInterval(timer); timer = null; }
  chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, () => {
    cont.textContent = 'No logs.';
    // Small delay to let storage settle, then refresh and restore auto if needed
    setTimeout(() => {
      refresh();
      if (wasAuto) { timer = setInterval(refresh, 2000); }
    }, 100);
  });
});

// ---------------------------------------------------------------------------
// Event wiring + auto refresh
// ---------------------------------------------------------------------------
let timer = null;
const auto = document.getElementById('autoRefresh');
auto.addEventListener('change', () => {
  if (auto.checked) {
    timer = setInterval(refresh, 2000);
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
});

document.getElementById('filterLevel').addEventListener('change', refresh);
document.getElementById('filterText').addEventListener('input', () => {
  // throttled simple re-render
  refresh();
});
document.getElementById('hideSelf').addEventListener('change', refresh);

// Initial load
refresh();
timer = setInterval(refresh, 2000);
