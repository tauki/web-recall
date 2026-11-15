import { installSharedStyles, createToolNavigation, createPageEntry, iconMarkup, icon, navigateTo, type AppView } from '../shared/presentation';
import { renderAnswer } from '../shared/answer';
import { renderSettingsPanel } from './settings/index';
import { mountManage } from '../manage/index';
import { mountHighlights } from '../highlights/index';
import { mountLogs } from '../logs/index';
import { startPolling } from '../shared/polling';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';
import { DEFAULT_SETTINGS, type BetaSettings } from '../../shared/config/index';
import { getProviderOriginInfo } from '../../shared/providerOrigin';

type SearchResult = { url: string; title: string; snippet: string; timestamp: number; score: number; hitsFromPage?: number; crossScore?: number; textMatch?: boolean };
type SavedPage = { url: string; title: string; timestamp?: number; snippet?: string };
type AskSource = { index: number; title: string; url: string; snippet: string; domain: string; evidence?: string; excerpts?: string[] };
type AskTurn = { question: string; answer: string; sources: AskSource[] };
type AskSession = { draft: string; turns: AskTurn[]; activity: string[] };
type AskController = { open: (target: HTMLElement, pages: SavedPage[] | null, title: string) => void; close: () => void; invalidate: () => void };

function formatDate(timestamp: number): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString();
  } catch {
    return '';
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatScoreLabel(result: SearchResult): string {
  const simPct = Number.isFinite(result.score) ? Math.round(((result.score + 1) / 2) * 100) : undefined;
  const llmScore = Number.isFinite(result.crossScore) ? Number(result.crossScore).toFixed(1) : undefined;
  const parts: string[] = [];
  if (result.textMatch) parts.push('Text match');
  else if (simPct !== undefined && simPct >= 0) parts.push(`sim ${simPct}%`);
  parts.push(llmScore ? `LLM ${llmScore}/10` : 'Not reranked');
  return parts.join(' · ');
}

async function initTheme(): Promise<void> {
  try {
    const response = await sendRuntimeMessage<{ settings?: { theme?: ThemeChoice } }>({ type: 'GET_SETTINGS' });
    const theme = response.settings?.theme ?? 'light';
    applyTheme(theme);
  } catch {
    applyTheme('light');
  }
  bindSystemThemeListener();
}

async function refreshRemoteProviderBanner(
  banner: HTMLElement | null,
  settingsOverride?: BetaSettings
): Promise<void> {
  if (!banner) return;
  try {
    const settings =
      settingsOverride ||
      (await sendRuntimeMessage<{ settings?: BetaSettings }>({ type: 'GET_SETTINGS' })).settings ||
      DEFAULT_SETTINGS;
    const { baseUrl = '' } = await sendRuntimeMessage<{ baseUrl?: string }>({ type: 'GET_PROVIDER_CONFIG', providerId: settings.activeProviderId });
    const info = getProviderOriginInfo(baseUrl);
    if (info.isValid && info.isRemote) {
      banner.hidden = false;
      banner.textContent = `Remote provider active (${info.origin}). Ask and retrieval context may leave this machine.`;
      return;
    }
  } catch {
    // best effort
  }
  banner.hidden = true;
  banner.textContent = '';
}

function replaceWithMessage(container: HTMLElement, message: string, tagName = 'p'): void {
  const node = document.createElement(tagName);
  node.textContent = message;
  container.replaceChildren(node);
}


function createAskView(container: HTMLElement): AskController {
  container.id = 'beta-ask-host'; container.hidden = true;
  container.innerHTML = `
    <div class="wr-ask-header"><span id="beta-ask-title">Ask your memory</span><button id="beta-ask-close" type="button" class="icon-button" aria-label="Back to preview">${iconMarkup('arrow-u-up-left')}</button></div>
    <details id="beta-source-picker"><summary class="source-picker-trigger"><span id="beta-source-label">All saved pages</span>${iconMarkup('caret-down')}</summary><div id="beta-source-options" class="wr-source-chooser"></div></details>
    <div id="beta-ask-history"></div>
    <p id="beta-ask-question" class="wr-ask-question" hidden></p>
    <div id="beta-ask-answer" class="beta-ask-answer" hidden></div>
    <div id="beta-ask-sources" class="beta-ask-sources"></div>
    <p id="beta-ask-status" class="wr-status" role="status" aria-live="polite"></p>
    <form id="beta-ask-form" class="beta-ask-form">
      <div class="wr-composer"><textarea id="beta-ask-input" placeholder="Ask a question…" aria-label="Ask a question" required></textarea><button type="submit" id="beta-ask-submit" class="icon-button" aria-label="Send question">${iconMarkup('paper-plane-right')}</button></div>
      <details class="wr-ask-options"><summary>Answer options</summary><div class="beta-ask-options"><label><input type="checkbox" id="beta-ask-use-search" checked />Search memory</label><label>Initial sources (optional)<input type="number" id="beta-ask-max-results" min="1" placeholder="Auto" /></label><p class="wr-help">Auto starts from Settings and tools can retrieve more. A page selection stays within those saved pages. With Search memory off and no selection, Ask starts from recent captures.</p></div></details>
      <div class="beta-ask-actions"><button id="beta-ask-clear" type="button" class="text-button">Clear conversation</button><button id="beta-ask-stop" type="button" class="text-button" hidden>Stop</button></div>
    </form>
    <details id="beta-ask-activity" hidden><summary>Activity <span id="beta-ask-activity-count"></span></summary><div id="beta-ask-log" class="beta-ask-log" tabindex="0" aria-label="Ask activity history"></div></details>
  `;
  const q = <T extends HTMLElement>(selector: string): T => container.querySelector<T>(selector)!;
  const form = q<HTMLFormElement>('#beta-ask-form'), input = q<HTMLTextAreaElement>('#beta-ask-input');
  const useSearch = q<HTMLInputElement>('#beta-ask-use-search'), maxResults = q<HTMLInputElement>('#beta-ask-max-results');
  const submit = q<HTMLButtonElement>('#beta-ask-submit'), stop = q<HTMLButtonElement>('#beta-ask-stop');
  const status = q('#beta-ask-status'), answerView = q('#beta-ask-answer'), sourcesView = q('#beta-ask-sources');
  const activity = q<HTMLDetailsElement>('#beta-ask-activity'), log = q('#beta-ask-log'), questionView = q('#beta-ask-question');
  const sessions = new Map<string, AskSession>();
  let key = 'memory', session: AskSession = { draft: '', turns: [], activity: [] }, pages: SavedPage[] | null = null, selected: string[] | undefined;
  let activeRequestId: string | null = null, generation = 0, entries = 0, lastLog = '';

  function setRunning(running: boolean): void {
    submit.disabled = running || !input.value.trim() || selected?.length === 0; stop.hidden = !running; input.readOnly = running;
    useSearch.disabled = Boolean(selected) || running; maxResults.disabled = running;
    form.setAttribute('aria-busy', String(running));
  }
  function setStatus(text: string, error = false): void { status.textContent = text; status.dataset.variant = error ? 'error' : 'info'; status.dataset.state = text.startsWith('Answer ready') ? 'ready' : 'active'; }
  function resetOutput(clearActivity = true): void {
    if (clearActivity) session.activity = [];
    entries = 0; lastLog = ''; log.replaceChildren(); activity.hidden = true; activity.open = false;
    answerView.replaceChildren(); answerView.hidden = true; delete answerView.dataset.streaming;
    sourcesView.replaceChildren(); questionView.hidden = true;
  }
  function appendLogRow(text: string): void {
    if (!text || text === lastLog) return;
    const row = document.createElement('div'); row.textContent = text; log.append(row); entries++; lastLog = text;
    q('#beta-ask-activity-count').textContent = `(${entries})`; activity.hidden = false;
  }
  function appendLog(text: string): void {
    if (!text || text === lastLog) return;
    session.activity.push(text);
    appendLogRow(text);
  }
  function renderSources(sources: AskSource[], target = sourcesView, prefix = 'ask-source-'): void {
    target.replaceChildren(...sources.map(source => {
      const row = createPageEntry({ url: source.url, title: `[${source.index}] ${source.title}`, snippet: source.excerpts?.join('\n\n') || source.evidence || source.snippet });
      row.article.classList.add('beta-result-card'); row.article.hidden = true; row.article.id = `${prefix}${source.index}`; row.article.tabIndex = -1;
      const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noreferrer'; link.className = 'original-link'; link.textContent = 'Open page'; row.body.append(link);
      return row.article;
    }));
  }
  function showSession(): void {
    resetOutput(false); session.activity.forEach(appendLogRow); setStatus(''); input.value = session.draft;
    const history = q('#beta-ask-history'); history.replaceChildren();
    for (const [index, turn] of session.turns.slice(0, -1).entries()) {
      const details = document.createElement('details'); details.className = 'wr-ask-options';
      const summary = document.createElement('summary'); summary.textContent = turn.question;
      const answer = document.createElement('div'); answer.className = 'beta-ask-answer'; const prefix = `ask-history-${index}-source-`; renderAnswer(answer, turn.answer, turn.sources.map(source => source.index), prefix); const references = document.createElement('div'); references.className = 'beta-ask-sources'; renderSources(turn.sources, references, prefix); details.append(summary, answer, references); history.append(details);
    }
    const latest = session.turns.at(-1);
    if (latest) { questionView.textContent = latest.question; questionView.hidden = false; renderSources(latest.sources); renderAnswer(answerView, latest.answer, latest.sources.map(source => source.index)); answerView.hidden = false; }
  }
  async function stopRequest(): Promise<void> {
    const requestId = activeRequestId;
    if (!requestId) return;
    const stoppedGeneration = generation; activeRequestId = null; setRunning(false); sourcesView.replaceChildren();
    setStatus('Stopped. Any partial answer has not been verified.'); appendLog('Answer stopped');
    try { await sendRuntimeMessage({ type: 'CANCEL_ASK', requestId }); }
    catch { if (!activeRequestId && generation === stoppedGeneration) setStatus('Stopped showing updates. The background connection was lost; the request may still finish.', true); }
  }
  function selectSession(preserveDraft = false): void {
    const draft = input.value; session.draft = draft;
    const nextKey = selected ? JSON.stringify(selected.slice().sort()) : 'memory';
    if (nextKey === key && activeRequestId) return;
    if (nextKey !== key) { void stopRequest(); generation++; }
    key = nextKey; session = sessions.get(key) || { draft: preserveDraft ? draft : '', turns: [], activity: [] }; sessions.set(key, session);
    showSession(); setRunning(false);
    q('#beta-source-label').textContent = selected ? `Using ${selected.length} ${selected.length === 1 ? 'page' : 'pages'}` : 'All saved pages';
    submit.disabled = !input.value.trim() || selected?.length === 0;
  }
  function close(): void { session.draft = input.value; void stopRequest(); container.hidden = true; window.dispatchEvent(new window.Event('wr-ask-closed')); }
  q('#beta-ask-close').addEventListener('click', close);
  stop.addEventListener('click', () => { void stopRequest(); input.focus(); });
  q('#beta-ask-clear').addEventListener('click', () => { void stopRequest(); generation++; session.turns = []; session.activity = []; session.draft = ''; input.value = ''; showSession(); setRunning(false); input.focus(); });
  input.addEventListener('input', () => { session.draft = input.value; if (!activeRequestId) submit.disabled = !input.value.trim() || selected?.length === 0; input.style.height = '28px'; input.style.height = `${Math.max(28, Math.min(160, input.scrollHeight))}px`; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (activeRequestId) return;
    const question = input.value.trim();
    if (!question) { setStatus('Enter a question to begin.'); input.focus(); return; }
    if (selected?.length === 0) { setStatus('Choose at least one page.'); return; }
    const requestId = `ask-${crypto.randomUUID()}`; generation++; activeRequestId = requestId; resetOutput(); setRunning(true); setStatus('Gathering sources…');
    questionView.textContent = question; questionView.hidden = false;
    try {
      const raw = maxResults.value.trim();
      const response = await sendRuntimeMessage<{ answer: string; sources: AskSource[] }>({ type: 'ASK_QUESTION', question, options: { useSearch: useSearch.checked, maxResults: raw ? Number(raw) : undefined, requestId, scopeUrls: selected, history: session.turns.map(turn => ({ question: turn.question, answer: turn.answer })) } });
      if (activeRequestId !== requestId) return;
      const turn = { question, answer: response.answer || 'No answer returned.', sources: response.sources || [] };
      session.turns.push(turn); session.draft = ''; showSession();
      setStatus(turn.sources.length ? `Answer ready · ${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}` : 'Answer ready · No cited sources');
    } catch (error) {
      if (activeRequestId !== requestId) return;
      const message = `Ask failed: ${error instanceof Error ? error.message : String(error)}. Try again or check Settings.`;
      setStatus(message, true); appendLog(message); if (!answerView.hidden) appendLog('The partial answer has not been verified.');
    } finally { if (activeRequestId === requestId) { activeRequestId = null; setRunning(false); } }
  });
  container.addEventListener('click', event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#ask-"]'); if (!link) return;
    const source = container.querySelector<HTMLElement>(link.getAttribute('href')!);
    if (source) { event.preventDefault(); const reveal = source.hidden; source.parentElement!.querySelectorAll<HTMLElement>(':scope > article').forEach(item => { item.hidden = true; }); source.hidden = !reveal; if (reveal) { source.querySelector<HTMLDetailsElement>('details')!.open = true; source.focus(); source.scrollIntoView({ block: 'nearest' }); } }
  });
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (!activeRequestId || message.requestId !== activeRequestId) return;
    if (message.type === 'ASK_PROGRESS') { appendLog(String(message.message || '')); setStatus(String(message.message || 'Working…')); }
    if (message.type === 'ASK_ANSWER_UPDATE') { answerView.hidden = false; answerView.dataset.streaming = 'true'; answerView.textContent = String(message.chunk || ''); }
  });
  return {
    open(target, candidates, title) {
      const next = candidates?.map(page => page.url);
      const changed = JSON.stringify(next) !== JSON.stringify(pages?.map(page => page.url));
      pages = candidates; if (changed) selected = next;
      q('#beta-ask-title').textContent = title;
      q<HTMLDetailsElement>('#beta-source-picker').hidden = !pages || pages.length <= 1;
      const options = q('#beta-source-options'); options.replaceChildren();
      for (const page of pages || []) {
        const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(selected?.includes(page.url));
        const text = document.createElement('span'); text.textContent = page.title || page.url;
        const domain = document.createElement('small'); domain.textContent = extractDomain(page.url); text.append(domain); label.append(checkbox, text); options.append(label);
        checkbox.addEventListener('change', () => { selected = (pages || []).filter(candidate => candidate.url === page.url ? checkbox.checked : selected?.includes(candidate.url)).map(candidate => candidate.url); selectSession(true); });
      }
      selectSession(); target.append(container); container.hidden = false; input.focus({ preventScroll: true }); container.scrollIntoView({ block: 'nearest' });
    },
    close,
    invalidate() { close(); sessions.clear(); session = { draft: '', turns: [], activity: [] }; resetOutput(); }
  };
}

