/**
 * Highlights dashboard:
 * - Lists days with summaries produced by the background worker.
 * - Supports date filtering, pagination, and cache backfill.
 */

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
function fmtDate(d) {
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' });
}

async function listDates(from, to, offset, limit) {
  const resp = await send({ type: 'LIST_HIGHLIGHT_DATES', from, to, offset, limit });
  if (resp && resp.error) throw new Error(resp.error);
  return resp || { dates: [], total: 0 };
}

async function getHighlight(date) {
  const resp = await send({ type: 'GET_HIGHLIGHTS', date });
  if (resp && resp.error) throw new Error(resp.error);
  return resp && resp.highlight ? resp.highlight : '';
}
// ---------------------------------------------------------------------------
// UI initialisation
// ---------------------------------------------------------------------------
(function init() {
  const list = document.getElementById('list');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const pageInfo = document.getElementById('pageInfo');
  const status = document.getElementById('status');
  const fromDate = document.getElementById('fromDate');
  const toDate = document.getElementById('toDate');
  const pageSize = document.getElementById('pageSize');
  const applyBtn = document.getElementById('applyFilter');
  const backfillBtn = document.getElementById('backfillBtn');

  let curOffset = 0;
  let total = 0;

  function getSize() { const v = parseInt(pageSize.value, 10); return isNaN(v) ? 14 : v; }

  async function render() {
    list.innerHTML = '';
    pageInfo.textContent = '';
    status.textContent = 'Loading dates…';
    prevBtn.disabled = true; nextBtn.disabled = true;
    const from = fromDate.value || null; const to = toDate.value || null;
    const limit = getSize();
    try {
      const { dates, total: t } = await listDates(from, to, curOffset, limit);
      total = t;
      const pageStart = Math.min(total, curOffset + 1);
      const pageEnd = Math.min(total, curOffset + dates.length);
      pageInfo.textContent = total ? `Showing ${pageStart}-${pageEnd} of ${total} days` : 'No days';
      status.textContent = '';
      prevBtn.disabled = curOffset <= 0;
      nextBtn.disabled = (curOffset + dates.length) >= total;
      for (const d of dates) {
        const card = document.createElement('div');
        card.className = 'date-card';
        const h = document.createElement('h4');
        h.className = 'date-h';
        h.textContent = `${fmtDate(d.date)} — ${d.count} page${d.count===1?'':'s'}`;
        const body = document.createElement('div');
        body.className = 'hl muted';
        body.textContent = 'Loading…';
        card.appendChild(h); card.appendChild(body);
        list.appendChild(card);
        // Fetch highlight for this day
        try {
          const hl = await getHighlight(d.date);
          body.className = 'hl';
          body.textContent = hl || '(No highlight)';
        } catch (e) {
          body.className = 'hl muted';
          body.textContent = `Error: ${e.message}`;
        }
      }
    } catch (e) {
      status.textContent = `Error: ${e.message}`;
    }
  }

  prevBtn.addEventListener('click', () => { const sz = getSize(); curOffset = Math.max(0, curOffset - sz); render(); });
  nextBtn.addEventListener('click', () => { const sz = getSize(); curOffset = curOffset + sz; render(); });
  applyBtn.addEventListener('click', () => { curOffset = 0; render(); });

  backfillBtn.addEventListener('click', async () => {
    // Force-generate cache for currently visible dates by calling GET_HIGHLIGHTS
    try {
      status.textContent = 'Backfilling…';
      const from = fromDate.value || null; const to = toDate.value || null; const limit = getSize();
      const { dates } = await listDates(from, to, curOffset, limit);
      for (let i = 0; i < dates.length; i++) {
        try { await getHighlight(dates[i].date); } catch (_) {}
      }
      status.textContent = 'Backfill complete.';
      render();
    } catch (e) {
      status.textContent = `Error: ${e.message}`;
    }
  });

  render();
})();
