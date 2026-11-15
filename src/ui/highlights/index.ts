import { installSharedStyles, createToolNavigation, createBackLink, icon, iconMarkup, sourceMeta } from '../shared/presentation';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';

type HighlightDate = { date: string; count: number };
const state = { from: '', to: '', pageSize: 14, offset: 0, dates: [] as HighlightDate[], total: 0 };
let generation = 0;

function updateStatus(message: string, error = false): void {
  const status = document.querySelector<HTMLElement>('#highlight-status');
  if (status) { status.textContent = message; status.dataset.variant = error ? 'error' : 'info'; }
}

function formatPretty(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

async function loadHighlights(): Promise<void> {
  const current = ++generation;
  updateStatus('Loading…');
  try {
    const response = await sendRuntimeMessage<{ dates: HighlightDate[]; total: number }>({ type: 'LIST_HIGHLIGHT_DATES', from: state.from, to: state.to, offset: state.offset, limit: state.pageSize });
    if (current !== generation) return;
    state.dates = response.dates || []; state.total = response.total || 0;
    const list = document.querySelector<HTMLElement>('#highlight-list')!;
    const open = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>('details[open]')).map(item => item.dataset.date));
    list.replaceChildren();
    for (const day of state.dates) {
      const article = document.createElement('article'); article.className = 'content-item';
      const details = document.createElement('details'); details.className = 'content-entry highlight-entry'; details.name = 'highlight-day'; details.dataset.date = day.date; details.open = open.has(day.date);
      const summary = document.createElement('summary');
      const meta = document.createElement('span'); meta.className = 'source-meta'; meta.textContent = `${day.count} capture${day.count === 1 ? '' : 's'}`;
      const title = document.createElement('span'); title.className = 'result-title'; title.textContent = formatPretty(day.date);
      const excerpt = document.createElement('span'); excerpt.className = 'highlight-excerpt'; excerpt.textContent = 'Loading summary…';
      const caret = icon('caret-down'); caret.classList.add('content-entry-caret'); summary.append(meta, title, excerpt, caret);
      const body = document.createElement('div'); body.className = 'content-entry-body highlight-sources';
      details.append(summary, body); article.append(details); list.append(article);
      void sendRuntimeMessage<{ highlight: { text: string; entries?: Array<{ title: string; url: string }> } }>({ type: 'GET_HIGHLIGHTS', date: day.date }).then(response => {
        if (current !== generation || !article.isConnected) return;
        excerpt.textContent = response.highlight?.text?.split('\n').map(line => line.replace(/^\d+[.)]\s*/, '')).join(' · ') || 'No summary available.';
        const heading = document.createElement('h2'); heading.textContent = 'Highlighted pages'; body.append(heading);
        for (const page of response.highlight?.entries || []) {
          const link = document.createElement('a'); link.className = 'highlight-source'; link.href = page.url; link.target = '_blank'; link.rel = 'noreferrer';
          const title = document.createElement('span'); title.className = 'result-title'; title.textContent = page.title || page.url;
          link.append(sourceMeta(page.url), title, icon('arrow-up-right')); body.append(link);
        }
      }).catch(error => { if (current === generation) excerpt.textContent = `Summary unavailable: ${String(error.message || error)}`; });
    }
    if (!state.dates.length) { const empty = document.createElement('p'); empty.className = 'empty-tool-state'; empty.textContent = state.from || state.to ? 'No highlights in this range. Open the date filter to choose another.' : 'No highlights yet. Saved pages will appear here by day.'; list.append(empty); }
    document.querySelector<HTMLButtonElement>('#highlight-prev')!.disabled = state.offset <= 0;
    document.querySelector<HTMLButtonElement>('#highlight-next')!.disabled = state.offset + state.dates.length >= state.total;
    document.getElementById('highlight-count')!.textContent = `${state.total} ${state.total === 1 ? 'day' : 'days'}`;
    const first = Math.min(state.total, state.offset + 1), last = Math.min(state.total, state.offset + state.dates.length);
    document.getElementById('highlight-page-count')!.textContent = `${first === last ? first : `${first}–${last}`} of ${state.total} days`;
    updateStatus('');
  } catch (error) { if (current === generation) updateStatus(`Failed to load highlights: ${error instanceof Error ? error.message : String(error)}`, true); }
}

