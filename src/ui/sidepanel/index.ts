import { installSharedStyles, createToolNavigation, createPageEntry, createStorageSettingsLink, isMissingLibraryError, iconMarkup, icon, navigateTo, type AppView } from '../shared/presentation';
import { renderAnswer } from '../shared/answer';
import { renderSettingsPanel } from './settings/index';
import { mountManage } from '../manage/index';
import { mountHighlights } from '../highlights/index';
import { mountLogs } from '../logs/index';
import { startPolling } from '../shared/polling';
import { sendRuntimeMessage } from '../shared/runtime';
import { applyTheme, restoreCachedTheme, bindSystemThemeListener, type ThemeChoice } from '../shared/theme';
import { CHAT_PROVIDER_DISABLED, DEFAULT_SETTINGS, type BetaSettings } from '../../shared/config/index';
import { captureStatusText } from '../../shared/captureStatus';
import { captureNotice } from '../shared/captureNotice';
import type { CaptureInfo } from '../../shared/capture';
import { getProviderOriginInfo } from '../../shared/providerOrigin';
import type { ConversationState } from '../../shared/ask';
import { AppleSafetyBlockError } from '../../shared/providerErrors';
import { RECENTS_CACHE_KEY, readRecentPages, readRecentCursor, type RecentCursor, type RecentPageBatch } from '../../shared/recents';
import { readCaptureDateRange, readSearchFilters, type SearchFilters } from '../../shared/searchFilters';
import { createSavedReader } from '../shared/savedReader';

type SearchResult = { url: string; title: string; snippet: string; timestamp: number; score: number; hitsFromPage?: number; crossScore?: number; textMatch?: boolean; chunkIndex?: number; versionId?: string };
type SavedPage = { url: string; title: string; timestamp?: number; snippet?: string; previewKind?: 'summary' | 'excerpt'; versionId?: string; captureInfo?: CaptureInfo };
type AskSource = { index: number; title: string; url: string; snippet: string; domain: string; evidence?: string; excerpts?: string[] };
type AskTurn = { question: string; answer: string; sources: AskSource[]; outcome?: 'answered' | 'insufficient_evidence' | 'failed' };
type AskSession = { draft: string; turns: AskTurn[]; activity: string[]; conversation?: ConversationState };
type AskController = { open: (target: HTMLElement, pages: SavedPage[] | null, title: string) => void; setAutomaticAi: (enabled: boolean) => void; close: () => void; invalidate: () => void; dispose: () => void };

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
    restoreCachedTheme();
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
    if (settings.activeProviderId === CHAT_PROVIDER_DISABLED) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    if (settings.activeProviderId === 'apple' && settings.applePrivateCloud) {
      banner.hidden = false;
      banner.textContent = 'Apple Private Cloud Compute is selected. Prompts and selected saved passages are sent to Apple servers.';
      return;
    }
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