type SearchController = { askMemory: () => void; openPage: (url: string) => Promise<void>; refresh: () => void; openQueue: () => void };
function createSearchView(container: HTMLElement, askHost: HTMLElement, ask: AskController): SearchController {
  container.innerHTML = `
    <div class="search-header">
      <div class="search-row"><form id="beta-search-form" class="search-form beta-search-form" role="search"><button type="submit" class="icon-button" aria-label="Search saved pages">${iconMarkup('magnifying-glass')}</button><input id="beta-search-input" type="search" placeholder="Search your saved pages" aria-label="Search query" autocomplete="off" /><button type="button" id="beta-search-stop" class="text-button" hidden>Stop</button><button type="button" id="beta-search-clear" class="icon-button" aria-label="Clear search" hidden>${iconMarkup('x')}</button></form></div>
      <div class="results-toolbar"><span id="beta-search-status" role="status" aria-live="polite"></span><button id="beta-ask-results" class="ask-results" hidden>Ask these pages${iconMarkup('arrow-up-right')}</button></div>
    </div>
    <div class="results-list">
      <div id="beta-results-conversation"></div>
      <div id="beta-search-results" class="beta-search-results"></div>
      <section id="beta-recents-section"><div id="beta-recents-list" class="beta-search-results"></div><button id="beta-refresh-recents" class="text-button wr-refresh-recents" hidden>Refresh</button></section>
      <button id="beta-capture-now" hidden>Capture current tab</button>
      <details id="beta-queue-section" hidden><summary><span id="beta-queue-label">Capture queue</span>${iconMarkup('caret-down')}</summary>
        <div class="button-row"><button id="beta-retry-failed" class="text-button" hidden>Retry failed</button></div>
        <div id="beta-capture-status" class="wr-help"></div>
        <section id="beta-capture-setup" hidden><h2>Choose your capture policy</h2><p class="wr-help">Capture starts paused. Choose broad capture or allow approved domains first.</p><div class="button-row"><button id="beta-enable-broad-capture" class="secondary-button">Enable broad capture</button><button id="beta-open-capture-settings" class="text-button">Set allowlist first</button></div></section>
      </details>
    </div>`;
  const q = <T extends HTMLElement>(selector: string): T => container.querySelector<T>(selector)!;
  const input = q<HTMLInputElement>('#beta-search-input'), form = q<HTMLFormElement>('#beta-search-form');
  const status = q('#beta-search-status'), resultsWrap = q('#beta-search-results'), recents = q('#beta-recents-list');
  const recentSection = q('#beta-recents-section'), clear = q<HTMLButtonElement>('#beta-search-clear'), stop = q<HTMLButtonElement>('#beta-search-stop');
  const askResults = q<HTMLButtonElement>('#beta-ask-results'), multi = q('#beta-results-conversation');
  const captureQueue = q<HTMLDetailsElement>('#beta-queue-section');
  let searchRequestId: string | null = null, generation = 0, debounce: ReturnType<typeof setTimeout> | undefined;
  let searching = false, resultPages: SearchResult[] = [], recentPages: SavedPage[] = [], currentSettings = { ...DEFAULT_SETTINGS };
  let queue: Array<{ url: string; title: string; status: string; attempts: number }> = [];
  let activeAskButton: HTMLButtonElement | null = null, multiAsk = false;
  function setStatus(text: string, error = false): void { status.textContent = text; status.dataset.variant = error ? 'error' : 'info'; status.dataset.state = text.startsWith('Answer ready') ? 'ready' : 'active'; }
  function candidates(): SavedPage[] { return searching ? resultPages : recentPages.slice(0, 20); }
  function sync(): void { recentSection.hidden = searching; clear.hidden = !input.value; askResults.hidden = !candidates().length || multiAsk; askResults.disabled = Boolean(searchRequestId); q('.results-toolbar').hidden = !status.textContent && askResults.hidden; }
  function syncQueue(): void {
    captureQueue.hidden = queue.length === 0 && !captureQueue.open;
    const failed = queue.filter(item => item.status === 'failed').length;
    q('#beta-queue-label').textContent = queue.length ? `${queue.length} capture${queue.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ' in progress'}` : 'Capture queue';
    q('#beta-retry-failed').hidden = !failed;
  }
  captureQueue.addEventListener('toggle', syncQueue);
  function cancelSearch(): void { const id = searchRequestId; searchRequestId = null; stop.hidden = true; if (id) void sendRuntimeMessage({ type: 'CANCEL_SEARCH', requestId: id }).catch(error => console.warn('Unable to cancel search', error)); }
  function closeAsk(): void { ask.close(); multiAsk = false; if (activeAskButton) activeAskButton.hidden = false; activeAskButton = null; sync(); }
  window.addEventListener('wr-ask-closed', () => { multiAsk = false; if (activeAskButton) activeAskButton.hidden = false; activeAskButton = null; sync(); });
  function row(page: SavedPage, result?: SearchResult): HTMLElement {
    const entry = createPageEntry(page); entry.article.classList.add('beta-result-card'); entry.details.name = 'search-preview';
    if (page.snippet) { const snippet = document.createElement('span'); snippet.className = 'result-snippet'; snippet.textContent = page.snippet.replace(/\s+/g, ' ').trim(); entry.summary.append(snippet); }
    const passage = page.snippet ? entry.body.querySelector('p')! : document.createElement('p');
    if (!page.snippet) entry.body.append(passage);
    const actions = document.createElement('div'); actions.className = 'preview-actions';
    const original = document.createElement('a'); original.href = page.url; original.target = '_blank'; original.rel = 'noreferrer'; original.className = 'open-page-button'; original.append(icon('arrow-up-right'), document.createTextNode('Open page'));
    const button = document.createElement('button'); button.className = 'ask-this-page'; button.append(icon('chat-circle'), document.createTextNode('Ask about this'));
    button.addEventListener('click', () => { if (activeAskButton) activeAskButton.hidden = false; activeAskButton = button; button.hidden = true; multiAsk = false; ask.open(entry.body, [page], 'Ask about this page'); sync(); });
    actions.append(original, button); entry.body.append(actions);
    if (result) { const details = document.createElement('details'); details.className = 'wr-match-details'; const summary = document.createElement('summary'); summary.append(document.createTextNode('Match details'), icon('caret-down')); const copy = document.createElement('p'); copy.textContent = [formatScoreLabel(result), result.hitsFromPage ? `${result.hitsFromPage} matches` : '', formatDate(result.timestamp)].filter(Boolean).join(' · '); details.append(summary, copy); entry.body.append(details); }
    entry.summary.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const summaries = Array.from(container.querySelectorAll<HTMLElement>(searching ? '#beta-search-results > article > details > summary' : '#beta-recents-list > article > details > summary'));
      const index = summaries.indexOf(entry.summary); event.preventDefault();
      if (event.key === 'ArrowUp' && index === 0) input.focus(); else summaries[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    });
    let loaded = Boolean(page.snippet);
    entry.details.addEventListener('toggle', () => {
      if (!entry.details.open) { if (entry.body.contains(askHost)) closeAsk(); return; }
      if (loaded) return;
      loaded = true; passage.textContent = 'Loading saved passage…';
      void sendRuntimeMessage<{ page: SavedPage | null }>({ type: 'GET_PAGE_PREVIEW', url: page.url }).then(response => { passage.textContent = response.page?.snippet || 'No captured text is available for this page.'; }).catch(error => { loaded = false; passage.textContent = `Preview unavailable: ${(error instanceof Error ? error.message : String(error))}`; });
    });
    return entry.article;
  }
  function resetSearch(): void { clearTimeout(debounce); generation++; cancelSearch(); closeAsk(); searching = false; input.value = ''; resultPages = []; resultsWrap.replaceChildren(); setStatus(recentPages.length ? `${recentPages.length} ${recentPages.length === 1 ? 'page' : 'pages'}` : ''); sync(); }
  function renderResults(results: SearchResult[]): void {
    resultPages = results; resultsWrap.replaceChildren(...results.map(page => row(page, page)));
    if (!results.length) replaceWithMessage(resultsWrap, 'No matching pages. Try another search or capture a page.');
    sync();
  }
  async function refreshRecents(force = false): Promise<void> {
    try {
      const response = await sendRuntimeMessage<{ pages: SavedPage[] }>({ type: 'GET_PAGE_LIST' });
      const incoming = (response.pages || []).slice(0, 20);
      if (recents.querySelector('details[open]') && recents.children.length) { if (!force) return; closeAsk(); }
      if (JSON.stringify(incoming) !== JSON.stringify(recentPages) || !recents.children.length) {
        recentPages = incoming; recents.replaceChildren(...recentPages.map(page => row(page)));
        if (!recentPages.length) {
          const empty = document.createElement('div'); empty.className = 'wr-empty-memory';
          const title = document.createElement('p'); title.textContent = 'No saved pages yet.';
          const note = document.createElement('p'); note.className = 'wr-help'; note.textContent = 'Start with the page you’re browsing.';
          const capture = document.createElement('button'); capture.className = 'primary-button'; capture.textContent = 'Capture current tab'; capture.addEventListener('click', () => q('#beta-capture-now').click());
          const settings = document.createElement('button'); settings.className = 'text-button'; settings.textContent = 'Capture settings'; settings.addEventListener('click', () => navigateTo('settings', 'capture'));
          const actions = document.createElement('div'); actions.className = 'button-row'; actions.append(capture, settings); empty.append(title, note, actions); recents.append(empty);
        }
      }
      if (!searching && !searchRequestId) setStatus(recentPages.length ? `${recentPages.length} ${recentPages.length === 1 ? 'page' : 'pages'}` : '');
      sync();
    } catch (error) { if (!searching) setStatus(`Unable to load pages: ${error instanceof Error ? error.message : String(error)}`, true); }
  }
  async function refreshQueue(): Promise<void> {
    try {
      const response = await sendRuntimeMessage<{ queue: typeof queue }>({ type: 'GET_PROCESSING' }); queue = response.queue || [];
      syncQueue();
      const view = q('#beta-capture-status'); view.replaceChildren();
      if (!queue.length) view.textContent = 'No pending captures.';
      else {
        const list = document.createElement('ul');
        for (const item of queue.slice(0, 5)) {
          const li = document.createElement('li'), copy = document.createElement('span'); copy.textContent = `${item.title || item.url} · ${item.status} · ${item.attempts} attempts`;
          const retry = document.createElement('button'); retry.className = 'text-button'; retry.textContent = 'Retry'; retry.disabled = item.status !== 'failed'; retry.addEventListener('click', () => { void action({ type: 'RETRY_PROCESSING', url: item.url }, 'Retry queued'); }); li.append(copy, retry); list.append(li);
        }
        view.append(list);
      }
    } catch (error) { q('#beta-capture-status').textContent = `Status unavailable: ${(error instanceof Error ? error.message : String(error))}`; }
  }
  async function action(message: Record<string, unknown>, success: string): Promise<void> {
    try { await sendRuntimeMessage(message); setStatus(success); void refreshQueue(); void refreshRecents(); }
    catch (error) { setStatus(`Request failed: ${error instanceof Error ? error.message : String(error)}`, true); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); clearTimeout(debounce);
    const query = input.value.trim(); if (!query) { resetSearch(); return; }
    closeAsk(); cancelSearch();
    const requestId = crypto.randomUUID(), current = ++generation; searchRequestId = requestId; searching = true; stop.hidden = false;
    resultPages = []; resultsWrap.replaceChildren(); setStatus('Searching…'); sync();
    try {
      const response = await sendRuntimeMessage<{ results: SearchResult[] }>({ type: 'SEARCH_QUERY', requestId, query, limit: 20 });
      if (current !== generation) return;
      renderResults(response.results || []); setStatus(`${resultPages.length} ${resultPages.length === 1 ? 'page' : 'pages'}`);
    } catch (error) { if (current === generation) { renderResults([]); setStatus(`Search failed: ${error instanceof Error ? error.message : String(error)}`, true); } }
    finally { if (searchRequestId === requestId) { searchRequestId = null; stop.hidden = true; sync(); } }
  });
  input.addEventListener('input', () => { clearTimeout(debounce); generation++; cancelSearch(); closeAsk(); clear.hidden = !input.value; if (!input.value) resetSearch(); else { searching = true; resultPages = []; resultsWrap.replaceChildren(); setStatus('Searching…'); sync(); debounce = setTimeout(() => form.requestSubmit(), 450); } });
  input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); container.querySelector<HTMLElement>(searching ? '#beta-search-results > article > details > summary' : '#beta-recents-list > article > details > summary')?.focus(); } });
  clear.addEventListener('click', () => { resetSearch(); input.focus(); });
  stop.addEventListener('click', () => { generation++; cancelSearch(); setStatus('Stopped.'); sync(); });
  askResults.addEventListener('click', () => { multiAsk = true; if (activeAskButton) activeAskButton.hidden = false; activeAskButton = null; ask.open(multi, candidates(), 'Ask your results'); sync(); });
  q('#beta-capture-now').addEventListener('click', () => { void action({ type: 'CAPTURE_ACTIVE_TAB' }, 'Capture requested'); });
  q('#beta-retry-failed').addEventListener('click', () => { void action({ type: 'RETRY_FAILED_CAPTURES' }, 'Retry requested'); });
  q('#beta-refresh-recents').addEventListener('click', () => { if (input.value.trim()) form.requestSubmit(); else void refreshRecents(true); });
  q('#beta-enable-broad-capture').addEventListener('click', () => { void action({ type: 'SET_SETTINGS', payload: { paused: false, captureSetupComplete: true } }, 'Broad capture enabled'); });
  q('#beta-open-capture-settings').addEventListener('click', () => { navigateTo('settings', 'capture'); });
  function applySettings(settings: BetaSettings): void { currentSettings = settings; q('#beta-capture-setup').hidden = currentSettings.captureSetupComplete; }
  void sendRuntimeMessage<{ settings: BetaSettings }>({ type: 'GET_SETTINGS' }).then(response => applySettings(response.settings || DEFAULT_SETTINGS)).catch(() => {});
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message.type === 'CAPTURE_QUEUE_UPDATED') void refreshQueue();
    if (message.type === 'BETA_SETTINGS_UPDATED' && message.settings) applySettings(message.settings as BetaSettings);
  });
  window.addEventListener('wr-memory-changed', () => { ask.invalidate(); generation++; cancelSearch(); if (searching) form.requestSubmit(); else { recents.replaceChildren(); void refreshRecents(); } });
  startPolling(() => { if (container.hidden) return; void refreshQueue(); void refreshRecents(); void refreshRemoteProviderBanner(document.querySelector('#beta-remote-provider-banner')); }, 5000);
  return {
    openQueue() { captureQueue.hidden = false; captureQueue.open = true; void refreshQueue(); captureQueue.querySelector<HTMLElement>('summary')!.focus(); captureQueue.scrollIntoView({ block: 'nearest' }); },
    askMemory() { multiAsk = true; ask.open(multi, null, 'Ask your memory'); sync(); },
    async openPage(url) {
      closeAsk(); const current = ++generation; cancelSearch();
      try {
        const response = await sendRuntimeMessage<{ page: SavedPage | null }>({ type: 'GET_PAGE_PREVIEW', url });
        if (current !== generation) return;
        if (!response.page) { setStatus('This page is no longer saved.', true); return; }
        input.value = response.page.title; searching = true;
        resultPages = [{ ...response.page, timestamp: response.page.timestamp || 0, snippet: response.page.snippet || '', score: 0 }];
        resultsWrap.replaceChildren(row(response.page)); resultsWrap.querySelector<HTMLDetailsElement>('details')!.open = true; setStatus('1 page'); sync();
        resultsWrap.querySelector<HTMLElement>('summary')!.focus({ preventScroll: true });
      } catch (error) { if (current !== generation) return; setStatus(`Unable to open saved page: ${(error instanceof Error ? error.message : String(error))}`, true); }
    },
    refresh() { void refreshRecents(); void refreshQueue(); }
  };
}

