/**
 * Memory manager panel:
 * - Lists captured pages with sort/filter controls.
 * - Supports bulk delete, summary backfill, import/export.
 */

const CURRENT = { pages: [], sortKey: 'date', sortAsc: false };

// ---------------------------------------------------------------------------
// Table rendering and sorting
// ---------------------------------------------------------------------------

function renderRows(pages) {
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  for (const p of pages) {
    const tr = document.createElement('tr');
    const tdSel = document.createElement('td');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'rowSel'; cb.dataset.id = p.id;
    tdSel.appendChild(cb);
    const tdTitle = document.createElement('td');
    const a = document.createElement('a');
    a.href = p.url; a.target = '_blank'; a.textContent = p.title || p.url;
    tdTitle.appendChild(a);
    const tdUrl = document.createElement('td');
    tdUrl.textContent = p.url;
    const tdDate = document.createElement('td');
    tdDate.textContent = new Date(p.timestamp).toLocaleString();
    const tdActions = document.createElement('td');
    const openBtn = document.createElement('button'); openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => window.open(p.url, '_blank'));
    const delBtn = document.createElement('button'); delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (!confirm('Delete this item from memory?')) return;
      chrome.runtime.sendMessage({ type: 'DELETE_PAGE', id: p.id }, (resp) => {
        if (resp?.error) alert('Delete failed: ' + resp.error);
        else refresh();
      });
    });
    tdActions.appendChild(openBtn);
    tdActions.appendChild(delBtn);
    tr.appendChild(tdSel); tr.appendChild(tdTitle); tr.appendChild(tdUrl); tr.appendChild(tdDate); tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_PAGE_LIST' }, (resp) => {
    let list = (resp && Array.isArray(resp.pages)) ? resp.pages : [];
    const q = (document.getElementById('searchInput').value || '').toLowerCase().trim();
    if (q) list = list.filter(p => (p.title||'').toLowerCase().includes(q) || (new URL(p.url).hostname||'').toLowerCase().includes(q));
    CURRENT.pages = list.slice();
    applySort();
  });
}