export function mountHighlights(target: HTMLElement): void {
  installSharedStyles();
  target.innerHTML = `<div class="wr-page">
    <h1>Daily Highlights</h1>
    <div class="view-toolbar"><span id="highlight-count" role="status">Loading…</span><button id="highlight-refresh" class="text-button">Refresh</button></div>
    <div class="view-controls"><details class="view-control"><summary><span id="highlight-range">All dates</span>${iconMarkup('caret-down')}</summary><div class="view-control-body">
      <form id="highlight-filter" class="highlights-filters">
        <label class="compact-setting"><span>From</span><input type="date" id="highlight-from" /></label>
        <label class="compact-setting"><span>To</span><input type="date" id="highlight-to" /></label>
        <label class="compact-setting"><span>Page size</span><input type="number" id="highlight-size" min="1" max="50" value="14" /></label>
        <button id="highlight-apply" class="primary-button">Apply</button>
      </form>
    </div></details><span id="highlight-page-size" class="view-control-note">14 days per page</span></div>
    <p id="highlight-status" class="status-line" role="status"></p>
    <div id="highlight-list" class="content-list"></div>
    <nav class="pagination" aria-label="Highlight pages"><button id="highlight-prev" class="text-button" disabled>${iconMarkup('arrow-left')}Previous</button><span id="highlight-page-count"></span><button id="highlight-next" class="text-button" disabled>Next${iconMarkup('arrow-right')}</button></nav>
  </div>`;
  target.querySelector('.wr-page')!.prepend(createBackLink());
  if (!document.querySelector('#beta-view-search')) target.prepend(createToolNavigation('highlights'));
  target.dataset.view = 'highlights';
  document.getElementById('highlight-filter')!.addEventListener('submit', event => {
    event.preventDefault();
    const from = (document.getElementById('highlight-from') as HTMLInputElement).value;
    const to = (document.getElementById('highlight-to') as HTMLInputElement).value;
    if (from && to && from > to) { updateStatus('From must be on or before To.', true); return; }
    state.from = from; state.to = to;
    state.pageSize = Math.max(1, Math.min(50, Number((document.getElementById('highlight-size') as HTMLInputElement).value) || 14)); state.offset = 0;
    document.getElementById('highlight-range')!.textContent = from || to ? `${from || 'Any date'} – ${to || 'Now'}` : 'All dates';
    document.getElementById('highlight-page-size')!.textContent = `${state.pageSize} ${state.pageSize === 1 ? 'day' : 'days'} per page`;
    target.querySelector<HTMLDetailsElement>('.view-control')!.open = false;
    void loadHighlights();
  });
  document.getElementById('highlight-prev')!.addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.pageSize); void loadHighlights(); });
  document.getElementById('highlight-next')!.addEventListener('click', () => { state.offset += state.pageSize; void loadHighlights(); });
  document.getElementById('highlight-refresh')!.addEventListener('click', () => { void loadHighlights(); });
  target.addEventListener('wr-refresh', () => { void loadHighlights(); });
  chrome.runtime.onMessage.addListener((message: Record<string, any>) => { if (message?.type === 'BETA_SETTINGS_UPDATED' && message.settings?.theme) applyTheme(message.settings.theme); });
  void loadHighlights();
}

const root = document.querySelector<HTMLElement>('#app-root');
if (root?.dataset.view === 'highlights') {
  void sendRuntimeMessage<{ settings?: { theme?: ThemeChoice } }>({ type: 'GET_SETTINGS' }).then(response => applyTheme(response.settings?.theme || 'light')).catch(() => applyTheme('light'));
  bindSystemThemeListener(); mountHighlights(root);
}