function createAskView(container: HTMLElement, onState?: (state: string) => void): AskController {
  container.id = 'beta-ask-host'; container.hidden = true;
  container.innerHTML = `
    <div class="wr-ask-header"><span id="beta-ask-title">Ask your memory</span><button id="beta-ask-close" type="button" class="icon-button" aria-label="Back to preview">${iconMarkup('arrow-u-up-left')}</button></div>
    <p class="wr-help wr-ask-ai-note" hidden>Automatic AI is off. Ask still needs a chat model.</p>
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
    if (running) onState?.('Answering…');
    submit.disabled = running || !input.value.trim() || selected?.length === 0; stop.hidden = !running; input.readOnly = running;
    useSearch.disabled = Boolean(selected) || running; maxResults.disabled = running;
    form.setAttribute('aria-busy', String(running));
  }
  function setStatus(text: string, error = false, state = error ? 'failed' : 'active'): void { status.textContent = text; status.dataset.variant = error ? 'error' : 'info'; status.dataset.state = state; if (state !== 'active') onState?.(state === 'ready' ? 'Answer ready' : state === 'insufficient_evidence' ? 'Not enough evidence' : state === 'cancelled' ? 'Stopped' : 'Ask failed'); }
  function resetOutput(clearActivity = true): void {
    if (clearActivity) session.activity = [];
    entries = 0; lastLog = ''; log.replaceChildren(); activity.hidden = true; activity.open = false;
    answerView.replaceChildren(); answerView.hidden = true; delete answerView.dataset.streaming;
    sourcesView.replaceChildren(); questionView.hidden = true;
  }
  function appendLogRow(text: string, force = false): void {
    if (!text || (!force && text === lastLog)) return;
    const row = document.createElement('div'); row.textContent = text; log.append(row); entries++; lastLog = text;
    q('#beta-ask-activity-count').textContent = `(${entries})`; activity.hidden = false;
  }
  function appendLog(text: string, force = false): void {
    if (!text || (!force && text === lastLog)) return;
    session.activity.push(text);
    appendLogRow(text, force);
  }
  function renderSources(sources: AskSource[], target = sourcesView, prefix = 'ask-source-', retrievedOnly = false): void {
    target.replaceChildren(...sources.map(source => {
      const row = createPageEntry({ url: source.url, title: `[${source.index}] ${source.title}`, snippet: source.excerpts?.join('\n\n') || source.evidence || source.snippet });
      row.article.classList.add('beta-result-card'); row.article.hidden = !retrievedOnly; row.article.id = `${prefix}${source.index}`; row.article.tabIndex = -1;
      const link = document.createElement('a'); link.href = source.url; link.target = '_blank'; link.rel = 'noreferrer'; link.className = 'original-link'; link.textContent = 'Open page'; row.body.append(link);
      return row.article;
    }));
    if (retrievedOnly && sources.length) { const label = document.createElement('p'); label.className = 'wr-help'; label.textContent = 'Retrieved pages · not a verified answer'; target.prepend(label); }
  }
  function renderHistory(turns: AskTurn[]): void {
    const history = q('#beta-ask-history'); history.replaceChildren();
    for (const [index, turn] of turns.entries()) {
      const details = document.createElement('details'); details.className = 'wr-ask-turn'; details.open = true;
      const summary = document.createElement('summary'); summary.className = 'wr-ask-question'; summary.textContent = turn.question;
      const answer = document.createElement('div'); answer.className = 'beta-ask-answer'; const prefix = `ask-history-${index}-source-`; renderAnswer(answer, turn.answer, turn.sources.map(source => source.index), prefix); const references = document.createElement('div'); references.className = 'beta-ask-sources'; renderSources(turn.sources, references, prefix, turn.outcome === 'failed'); details.append(summary, answer, references); history.append(details);
    }
  }
  function showSession(): void {
    resetOutput(false); session.activity.forEach(text => appendLogRow(text, true)); setStatus(''); input.value = session.draft;
    renderHistory(session.turns.slice(0, -1));
    const latest = session.turns.at(-1);
    if (latest) { questionView.textContent = latest.question; questionView.hidden = false; renderSources(latest.sources, sourcesView, 'ask-source-', latest.outcome === 'failed'); renderAnswer(answerView, latest.answer, latest.sources.map(source => source.index)); answerView.hidden = false; }
  }
  async function stopRequest(): Promise<void> {
    const requestId = activeRequestId;
    if (!requestId) return;
    const stoppedGeneration = generation; activeRequestId = null; setRunning(false); sourcesView.replaceChildren();
    setStatus('Stopped. Any partial answer has not been verified.', false, 'cancelled'); appendLog('Answer stopped');
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
  function close(): void { session.draft = input.value; container.hidden = true; container.remove(); window.dispatchEvent(new window.Event('wr-ask-closed')); }
  q('#beta-ask-close').addEventListener('click', close);
  stop.addEventListener('click', () => { void stopRequest(); input.focus(); });
  q('#beta-ask-clear').addEventListener('click', () => { void stopRequest(); generation++; session.turns = []; session.activity = []; session.draft = ''; session.conversation = undefined; input.value = ''; showSession(); setRunning(false); input.focus(); });
  input.addEventListener('input', () => { session.draft = input.value; if (!activeRequestId) submit.disabled = !input.value.trim() || selected?.length === 0; input.style.height = '28px'; input.style.height = `${Math.max(28, Math.min(160, input.scrollHeight))}px`; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (activeRequestId || container.hidden) return;
    const question = input.value.trim();
    if (!question) { setStatus('Enter a question to begin.'); input.focus(); return; }
    if (selected?.length === 0) { setStatus('Choose at least one page.'); return; }
    const requestId = `ask-${crypto.randomUUID()}`; generation++; activeRequestId = requestId;
    renderHistory(session.turns); resetOutput(); input.value = ''; session.draft = ''; input.style.height = '28px';
    setRunning(true); setStatus('Gathering sources…');
    questionView.textContent = question; questionView.hidden = false;
    try {
      const raw = maxResults.value.trim();
      const response = await sendRuntimeMessage<{ answer: string; sources: AskSource[]; outcome?: AskTurn['outcome']; conversation?: ConversationState }>({ type: 'ASK_QUESTION', question, options: { useSearch: useSearch.checked, maxResults: raw ? Number(raw) : undefined, requestId, scopeUrls: selected, conversation: session.conversation, history: session.conversation ? undefined : session.turns.filter(turn => turn.outcome !== 'failed').map(turn => ({ question: turn.question, answer: turn.answer })) } });
      if (activeRequestId !== requestId) return;
      session.conversation = response.conversation;
      const turn = { question, answer: response.answer || 'No answer returned.', sources: response.sources || [], outcome: response.outcome };
      session.turns.push(turn); session.draft = turn.outcome === 'failed' ? question : ''; showSession();
      setStatus(turn.outcome === 'failed' ? 'No verified AI answer. Retrieved pages remain available.' : turn.outcome === 'insufficient_evidence' ? 'Not enough saved evidence.' : turn.sources.length ? `Answer ready · ${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}` : 'Answer ready · No cited sources', turn.outcome === 'failed', turn.outcome === 'failed' || turn.outcome === 'insufficient_evidence' ? turn.outcome : 'ready');
    } catch (error) {
      if (activeRequestId !== requestId) return;
      const message = error instanceof AppleSafetyBlockError ? error.message : `Ask failed: ${error instanceof Error ? error.message : String(error)}. Try again or check Settings.`;
      session.draft = question; input.value = question;
      setStatus(message, true); appendLog(message); if (!answerView.hidden) appendLog('The partial answer has not been verified.');
    } finally { if (activeRequestId === requestId) { activeRequestId = null; setRunning(false); } }
  });
  container.addEventListener('click', event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#ask-"]'); if (!link) return;
    const source = container.querySelector<HTMLElement>(link.getAttribute('href')!);
    if (source) { event.preventDefault(); const reveal = source.hidden; source.parentElement!.querySelectorAll<HTMLElement>(':scope > article').forEach(item => { item.hidden = true; }); source.hidden = !reveal; if (reveal) { source.querySelector<HTMLDetailsElement>('details')!.open = true; source.focus(); source.scrollIntoView({ block: 'nearest' }); } }
  });
  const receive = (message: Record<string, unknown>): void => {
    if (!activeRequestId || message.requestId !== activeRequestId) return;
    if (message.type === 'ASK_PROGRESS') { appendLog(String(message.message || '')); setStatus(String(message.message || 'Working…')); }
    if (message.type === 'ASK_ANSWER_UPDATE') { answerView.hidden = false; answerView.dataset.streaming = 'true'; answerView.textContent = String(message.chunk || ''); }
    if (message.type === 'ASK_TOOL_ACTIVITY') {
      const event = message.event as { callId: string; tool: string; status: string; ms?: number; error?: string };
      if (!event?.callId) return;
      const existing = [...log.children].find(row => (row as HTMLElement).dataset.callId === event.callId) as HTMLElement | undefined;
      const text = `${event.tool.replaceAll('_', ' ')} · ${event.status}${event.ms !== undefined ? ` · ${event.ms}ms` : ''}${event.error ? ` · ${event.error}` : ''}`;
      if (existing) { existing.textContent = text; session.activity[Number(existing.dataset.activityIndex)] = text; }
      else { appendLog(text, true); const row = log.lastElementChild as HTMLElement; row.dataset.callId = event.callId; row.dataset.activityIndex = String(session.activity.length - 1); }
    }
    if (message.type === 'ASK_RUN_STATE') {
      const event = message.event as { phase?: string };
      if (event?.phase) container.dataset.phase = event.phase;
    }
  };
  chrome.runtime.onMessage.addListener(receive);
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
    setAutomaticAi(enabled) { q('.wr-ask-ai-note').hidden = enabled !== false; },
    close,
    invalidate() { void stopRequest(); generation++; close(); sessions.clear(); pages = null; selected = undefined; key = 'memory'; session = { draft: '', turns: [], activity: [] }; resetOutput(); onState?.(''); },
    dispose() { this.invalidate(); chrome.runtime.onMessage.removeListener(receive); }
  };
}

type SearchController = { askMemory: () => void; openPage: (url: string, mode?: 'history') => Promise<void>; refresh: () => void; openQueue: () => void; capturePaused: () => boolean; toggleCapture: () => void; excludeSite: () => void };
function createSearchView(container: HTMLElement, askHost: HTMLElement, ask: AskController): SearchController {
  const itemChats = new Map<string, { host: HTMLElement; controller: AskController; badge: HTMLElement; state: string }>();
  let activeChat = ask, activeHost = askHost;
  container.innerHTML = `
    <div class="search-header">
      <div class="search-row"><form id="beta-search-form" class="search-form beta-search-form" role="search"><button type="submit" class="icon-button" aria-label="Search saved pages">${iconMarkup('magnifying-glass')}</button><input id="beta-search-input" type="search" placeholder="Search your saved pages" aria-label="Search query" autocomplete="off" /><button type="button" id="beta-search-stop" class="text-button" hidden>Stop</button><button type="button" id="beta-search-clear" class="icon-button" aria-label="Clear search" hidden>${iconMarkup('x')}</button></form></div>
      <details class="search-filters" id="beta-search-filters"><summary>Filters</summary><form id="beta-search-filter-form"><label class="compact-setting"><span>Site</span><input id="beta-filter-domain" type="text" placeholder="example.com" aria-label="Filter by site" /></label><label class="compact-setting"><span>Captured from</span><input id="beta-filter-from" type="date" aria-label="Captured from" /></label><label class="compact-setting"><span>Through</span><input id="beta-filter-to" type="date" aria-label="Captured through" /></label><div class="button-row"><button type="submit" class="secondary-button">Apply filters</button><button id="beta-filter-clear" type="button" class="text-button">Clear filters</button></div></form></details>
      <div class="results-toolbar"><span id="beta-search-status" role="status" aria-live="polite"></span><button id="beta-ask-results" class="ask-results" hidden>Ask these pages${iconMarkup('arrow-up-right')}</button></div>
      <div id="beta-library-recovery" hidden></div>
    </div>
    <div class="results-list">
      <section id="beta-recall-setup" class="wr-recall-guide" hidden><h2 id="beta-recall-heading"></h2><p id="beta-recall-help" class="wr-help"></p><div class="button-row"><button id="beta-recall-next" class="secondary-button" type="button"></button><button id="beta-recall-skip" class="text-button" type="button">Skip guide</button></div></section>
      <section id="beta-optional-ai" class="wr-recall-guide" hidden><h2>Add AI when you want it</h2><p class="wr-help">Optional models add summaries, search by meaning and Ask. Your saved pages already work without them.</p><div class="button-row"><button id="beta-setup-ai" type="button" class="secondary-button">Set up AI (optional)</button><button id="beta-ai-not-now" type="button" class="text-button">Not now</button></div></section>
      <div id="beta-results-conversation"></div>
      <div id="beta-search-results" class="beta-search-results"></div>
      <section id="beta-recents-section"><div id="beta-recents-list" class="beta-search-results"></div><button id="beta-load-more-recents" class="text-button" hidden>Load more</button><button id="beta-refresh-recents" class="text-button wr-refresh-recents" hidden>Refresh</button></section>
      <button id="beta-capture-now" hidden>Capture current tab</button>
      <section id="beta-capture-setup" hidden><h2>Choose how to save pages</h2><p class="wr-help">Capture starts paused. Save manually, automatically save selected sites, or enable broader capture. Excluded sites are never saved.</p><div class="button-row"><button id="beta-keep-manual-capture" class="secondary-button">Manual only</button><button id="beta-open-capture-settings" class="text-button">Selected sites</button><button id="beta-enable-broad-capture" class="text-button">Enable broad capture</button></div></section>
      <details id="beta-queue-section" hidden><summary><span id="beta-queue-label">Capture queue</span>${iconMarkup('caret-down')}</summary>
        <div class="button-row"><button id="beta-retry-failed" class="text-button" hidden>Retry failed</button></div>
        <div id="beta-capture-status" class="wr-help"></div>
      </details>
    </div>`;
  const q = <T extends HTMLElement>(selector: string): T => container.querySelector<T>(selector)!;
  const input = q<HTMLInputElement>('#beta-search-input'), form = q<HTMLFormElement>('#beta-search-form');
  const status = q('#beta-search-status'), toolbar = q('.results-toolbar'), resultsWrap = q('#beta-search-results'), recents = q('#beta-recents-list');
  const recovery = q('#beta-library-recovery');
  recovery.append(createStorageSettingsLink('restore', 'Restore from backup'));
  const recentSection = q('#beta-recents-section'), clear = q<HTMLButtonElement>('#beta-search-clear'), stop = q<HTMLButtonElement>('#beta-search-stop');
  const askResults = q<HTMLButtonElement>('#beta-ask-results'), multi = q('#beta-results-conversation');
  const captureQueue = q<HTMLDetailsElement>('#beta-queue-section');
  let searchRequestId: string | null = null, generation = 0, debounce: ReturnType<typeof setTimeout> | undefined;
  let filters: SearchFilters = {};
  const filterForm = q<HTMLFormElement>('#beta-search-filter-form');
  let searching = false, resultPages: SearchResult[] = [], recentPages: SavedPage[] = [], currentSettings = { ...DEFAULT_SETTINGS };
  const loadMore = q<HTMLButtonElement>('#beta-load-more-recents');
  let recentRevision = 0, allowCachedRecents = true, recentError = '';
  let nextRecentCursor: RecentCursor | null = null, loadingMore = false, loadedMore = false;
  let queue: Array<{ url: string; title: string; status: string; attempts: number; error?: string; textSaved?: boolean }> = [];
  let activeAskButton: HTMLButtonElement | null = null, multiAsk = false;
  let actionFeedback: symbol | undefined;
  let settingsLoaded = false, finishingRecall = false, showAiIntroduction = false;
  function syncRecallGuide(): void {
    const unfinished = settingsLoaded && !currentSettings.recallSetupComplete;
    const guide = q('#beta-recall-setup'); guide.hidden = !unfinished || !recentPages.length;
    const reading = searching && resultPages.length > 0;
    q('#beta-recall-heading').textContent = reading ? 'Read what you saved' : 'Find your saved page';
    q('#beta-recall-help').textContent = reading ? 'Read the saved text, even if the original page changes or disappears.' : 'Search a few words from the page’s title or text.';
    q('#beta-recall-next').textContent = reading ? 'Read saved page' : 'Try a search';
    q<HTMLButtonElement>('#beta-recall-skip').disabled = finishingRecall;
    q('#beta-optional-ai').hidden = !showAiIntroduction || currentSettings.automaticAi === true;
    const emptyNote = recents.querySelector('.wr-empty-memory > .wr-help');
    if (emptyNote) emptyNote.textContent = unfinished ? 'Capture a page, search a few words, then read what you saved. No model setup needed.' : 'Start with the page you’re browsing.';
    const skip = recents.querySelector<HTMLButtonElement>('.wr-skip-recall'); if (skip) { skip.hidden = !unfinished; skip.disabled = finishingRecall; }
  }
  async function finishRecall(introduceAi: boolean): Promise<void> {
    if (currentSettings.recallSetupComplete || finishingRecall) return;
    finishingRecall = true; syncRecallGuide();
    try {
      const response = await sendRuntimeMessage<{ settings: BetaSettings }>({ type: 'SET_SETTINGS', payload: { recallSetupComplete: true } });
      showAiIntroduction = introduceAi;
      applySettings(response.settings);
    } catch (error) { setStatus(`Unable to save guide progress: ${error instanceof Error ? error.message : String(error)}`, true); }
    finally { finishingRecall = false; syncRecallGuide(); }
  }
  function setStatus(text: string, error = false): void {
    status.textContent = text;
    status.dataset.variant = error ? 'error' : 'info';
    status.dataset.state = text.startsWith('Answer ready') ? 'ready' : 'active';
    toolbar.hidden = !status.textContent && askResults.hidden;
  }
  function candidates(): SavedPage[] { return searching ? resultPages : recentPages; }
  const canAsk = (): boolean => settingsLoaded && currentSettings.activeProviderId !== CHAT_PROVIDER_DISABLED;
  function sync(): void {
    recentSection.hidden = searching; clear.hidden = !input.value;
    askResults.hidden = !canAsk() || !candidates().length || multiAsk; askResults.disabled = Boolean(searchRequestId);
    const askMemory = document.getElementById('beta-ask-memory'); if (askMemory) askMemory.hidden = !canAsk();
    toolbar.hidden = !status.textContent && askResults.hidden; syncRecallGuide();
  }
  function syncQueue(): void {
    captureQueue.hidden = queue.length === 0 && !captureQueue.open;
    const failed = queue.filter(item => item.status === 'failed').length;
    const allSaved = queue.every(item => item.textSaved);
    q('#beta-queue-label').textContent = !queue.length ? 'Capture queue' : allSaved ? `${queue.length} saved ${queue.length === 1 ? 'page' : 'pages'} · ${failed ? `${failed} indexing failed` : 'indexing'}` : `${queue.length} capture${queue.length === 1 ? '' : 's'} · ${failed ? `${failed} failed` : 'in progress'}`;
    q('#beta-retry-failed').hidden = !failed;
  }
  captureQueue.addEventListener('toggle', syncQueue);
  function cancelSearch(): void { const id = searchRequestId; searchRequestId = null; stop.hidden = true; if (id) void sendRuntimeMessage({ type: 'CANCEL_SEARCH', requestId: id }).catch(error => console.warn('Unable to cancel search', error)); }
  function closeAsk(): void { activeChat.close(); }
  window.addEventListener('wr-ask-closed', () => { multiAsk = false; if (activeAskButton) activeAskButton.hidden = !canAsk(); activeAskButton = null; sync(); });
  function row(page: SavedPage, result?: SearchResult): HTMLElement {
    const entry = createPageEntry(page); entry.article.classList.add('beta-result-card'); entry.details.name = 'search-preview';
    if (page.snippet) { const snippet = document.createElement('span'); snippet.className = 'result-snippet'; snippet.textContent = page.snippet.replace(/\s+/g, ' ').trim(); entry.summary.append(snippet); }
    const passage = page.snippet ? entry.body.querySelector('p')! : document.createElement('p');
    if (!page.snippet) entry.body.append(passage);
    const previewLabel = document.createElement('span'); previewLabel.className = 'wr-help'; previewLabel.textContent = 'Summary'; previewLabel.hidden = true; passage.before(previewLabel);
    const more = document.createElement('button'); more.className = 'text-button preview-toggle'; more.type = 'button'; more.hidden = true;
    let preview = '', expanded = false;
    function renderPreview(text: string): void {
      preview = text.replace(/\s+/g, ' ').trim();
      const short = preview.length > 260;
      const prefix = preview.slice(0, 260), boundary = prefix.lastIndexOf(' ');
      const sentence = [...prefix.matchAll(/[.!?](?=\s|$)/g)].at(-1)?.index;
      const compact = sentence !== undefined && sentence >= 80 ? prefix.slice(0, sentence + 1) : `${prefix.slice(0, boundary > 0 ? boundary : prefix.length)}…`;
      passage.textContent = short && !expanded ? compact : preview;
      more.hidden = !short; more.textContent = expanded ? 'Show less' : 'Show more'; more.setAttribute('aria-expanded', String(expanded));
    }
    more.addEventListener('click', () => { expanded = !expanded; renderPreview(preview); });
    passage.after(more); if (page.snippet) renderPreview(page.snippet);
    const badge = document.createElement('span'); badge.className = 'wr-item-ask-state wr-help'; badge.hidden = !canAsk(); badge.setAttribute('role', 'status'); entry.summary.append(badge);
    const existing = itemChats.get(page.url); if (existing) { existing.badge = badge; badge.textContent = existing.state; }
    const actions = document.createElement('div'); actions.className = 'preview-actions';
    const original = document.createElement('a'); original.href = page.url; original.target = '_blank'; original.rel = 'noreferrer'; original.className = 'original-link'; original.append(icon('arrow-up-right'), document.createTextNode('Open live page'));
    const button = document.createElement('button'); button.className = 'ask-this-page'; button.hidden = !canAsk(); button.append(icon('chat-circle'), document.createTextNode('Ask about this'));
    button.addEventListener('click', () => {
      if (!canAsk()) return;
      closeAsk();
      let chat = itemChats.get(page.url);
      if (!chat) {
        const host = document.createElement('section');
        const controller = createAskView(host, state => { const current = itemChats.get(page.url); if (current) { current.state = state; current.badge.textContent = state; } });
        if (settingsLoaded) controller.setAutomaticAi(currentSettings.automaticAi);
        chat = { host, controller, badge, state: '' }; itemChats.set(page.url, chat);
      }
      activeChat = chat.controller; activeHost = chat.host;
      activeAskButton = button; button.hidden = true; multiAsk = false; activeChat.open(entry.body, [page], 'Ask about this page'); sync();
    });
    const read = document.createElement('button'); read.type = 'button'; read.className = 'primary-button read-saved-page'; read.textContent = 'Read saved page';
    const readerHost = document.createElement('section'); readerHost.className = 'saved-reader-host'; readerHost.hidden = true; readerHost.setAttribute('aria-label', 'Saved page reader');
    const reader = createSavedReader(readerHost, () => { delete entry.body.dataset.reading; read.focus({ preventScroll: true }); }, () => {
      if (readerHost.isConnected && entry.details.open && !container.hidden && searching && resultPages.some(result => result.url === page.url)) void finishRecall(true);
    });
    const openReader = (history = false): void => { closeAsk(); entry.body.dataset.reading = 'true'; void reader.open(page.url, result ? page.timestamp : undefined, input.value.trim(), result?.chunkIndex, result?.versionId, history); };
    read.addEventListener('click', () => openReader());
    entry.article.addEventListener('wr-open-saved-history', () => openReader(true));
    entry.article.addEventListener('wr-open-saved-reader', () => openReader());
    actions.append(read, original, button); entry.body.append(actions, readerHost);
    const noticeHost = document.createElement('div'); entry.body.insertBefore(noticeHost, actions);
    const showCaptureNotice = (info?: CaptureInfo): void => { noticeHost.replaceChildren(); const notice = captureNotice(info); if (notice) noticeHost.append(notice); };
    showCaptureNotice(page.captureInfo);
    if (result) { const details = document.createElement('details'); details.className = 'wr-match-details'; const summary = document.createElement('summary'); summary.append(document.createTextNode('Match details'), icon('caret-down')); const copy = document.createElement('p'); copy.textContent = [formatScoreLabel(result), result.hitsFromPage ? `${result.hitsFromPage} matches` : '', formatDate(result.timestamp)].filter(Boolean).join(' · '); details.append(summary, copy); entry.body.append(details); }
    entry.summary.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const summaries = Array.from(container.querySelectorAll<HTMLElement>(searching ? '#beta-search-results > article > details > summary' : '#beta-recents-list > article > details > summary'));
      const index = summaries.indexOf(entry.summary); event.preventDefault();
      if (event.key === 'ArrowUp' && index === 0) input.focus(); else summaries[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    });
    let loaded = false;
    function loadPreview(): void {
      if (loaded) return;
      loaded = true;
      if (!page.snippet) passage.textContent = 'Loading saved passage…';
      void sendRuntimeMessage<{ page: SavedPage | null }>({ type: 'GET_PAGE_PREVIEW', url: page.url, timestamp: result?.timestamp, versionId: result?.versionId }).then(response => { previewLabel.hidden = response.page?.previewKind !== 'summary'; renderPreview(response.page?.snippet || page.snippet || 'No captured text is available for this page.'); showCaptureNotice(response.page?.captureInfo); }).catch(error => { loaded = false; if (!page.snippet) passage.textContent = `Preview unavailable: ${(error instanceof Error ? error.message : String(error))}`; });
    }
    entry.details.addEventListener('wr-summary-updated', () => { loaded = false; if (entry.details.open) loadPreview(); });
    entry.details.addEventListener('toggle', () => {
      if (!entry.details.open) { if (entry.body.contains(activeHost)) closeAsk(); return; }
      loadPreview();
    });
    return entry.article;
  }
  function resetSearch(): void { clearTimeout(debounce); generation++; cancelSearch(); closeAsk(); searching = false; actionFeedback = undefined; input.value = ''; filters = {}; filterForm.reset(); q('#beta-search-filters summary').textContent = 'Filters'; resultPages = []; resultsWrap.replaceChildren(); setStatus(recentPages.length ? `${recentPages.length} ${recentPages.length === 1 ? 'page' : 'pages'}` : ''); sync(); }
  function renderResults(results: SearchResult[]): void {
    const retained = new Map<string, HTMLElement>();
    for (const article of resultsWrap.querySelectorAll<HTMLElement>(':scope > article')) {
      const details = article.querySelector<HTMLDetailsElement>(':scope > details');
      if (details?.open && details.dataset.url) retained.set(details.dataset.url, article);
    }
    resultPages = [...resultPages.filter(page => retained.has(page.url)), ...results.filter(page => !retained.has(page.url))];
    const kept = new Set(retained.values());
    for (const child of [...resultsWrap.children]) if (!kept.has(child as HTMLElement)) child.remove();
    for (const page of resultPages) if (!retained.has(page.url)) resultsWrap.append(row(page, page));
    if (!resultPages.length) replaceWithMessage(resultsWrap, 'No matching pages. Try another search or capture a page.');
    sync();
  }
  function showRecents(incoming: SavedPage[], force = false): boolean {
      if (recents.querySelector('details[open]') && recents.children.length) { if (!force) return false; closeAsk(); }
      const replacingFocusedEmptyState = incoming.length > 0 && recents.querySelector('.wr-empty-memory')?.contains(document.activeElement);
      if (JSON.stringify(incoming) !== JSON.stringify(recentPages) || !recents.children.length) {
        recentPages = incoming; recents.replaceChildren(...recentPages.map(page => row(page)));
        if (!recentPages.length) {
          const empty = document.createElement('div'); empty.className = 'wr-empty-memory';
          const title = document.createElement('p'); title.textContent = 'No saved pages yet.';
          const note = document.createElement('p'); note.className = 'wr-help'; note.textContent = 'Start with the page you’re browsing.';
          const capture = document.createElement('button'); capture.className = 'primary-button'; capture.textContent = 'Capture current tab'; capture.addEventListener('click', () => q('#beta-capture-now').click());
          const settings = document.createElement('button'); settings.className = 'text-button'; settings.textContent = 'Capture settings'; settings.addEventListener('click', () => navigateTo('settings', 'capture'));
          const skip = document.createElement('button'); skip.className = 'text-button wr-skip-recall'; skip.textContent = 'Skip guide'; skip.hidden = true; skip.addEventListener('click', () => { void finishRecall(false); });
          const actions = document.createElement('div'); actions.className = 'button-row'; actions.append(capture, settings, skip); empty.append(title, note, actions); recents.append(empty);
        }
      }
      if (!actionFeedback && !searching && !searchRequestId) setStatus(recentError || (recentPages.length ? `${recentPages.length} ${recentPages.length === 1 ? 'page' : 'pages'}` : ''), Boolean(recentError));
      sync();
      if (replacingFocusedEmptyState) (q('#beta-recall-setup').hidden ? input : q('#beta-recall-next')).focus();
      return true;
  }
  async function refreshRecents(force = false): Promise<void> {
    if (loadingMore && !force) return;
    if (force) { loadingMore = false; loadMore.disabled = false; }
    const revision = ++recentRevision;
    try {
      const response = await sendRuntimeMessage<RecentPageBatch>({ type: 'GET_RECENT_PAGES' });
      if (revision !== recentRevision) return;
      const incoming = readRecentPages(response.pages);
      if (!incoming) throw new Error('Invalid recent-pages response');
      allowCachedRecents = false; recentError = '';
      recovery.hidden = true;
      const merged = loadedMore && !force ? [...incoming, ...recentPages.filter(page => !incoming.some(latest => latest.url === page.url))] : incoming;
      if (showRecents(merged, force)) {
        if (!loadedMore || force) { nextRecentCursor = readRecentCursor(response.nextCursor) || null; loadedMore = false; }
        loadMore.hidden = !nextRecentCursor;
      }
    } catch (error) {
      if (revision !== recentRevision) return;
      recentError = `Unable to refresh pages: ${error instanceof Error ? error.message : String(error)}`;
      recovery.hidden = !isMissingLibraryError(recentError);
      if (!actionFeedback && !searching) setStatus(recentError, true);
    }
  }
  async function loadMoreRecents(): Promise<void> {
    if (!nextRecentCursor || loadingMore || searching) return;
    const cursor = nextRecentCursor, revision = recentRevision;
    loadingMore = true; loadMore.disabled = true;
    try {
      const response = await sendRuntimeMessage<RecentPageBatch>({ type: 'GET_RECENT_PAGES', after: cursor });
      if (revision !== recentRevision) return;
      const incoming = readRecentPages(response.pages);
      if (!incoming) throw new Error('Invalid recent-pages response');
      const additions = incoming.filter(page => !recentPages.some(existing => existing.url === page.url));
      const appended = additions.map(page => row(page)), focused = document.activeElement === loadMore;
      recentPages.push(...additions); recents.append(...appended);
      nextRecentCursor = readRecentCursor(response.nextCursor) || null; loadedMore = true; loadMore.hidden = !nextRecentCursor;
      if (focused && loadMore.hidden) appended[0]?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
      if (!actionFeedback && !searching) setStatus(`${recentPages.length} pages`);
    } catch (error) { if (!actionFeedback && !searching && revision === recentRevision) setStatus(`Unable to load more pages: ${error instanceof Error ? error.message : String(error)}`, true); }
    finally { if (revision === recentRevision) { loadingMore = false; loadMore.disabled = false; } }
  }
  async function refreshQueue(): Promise<void> {
    try {
      const response = await sendRuntimeMessage<{ queue: typeof queue }>({ type: 'GET_PROCESSING' }); queue = response.queue || [];
      syncQueue();
      const view = q('#beta-capture-status'); view.replaceChildren();
      if (!queue.length) view.textContent = 'No pending captures.';
      else {
        const list = document.createElement('ul');
        for (const item of queue) {
          const li = document.createElement('li'), copy = document.createElement('span'); copy.textContent = `${item.title || item.url} · ${captureStatusText(item)}`;
          const retry = document.createElement('button'); retry.className = 'text-button'; retry.textContent = 'Retry'; retry.disabled = item.status !== 'failed'; retry.addEventListener('click', () => { void action({ type: 'RETRY_PROCESSING', url: item.url }, 'Retry queued'); }); li.append(copy, retry); list.append(li);
        }
        view.append(list);
      }
    } catch (error) { q('#beta-capture-status').textContent = `Status unavailable: ${(error instanceof Error ? error.message : String(error))}`; }
  }
  async function action(message: Record<string, unknown>, success: string | ((response: { domain?: string }) => string)): Promise<void> {
    const feedback = Symbol();
    actionFeedback = feedback;
    const capture = message.type === 'CAPTURE_ACTIVE_TAB';
    if (capture) { q<HTMLButtonElement>('#beta-capture-now').disabled = true; setStatus('Saving page…'); }
    try {
      const response = await sendRuntimeMessage<{ settings?: BetaSettings; domain?: string }>(message);
      if (response.settings) applySettings(response.settings);
      await Promise.all([refreshQueue(), refreshRecents()]);
      if (actionFeedback === feedback) setStatus(typeof success === 'function' ? success(response) : success);
    } catch (error) {
      if (actionFeedback === feedback) setStatus(`Request failed: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      if (capture) q<HTMLButtonElement>('#beta-capture-now').disabled = false;
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); clearTimeout(debounce);
    actionFeedback = undefined;
    const query = input.value.trim(); if (!query && !Object.keys(filters).length) { resetSearch(); return; }
    closeAsk(); cancelSearch();
    const requestId = crypto.randomUUID(), current = ++generation; searchRequestId = requestId; searching = true; stop.hidden = false;
    resultPages = []; resultsWrap.replaceChildren(); setStatus('Searching…'); sync();
    try {
      const response = await sendRuntimeMessage<{ results: SearchResult[] }>({ type: 'SEARCH_QUERY', requestId, query, limit: 20, filters });
      if (current !== generation) return;
      renderResults(response.results || []); setStatus(`${resultPages.length} ${resultPages.length === 1 ? 'page' : 'pages'}`);
    } catch (error) { if (current === generation) { if (!resultPages.length) renderResults([]); setStatus(`${resultPages.length ? 'Showing text matches; refinement failed' : 'Search failed'}: ${error instanceof Error ? error.message : String(error)}`, true); } }
    finally { if (searchRequestId === requestId) { searchRequestId = null; stop.hidden = true; sync(); } }
  });
  filterForm.addEventListener('submit', event => {
    event.preventDefault();
    const from = q<HTMLInputElement>('#beta-filter-from').value, to = q<HTMLInputElement>('#beta-filter-to').value;
    try {
      filters = readSearchFilters({ domain: q<HTMLInputElement>('#beta-filter-domain').value.trim(), ...readCaptureDateRange(from, to) });
      q('#beta-search-filters summary').textContent = Object.keys(filters).length ? `Filters (${Object.keys(filters).length})` : 'Filters';
      q<HTMLDetailsElement>('#beta-search-filters').open = false;
      form.requestSubmit();
    } catch (error) { clearTimeout(debounce); generation++; cancelSearch(); setStatus(error instanceof Error ? error.message : String(error), true); sync(); }
  });
  q('#beta-filter-clear').addEventListener('click', () => { filters = {}; filterForm.reset(); q('#beta-search-filters summary').textContent = 'Filters'; form.requestSubmit(); });
  input.addEventListener('input', () => { clearTimeout(debounce); generation++; actionFeedback = undefined; cancelSearch(); closeAsk(); clear.hidden = !input.value; if (!input.value && !Object.keys(filters).length) resetSearch(); else { searching = true; resultPages = []; resultsWrap.replaceChildren(); setStatus('Searching…'); sync(); debounce = setTimeout(() => form.requestSubmit(), 450); } });
  input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); container.querySelector<HTMLElement>(searching ? '#beta-search-results > article > details > summary' : '#beta-recents-list > article > details > summary')?.focus(); } });
  clear.addEventListener('click', () => { resetSearch(); input.focus(); });
  stop.addEventListener('click', () => { generation++; cancelSearch(); setStatus('Stopped.'); sync(); });
  askResults.addEventListener('click', () => { if (!canAsk()) return; closeAsk(); activeChat = ask; activeHost = askHost; multiAsk = true; ask.open(multi, candidates(), 'Ask your results'); sync(); });
  q('#beta-capture-now').addEventListener('click', () => { void action({ type: 'CAPTURE_ACTIVE_TAB' }, 'Page saved · text-searchable'); });
  q('#beta-retry-failed').addEventListener('click', () => { void action({ type: 'RETRY_FAILED_CAPTURES' }, 'Retry requested'); });
  q('#beta-refresh-recents').addEventListener('click', () => { actionFeedback = undefined; if (input.value.trim()) form.requestSubmit(); else void refreshRecents(true); });
  q('#beta-enable-broad-capture').addEventListener('click', () => { void action({ type: 'SET_SETTINGS', payload: { paused: false, captureSetupComplete: true, allowlist: [] } }, 'Broad capture enabled'); });
  q('#beta-keep-manual-capture').addEventListener('click', () => { void action({ type: 'SET_SETTINGS', payload: { paused: true, captureSetupComplete: true } }, 'Manual saving only · automatic capture stays paused'); });
  q('#beta-open-capture-settings').addEventListener('click', () => { navigateTo('settings', 'capture'); });
  q('#beta-recall-skip').addEventListener('click', () => { void finishRecall(false); });
  q('#beta-recall-next').addEventListener('click', () => {
    if (!searching || !resultPages.length) { input.focus(); return; }
    const article = resultsWrap.querySelector<HTMLElement>(':scope > article');
    const details = article?.querySelector<HTMLDetailsElement>('details');
    if (article && details) { details.open = true; article.dispatchEvent(new window.Event('wr-open-saved-reader')); }
  });
  q('#beta-setup-ai').addEventListener('click', () => { navigateTo('settings', 'models'); });
  q('#beta-ai-not-now').addEventListener('click', () => { showAiIntroduction = false; syncRecallGuide(); });
  function applySettings(settings: BetaSettings): void {
    const setup = q('#beta-capture-setup');
    const hidingFocusedSetup = settings.captureSetupComplete && !setup.hidden && setup.contains(document.activeElement);
    currentSettings = settings; settingsLoaded = true; setup.hidden = settings.captureSetupComplete; syncRecallGuide();
    ask.setAutomaticAi(settings.automaticAi);
    itemChats.forEach(chat => chat.controller.setAutomaticAi(settings.automaticAi));
    if (!canAsk() && activeHost.isConnected) {
      const wasFocused = activeHost.contains(document.activeElement);
      closeAsk();
      if (wasFocused) input.focus({ preventScroll: true });
    }
    container.querySelectorAll<HTMLElement>('.ask-this-page, .wr-item-ask-state').forEach(control => {
      control.hidden = !canAsk() || control === activeAskButton;
    });
    sync();
    if (hidingFocusedSetup) ((searching ? null : recents.querySelector<HTMLButtonElement>('.wr-empty-memory .primary-button')) ?? input).focus();
    const pause = document.getElementById('beta-pause-capture-menu'); if (pause) pause.textContent = settings.paused ? 'Resume automatic capture' : 'Pause automatic capture';
  }
  void sendRuntimeMessage<{ settings: BetaSettings }>({ type: 'GET_SETTINGS' }).then(response => { if (!settingsLoaded) applySettings(response.settings || DEFAULT_SETTINGS); }).catch(() => {});
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message.type === 'SEARCH_RESULTS_UPDATE' && message.requestId === searchRequestId && searchRequestId && Array.isArray(message.results)) {
      if (message.results.length) renderResults(message.results as SearchResult[]);
      setStatus(resultPages.length ? `${resultPages.length} ${resultPages.length === 1 ? 'page' : 'pages'} · Refining…` : 'No text matches yet · Searching by meaning…');
    }
    if (message.type === 'CAPTURE_QUEUE_UPDATED') { void refreshQueue(); void refreshRecents(); }
    if (message.type === 'BETA_SETTINGS_UPDATED' && message.settings) applySettings(message.settings as BetaSettings);
  });
  window.addEventListener('wr-memory-changed', () => {
    ask.invalidate(); itemChats.forEach(chat => chat.controller.dispose()); itemChats.clear(); generation++; cancelSearch();
    allowCachedRecents = false; recentRevision++; recentPages = []; recents.replaceChildren();
    nextRecentCursor = null; loadedMore = false; loadMore.hidden = true;
    if (searching) form.requestSubmit();
    void refreshRecents(true);
  });
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => {
    if (message.type === 'SUMMARY_UPDATED') container.querySelectorAll<HTMLDetailsElement>('details[data-url]').forEach(details => {
      if (details.dataset.url === message.url) details.dispatchEvent(new window.Event('wr-summary-updated'));
    });
  });
  setStatus('Loading saved pages…');
  void (async () => {
    try {
      const stored = await chrome.storage?.session?.get(RECENTS_CACHE_KEY);
      const cached = readRecentPages(stored?.[RECENTS_CACHE_KEY]);
      if (allowCachedRecents && cached) showRecents(cached);
    } catch (error) { console.debug('[beta-ui:sidepanel] recents cache unavailable', error); }
  })();
  loadMore.addEventListener('click', () => { void loadMoreRecents(); });
  chrome.storage?.onChanged?.addListener((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => {
    if (area === 'session' && changes[RECENTS_CACHE_KEY]?.oldValue && changes[RECENTS_CACHE_KEY].newValue === undefined) window.dispatchEvent(new window.Event('wr-memory-changed'));
  });
  if (typeof IntersectionObserver !== 'undefined') {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMoreRecents(); }, { rootMargin: '200px' });
    observer.observe(loadMore);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  const stopPolling = startPolling(() => { if (container.hidden) return; void refreshQueue(); void refreshRecents(); void refreshRemoteProviderBanner(document.querySelector('#beta-remote-provider-banner')); }, 5000);
  window.addEventListener('pagehide', () => { clearTimeout(debounce); generation++; cancelSearch(); stopPolling(); }, { once: true });
  return {
    capturePaused: () => currentSettings.paused,
    toggleCapture() { void action({ type: 'TOGGLE_CAPTURE_PAUSE' }, () => currentSettings.paused ? 'Automatic capture paused · manual saving still works' : 'Automatic capture resumed with your site rules'); },
    excludeSite() { void action({ type: 'EXCLUDE_ACTIVE_SITE' }, response => `${response.domain || 'Current site'} excluded. Existing saves remain; use Memory to forget them.`); },
    openQueue() { captureQueue.hidden = false; captureQueue.open = true; void refreshQueue(); captureQueue.querySelector<HTMLElement>('summary')!.focus(); captureQueue.scrollIntoView({ block: 'nearest' }); },
    askMemory() { if (!canAsk()) return; closeAsk(); activeChat = ask; activeHost = askHost; multiAsk = true; ask.open(multi, null, 'Ask your memory'); sync(); },
    async openPage(url, mode) {
      closeAsk(); const current = ++generation; cancelSearch();
      try {
        const response = await sendRuntimeMessage<{ page: SavedPage | null }>({ type: 'GET_PAGE_PREVIEW', url });
        if (current !== generation) return;
        if (!response.page) { setStatus('This page is no longer saved.', true); return; }
        input.value = response.page.title; searching = true;
        resultPages = [{ ...response.page, timestamp: response.page.timestamp || 0, snippet: response.page.snippet || '', score: 0 }];
        resultsWrap.replaceChildren(row(response.page)); resultsWrap.querySelector<HTMLDetailsElement>('details')!.open = true; setStatus('1 page'); sync();
        resultsWrap.querySelector<HTMLElement>('summary')!.focus({ preventScroll: true });
        if (mode === 'history') resultsWrap.firstElementChild?.dispatchEvent(new window.Event('wr-open-saved-history'));
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
  function show(view: AppView, detail?: string, mode?: 'history'): void {
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
      const group = settings.querySelector<HTMLDetailsElement>(`#settings-${detail === 'logging' ? 'advanced' : detail === 'restore' ? 'storage' : detail}`); if (group) group.open = true;
      const logging = settings.querySelector<HTMLDetailsElement>('#settings-logging'); if (detail === 'logging' && logging) { logging.open = true; logging.querySelector<HTMLElement>('summary')?.focus(); }
    }
    if (view === 'sidepanel') { search.refresh(); if (detail) void search.openPage(detail, mode); else target.querySelector<HTMLInputElement>('#beta-search-input')!.focus({ preventScroll: true }); }
    window.scrollTo?.({ top: 0 });
    if (view === 'settings' && detail === 'restore') settings.querySelector<HTMLElement>('#manage-import')?.focus();
    if (view === 'settings' && detail === 'storage') settings.querySelector<HTMLElement>('#settings-storage > summary')?.focus();
  }
  window.addEventListener('wr-navigate', event => { const { view, url, mode } = (event as CustomEvent<{ view: AppView; url?: string; mode?: 'history' }>).detail; show(view, url, mode); });
  const menu = menuAnchor.querySelector('nav')!;
  const askMemory = document.createElement('button'); askMemory.id = 'beta-ask-memory'; askMemory.hidden = true; askMemory.append(icon('chat-circle'), document.createTextNode('Ask your memory')); askMemory.addEventListener('click', () => { if (askMemory.hidden) return; menuAnchor.open = false; show('sidepanel'); search.askMemory(); }); menu.append(askMemory);
  const capture = document.createElement('button'); capture.append(icon('file-text'), document.createTextNode('Capture current tab')); capture.addEventListener('click', () => { menuAnchor.open = false; show('sidepanel'); root.querySelector<HTMLButtonElement>('#beta-capture-now')!.click(); }); menu.append(capture);
  const pause = document.createElement('button'); pause.id = 'beta-pause-capture-menu';
  const syncPause = (): void => { pause.textContent = search.capturePaused() ? 'Resume automatic capture' : 'Pause automatic capture'; };
  syncPause();
  pause.addEventListener('click', () => { menuAnchor.open = false; show('sidepanel'); search.toggleCapture(); }); menu.append(pause);
  const exclude = document.createElement('button'); exclude.textContent = 'Never save current site'; exclude.addEventListener('click', () => { menuAnchor.open = false; show('sidepanel'); search.excludeSite(); }); menu.append(exclude);
  for (const [label, id] of [['Capture queue', 'beta-queue-section'], ['Refresh pages', 'beta-refresh-recents']]) {
    const button = document.createElement('button'); button.textContent = label!;
    button.addEventListener('click', () => { menuAnchor.open = false; show('sidepanel'); if (id === 'beta-queue-section') search.openQueue(); else document.getElementById(id!)!.click(); }); menu.append(button);
  }
  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); show('sidepanel'); root.querySelector<HTMLInputElement>('#beta-search-input')!.focus(); }
    if (event.key === 'Escape') {
      if (active !== 'sidepanel') show('sidepanel');
      else {
        const picker = root.querySelector<HTMLDetailsElement>('#beta-source-picker');
        if (picker?.open) { picker.open = false; picker.querySelector<HTMLElement>('summary')!.focus(); }
        else if (root.querySelector('#beta-ask-host:not([hidden])')) root.querySelector<HTMLButtonElement>('#beta-ask-close')!.click();
        else { const preview = root.querySelector<HTMLDetailsElement>('details[name=search-preview][open]'); if (preview) { preview.open = false; preview.querySelector<HTMLElement>('summary')!.focus(); } else root.querySelector<HTMLInputElement>('#beta-search-input')!.focus(); }
      }
    }
  });
  if (window.location.hash.startsWith('#settings')) {
    const section = window.location.hash.slice('#settings-'.length);
    show('settings', ['logging', 'advanced', 'storage', 'restore'].includes(section) ? section : undefined);
  }
  else if (window.location.hash.startsWith('#page=')) void search.openPage(decodeURIComponent(window.location.hash.slice(6)));
  else if (window.location.hash.startsWith('#history=')) void search.openPage(decodeURIComponent(window.location.hash.slice(9)), 'history');
  void refreshRemoteProviderBanner(root.querySelector('#beta-remote-provider-banner'));
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>) => { if (message.type === 'BETA_SETTINGS_UPDATED') { const settings = message.settings as BetaSettings; if (settings?.theme) applyTheme(settings.theme); void refreshRemoteProviderBanner(root.querySelector('#beta-remote-provider-banner'), settings); } });
}

const root = document.querySelector<HTMLElement>('#app-root');
if (root) {
  restoreCachedTheme();
  renderApp(root);
  void initTheme();
}