function applySort() {
  const key = CURRENT.sortKey; const asc = CURRENT.sortAsc;
  const sorted = CURRENT.pages.slice().sort((a,b) => {
    let va, vb;
    if (key === 'title') { va = (a.title||'').toLowerCase(); vb = (b.title||'').toLowerCase(); }
    else if (key === 'url') { va = a.url.toLowerCase(); vb = b.url.toLowerCase(); }
    else { va = a.timestamp; vb = b.timestamp; }
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  });
  renderRows(sorted);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('searchInput').addEventListener('input', () => refresh());
document.getElementById('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('.rowSel').forEach(cb => { cb.checked = e.target.checked; });
});
document.getElementById('deleteSelectedBtn').addEventListener('click', () => {
  const ids = Array.from(document.querySelectorAll('.rowSel:checked')).map(cb => parseInt(cb.dataset.id, 10)).filter(Boolean);
  if (ids.length === 0) return alert('No rows selected');
  if (!confirm(`Delete ${ids.length} item(s)?`)) return;
  let done = 0;
  ids.forEach(id => {
    chrome.runtime.sendMessage({ type: 'DELETE_PAGE', id }, () => {
      done++; if (done === ids.length) refresh();
    });
  });
});
document.getElementById('backfillSelectedBtn').addEventListener('click', () => {
  const ids = Array.from(document.querySelectorAll('.rowSel:checked')).map(cb => parseInt(cb.dataset.id, 10)).filter(Boolean);
  if (ids.length === 0) return alert('No rows selected');
  const confirmMsg = 'Backfill will embed missing items, compute centroid/hash, and generate summaries if missing. Proceed?';
  if (!confirm(confirmMsg)) return;
  const prog = document.getElementById('importProgress');
  if (prog) prog.textContent = 'Backfilling...';
  chrome.runtime.sendMessage({ type: 'BACKFILL_RECORDS', ids }, (resp) => {
    if (prog) prog.textContent = '';
    if (resp?.error) alert('Backfill failed: ' + resp.error);
    else { alert(`Backfilled ${resp.done || 0} item(s)`); refresh(); }
  });
});
document.getElementById('exportBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_ALL_PAGES' }, async (resp) => {
    if (resp?.error) { alert('Export failed: ' + resp.error); return; }
    const pages = resp.pages || [];
    // Include a schema version and export timestamp; include embedding metadata if present
    const schemaVersion = 1;
    const exportedAt = new Date().toISOString();
    const meta = await new Promise(resolve => chrome.storage.local.get(['embeddingMeta', 'embedModel'], (r) => resolve(r)));
    const embeddingMeta = meta?.embeddingMeta || (meta?.embedModel ? { model: meta.embedModel, dim: (pages[0]?.items?.[0]?.embedding?.length || null) } : undefined);
    const payload = { schemaVersion, exportedAt, embeddingMeta, pages };
    const data = JSON.stringify(payload, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'web_recall_export_v1.json'; a.click();
    URL.revokeObjectURL(url);
  });
});
document.getElementById('importInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      let schemaVersion = 0;
      let pages = [];
      let embeddingMeta = undefined;
      if (Array.isArray(json)) {
        // Legacy export: just an array of pages
        pages = json;
      } else if (json && typeof json === 'object') {
        schemaVersion = Number.isFinite(json.schemaVersion) ? json.schemaVersion : 0;
        if (!Array.isArray(json.pages)) throw new Error('Invalid file: missing pages[]');
        if (schemaVersion > 1) {
          const proceed = confirm(`This file uses schema v${schemaVersion} which may be unsupported. Attempt import anyway?`);
          if (!proceed) return;
        }
        pages = json.pages;
        embeddingMeta = json.embeddingMeta && typeof json.embeddingMeta === 'object' ? json.embeddingMeta : undefined;
      } else {
        throw new Error('Invalid JSON structure');
      }
      const prog = document.getElementById('importProgress');
      if (prog) prog.textContent = 'Importing...';
      chrome.runtime.sendMessage({ type: 'IMPORT_PAGES', schemaVersion, embeddingMeta, pages }, (resp) => {
        if (resp?.error) {
          alert('Import failed: ' + resp.error);
          if (prog) prog.textContent = '';
        } else {
          const skipped = Number.isFinite(resp?.skippedIncompatible) ? resp.skippedIncompatible : 0;
          if (prog) prog.textContent = 'Import complete';
          if (skipped > 0) {
            alert(`Import finished. Skipped ${skipped} incompatible version(s) due to embedding dimension mismatch.`);
          }
          refresh();
        }
      });
    } catch (err) {
      alert('Invalid JSON: ' + err.message);
    }
  };
  reader.readAsText(file);
});
document.getElementById('thTitle').addEventListener('click', () => { CURRENT.sortKey='title'; CURRENT.sortAsc=!CURRENT.sortAsc; applySort(); });
document.getElementById('thUrl').addEventListener('click', () => { CURRENT.sortKey='url'; CURRENT.sortAsc=!CURRENT.sortAsc; applySort(); });
document.getElementById('thDate').addEventListener('click', () => { CURRENT.sortKey='date'; CURRENT.sortAsc=!CURRENT.sortAsc; applySort(); });

refresh();

// Listen for import progress updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'IMPORT_PROGRESS') {
    const prog = document.getElementById('importProgress');
    if (!prog) return;
    const done = msg.done || 0; const total = msg.total || 0;
    if (total > 0) {
      const pct = Math.floor((done / total) * 100);
      const label = msg.label ? ` — ${msg.label}` : '';
      prog.textContent = `Importing: ${done}/${total} (${pct}%)${label}`;
    } else {
      prog.textContent = 'Importing...';
    }
  }
});
