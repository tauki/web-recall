/** Common controls and typography; the existing theme tokens remain authoritative. */
export function installSharedStyles(): void {
  if (document.getElementById('wr-shared-style')) return;
  const style = document.createElement('style');
  style.id = 'wr-shared-style';
  style.textContent = `
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    :root { color-scheme: light; --error: #b42318; }
    :root[data-theme="dark"] { color-scheme: dark; --error: #fca5a5; }
    #app-root { font-weight: 400; line-height: 1.5; }
    button, input, select, textarea { font: inherit; }
    button, .wr-button, #manage-import-label {
      min-height: 36px; padding: 6px 12px; border: 1px solid var(--border);
      border-radius: 6px; background: var(--surface-muted); color: var(--text);
      font-size: 0.875rem; font-weight: 600; cursor: pointer;
    }
    button:hover:not(:disabled), .wr-button:hover { filter: brightness(.95); }
    #app-root button:disabled { opacity: .45; cursor: not-allowed; }
    input:not([type=checkbox]):not([type=file]), select, textarea {
      min-height: 36px; min-width: 0; max-width: 100%; border: 1px solid var(--border);
      border-radius: 6px; padding: 6px 8px; background: var(--surface); color: var(--text);
    }
    textarea { resize: vertical; }
    input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
    input[type=checkbox] { accent-color: var(--accent); width: 16px; height: 16px; flex: 0 0 auto; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    ::selection { background: var(--accent); color: var(--accent-contrast); }
    a { text-underline-offset: 3px; overflow-wrap: anywhere; }
    h1 { font-size: 1.65rem; line-height: 1.25; }
    #app-root h2 { font-size: 1.1rem; line-height: 1.3; }
    h1, h2, h3, strong { font-weight: 650; }
    .wr-navigation { display: flex; gap: 8px 16px; flex-wrap: wrap; align-items: center;
      padding: 12px 0; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
    .wr-navigation a { color: var(--link, var(--text)); font-size: .9rem; }
    .wr-navigation [aria-current=page] { color: var(--text); font-weight: 650; text-decoration: none; }
    .wr-help, .wr-muted { font-size: .85rem; color: var(--muted); overflow-wrap: anywhere; }
    .wr-status { min-height: 1.5em; font-size: .9rem; overflow-wrap: anywhere; }
    [data-variant=error], .beta-status[data-variant=error], .beta-status[data-error=true] { color: var(--error); }
    details > summary { cursor: pointer; padding: 6px 0; }
    .beta-result-meta { flex-wrap: wrap; justify-content: flex-start; gap: 4px 12px; line-height: 1.5; }
    .beta-result-meta > span { max-width: 100%; overflow-wrap: anywhere; }
    .wr-match-details { margin-top: 6px; color: var(--muted); font-size: .8rem; }
    .wr-match-details p { margin: 4px 0; font-size: inherit; }
    .beta-result-card { min-width: 0; overflow-wrap: anywhere; }
    .beta-search-form { flex-wrap: wrap; }
    .beta-search-form input { flex-basis: 160px; }
    .beta-search-form button[data-secondary], .beta-ask-actions button[data-secondary] {
      background: var(--surface-muted); color: var(--text); border: 1px solid var(--border);
    }
    .beta-ask-actions { gap: 8px; flex-wrap: wrap; }
    .beta-ask-answer { white-space: normal; line-height: 1.65; }
    .beta-ask-answer[data-streaming=true] { white-space: pre-wrap; }
    .beta-ask-answer p { margin: 0 0 .8em; }
    .beta-ask-answer p:last-child { margin-bottom: 0; }
    .beta-ask-answer ul, .beta-ask-answer ol { padding-inline-start: 1.4em; }
    .beta-ask-answer pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .beta-ask-log { overflow-wrap: anywhere; }
    .beta-ask-sources article { scroll-margin: 16px; }
    .beta-settings-root .beta-card { scroll-margin-top: 65px; }
    .beta-settings-root .beta-help, .beta-settings-root .beta-status { overflow-wrap: anywhere; }
    .wr-settings-sections { display: flex; gap: 12px; flex-wrap: wrap; }
    .wr-settings-status { position: sticky; top: 0; z-index: 1; background: var(--bg); padding: 8px 0; }
    .wr-settings-group { display: flex; flex-direction: column; gap: 16px; }
    .wr-settings-group > h2 { margin-bottom: 0; }
    .wr-setting-feedback { margin: 8px 0 0; font-size: .85rem; overflow-wrap: anywhere; }
    .wr-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .manage-header { flex-wrap: wrap; gap: 16px; }
    .manage-toolbar input[type=search] { min-width: 0; }
    .manage-shell table { width: 100%; table-layout: fixed; }
    .manage-shell th:first-child { width: 40px; }
    .manage-shell th:nth-child(2) { width: 38%; }
    .manage-shell th:last-child { width: 160px; }
    .manage-shell td { vertical-align: top; overflow-wrap: anywhere; }
    .manage-shell td button { margin: 0 4px 6px 0 !important; }
    .manage-shell td details { font-size: .8rem; color: var(--muted); }
    .wr-embedding-status { display: block; font-weight: 600; }
    .wr-row-progress { display: block; font-size: .85rem; margin-top: 6px; }
    .manage-shell input[type=file] { display: block; margin-top: 6px; }
    @media (max-width: 680px) {
      .manage-shell table, .manage-shell tbody, .manage-shell tr, .manage-shell td { display: block; width: 100%; }
      .manage-shell thead { display: block; }
      .manage-shell thead tr { display: flex; gap: 8px; flex-wrap: wrap; }
      .manage-shell th { width: auto !important; }
      .manage-shell th:nth-last-child(-n+2) { display: none; }
      .manage-shell tbody tr { border-top: 1px solid var(--border); padding: 12px 0; }
      .manage-shell tbody td { border: 0; padding: 4px 0; }
      .manage-shell tbody td[data-label]::before { content: attr(data-label) ': '; color: var(--muted); }
    }
  `;
  document.head.appendChild(style);
}

export function createToolNavigation(current: string): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'wr-navigation';
  nav.setAttribute('aria-label', 'Web Recall');
  for (const [view, name] of [['sidepanel', 'Search & Ask'], ['manage', 'Memory'], ['highlights', 'Highlights'], ['logs', 'Logs']] as const) {
    const link = document.createElement('a');
    link.href = chrome.runtime.getURL(`dist/beta/ui/${view}/index.html`);
    link.textContent = name;
    if (view === current) link.setAttribute('aria-current', 'page');
    nav.appendChild(link);
  }
  const settings = document.createElement('a');
  settings.textContent = 'Settings';
  settings.href = chrome.runtime.getURL('dist/beta/ui/sidepanel/index.html#settings');
  nav.appendChild(settings);
  return nav;
}

export function relativeDate(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