function renderApp(root: HTMLElement): void {
  installSharedStyles(); root.dataset.view = 'sidepanel';
  root.innerHTML = `<div class="beta-sidepanel-shell"><div id="beta-remote-provider-banner" class="wr-remote-notice" hidden></div><section id="beta-view-search" aria-label="Search & Ask"></section><section id="beta-view-settings" aria-label="Settings" hidden></section><section id="beta-view-manage" aria-label="Memory Manager" hidden></section><section id="beta-view-highlights" aria-label="Daily Highlights" hidden></section><section id="beta-view-logs" aria-label="Structured Logs" hidden></section></div>`;
  const navigation = createToolNavigation('sidepanel');
  const menuAnchor = navigation.querySelector<HTMLDetailsElement>('.menu-anchor')!;
  const askHost = document.createElement('section'), ask = createAskView(askHost);
  const search = createSearchView(root.querySelector('#beta-view-search')!, askHost, ask);
  const settings = root.querySelector<HTMLElement>('#beta-view-settings')!; renderSettingsPanel(settings);
  root.querySelector('.search-row')!.append(menuAnchor);
  const mounted = new Set<AppView>(['sidepanel', 'settings']);
  let active: AppView = 'sidepanel';
  function show(view: AppView, detail?: string): void {
    active = view;
    root.querySelectorAll<HTMLElement>('.beta-sidepanel-shell > section').forEach(section => { section.hidden = section.id !== `beta-view-${view === 'sidepanel' ? 'search' : view}`; });
    const target = root.querySelector<HTMLElement>(`#beta-view-${view === 'sidepanel' ? 'search' : view}`)!;
    if (!mounted.has(view)) { mounted.add(view); if (view === 'manage') mountManage(target); if (view === 'highlights') mountHighlights(target); if (view === 'logs') mountLogs(target); }
    else target.dispatchEvent(new window.Event('wr-refresh'));
    if (view === 'sidepanel') target.querySelector('.search-row')!.append(menuAnchor);
    else {
      const back = target.querySelector<HTMLElement>('.utility-back')!;
      let row = target.querySelector<HTMLElement>('.wr-utility-navigation');
      if (!row) { row = document.createElement('div'); row.className = 'wr-utility-navigation'; back.replaceWith(row); row.append(back); }
      row.append(menuAnchor);
      const heading = target.querySelector<HTMLElement>('h1')!; heading.tabIndex = -1; heading.focus({ preventScroll: true });
    }
    menuAnchor.querySelectorAll('a[data-view]').forEach(link => { if ((link as HTMLElement).dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
    if (view === 'settings' && detail) {
      const group = settings.querySelector<HTMLDetailsElement>(`#settings-${detail === 'logging' ? 'advanced' : detail}`); if (group) group.open = true;
      const logging = settings.querySelector<HTMLDetailsElement>('#settings-logging'); if (detail === 'logging' && logging) { logging.open = true; logging.querySelector<HTMLElement>('summary')?.focus(); }
    }
    if (view === 'sidepanel') { search.refresh(); if (detail) void search.openPage(detail); else target.querySelector<HTMLInputElement>('#beta-search-input')!.focus({ preventScroll: true }); }
    window.scrollTo?.({ top: 0 });
  }
  window.addEventListener('wr-navigate', event => { const { view, url } = (event as CustomEvent<{ view: AppView; url?: string }>).detail; show(view, url); });
  const menu = menuAnchor.querySelector('nav')!;
  const askMemory = document.createElement('button'); askMemory.id = 'beta-ask-memory'; askMemory.append(icon('chat-circle'), document.createTextNode('Ask your memory')); askMemory.addEventListener('click', () => { menuAnchor.open = false; show('sidepanel'); search.askMemory(); }); menu.append(askMemory);
  const capture = document.createElement('button'); capture.append(icon('file-text'), document.createTextNode('Capture current tab')); capture.addEventListener('click', () => { menuAnchor.open = false; show('sidepanel'); root.querySelector<HTMLButtonElement>('#beta-capture-now')!.click(); }); menu.append(capture);
  for (const [label, id] of [['Capture queue', 'beta-queue-section'], ['Refresh pages', 'beta-refresh-recents']]) {
    const button = document.createElement('button'); button.textContent = label!;
    button.addEventListener('click', () => { menuAnchor.open = false; show('sidepanel'); if (id === 'beta-queue-section') search.openQueue(); else document.getElementById(id!)!.click(); }); menu.append(button);
  }
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); show('sidepanel'); root.querySelector<HTMLInputElement>('#beta-search-input')!.focus(); }
    if (event.key === 'Escape') {
      if (active !== 'sidepanel') show('sidepanel');
      else {
        const picker = askHost.querySelector<HTMLDetailsElement>('#beta-source-picker');
        if (picker?.open) { picker.open = false; picker.querySelector<HTMLElement>('summary')!.focus(); }
        else if (!askHost.hidden) ask.close();
        else { const preview = root.querySelector<HTMLDetailsElement>('details[name=search-preview][open]'); if (preview) { preview.open = false; preview.querySelector<HTMLElement>('summary')!.focus(); } else root.querySelector<HTMLInputElement>('#beta-search-input')!.focus(); }
      }
    }
  });
  if (window.location.hash.startsWith('#settings')) show('settings', window.location.hash === '#settings-logging' ? 'logging' : window.location.hash === '#settings-advanced' ? 'advanced' : undefined);
  else if (window.location.hash.startsWith('#page=')) void search.openPage(decodeURIComponent(window.location.hash.slice(6)));
  void refreshRemoteProviderBanner(root.querySelector('#beta-remote-provider-banner'));
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => { if (message.type === 'BETA_SETTINGS_UPDATED') { const settings = message.settings as BetaSettings; if (settings?.theme) applyTheme(settings.theme); void refreshRemoteProviderBanner(root.querySelector('#beta-remote-provider-banner'), settings); } });
}

const root = document.querySelector<HTMLElement>('#app-root');
if (root) void initTheme().then(() => renderApp(root));
