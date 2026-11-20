import { DESIGN_STYLES } from './design';

export type AppView = 'sidepanel' | 'settings' | 'manage' | 'highlights' | 'logs';
const paths: Record<AppView, string> = {
  sidepanel: 'sidepanel/index.html', settings: 'sidepanel/index.html#settings',
  manage: 'manage/index.html', highlights: 'highlights/index.html', logs: 'logs/index.html'
};

export function appUrl(view: AppView): string { return chrome.runtime.getURL(`dist/beta/ui/${paths[view]}`); }

export function navigateTo(view: AppView, url?: string, mode?: 'history'): boolean {
  if (!document.querySelector('#beta-view-search')) return false;
  window.dispatchEvent(new window.CustomEvent('wr-navigate', { detail: { view, url, mode } }));
  return true;
}

export function createStorageSettingsLink(detail: 'storage' | 'restore', label: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'text-button';
  link.href = `${appUrl('settings')}-${detail}`;
  link.textContent = label;
  link.addEventListener('click', event => {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && navigateTo('settings', detail)) event.preventDefault();
  });
  return link;
}

export function isMissingLibraryError(message: string): boolean {
  return /(?:saved|previously opened local) library(?: file)? is missing\b/iu.test(message);
}

export function icon(name: string): HTMLElement {
  const span = document.createElement('span');
  span.className = `wr-icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

export function iconMarkup(name: string): string { return `<span class="wr-icon icon-${name}" aria-hidden="true"></span>`; }

export function createBackLink(): HTMLAnchorElement {
  const link = document.createElement('a'); link.className = 'utility-back'; link.href = appUrl('sidepanel');
  link.append(icon('arrow-left'), document.createTextNode('Back to search'));
  link.addEventListener('click', event => { if (navigateTo('sidepanel')) event.preventDefault(); });
  return link;
}

/** Native links also work when a tool is opened directly from Chrome's options page. */
export function createToolNavigation(current: string): HTMLElement {
  const header = document.createElement('header'); header.className = 'browser-header';
  const brand = document.createElement('div'); brand.className = 'identity';
  const logo = document.createElement('span'); logo.className = 'brand-mark'; logo.setAttribute('aria-hidden', 'true');
  brand.append(logo, document.createTextNode('Web Recall'));
  const menu = document.createElement('details'); menu.className = 'menu-anchor';
  const summary = document.createElement('summary'); summary.className = 'app-menu-button'; summary.setAttribute('aria-label', 'Open app menu');
  summary.append(icon('list'), document.createTextNode('Menu')); menu.append(summary);
  const nav = document.createElement('nav'); nav.className = 'panel-menu'; nav.setAttribute('aria-label', 'Web Recall');
  for (const [view, label, glyph] of [['sidepanel', 'Search & Ask', 'magnifying-glass'], ['manage', 'Memory Manager', 'book'], ['highlights', 'Highlights', 'stack'], ['settings', 'Settings', 'gear'], ['logs', 'Logs', 'clock-counter-clockwise']] as const) {
    const link = document.createElement('a'); link.href = appUrl(view); link.dataset.view = view;
    link.append(icon(glyph), document.createTextNode(label));
    if (current === view) link.setAttribute('aria-current', 'page');
    link.addEventListener('click', event => { menu.open = false; if (navigateTo(view)) event.preventDefault(); });
    nav.append(link);
  }
  menu.append(nav); header.append(brand, menu);
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target as Node)) menu.open = false; });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; summary.focus(); event.stopPropagation(); } });
  return header;
}

export function sourceMeta(url: string, timestamp?: number): HTMLElement {
  const meta = document.createElement('span'); meta.className = 'source-meta';
  const domain = document.createElement('span'); domain.className = 'domain';
  try { domain.textContent = new URL(url).hostname; } catch { domain.textContent = url; }
  meta.append(icon('file-text'), domain);
  if (timestamp) { const time = document.createElement('span'); time.className = 'saved-date'; time.textContent = `· ${relativeDate(timestamp)}`; meta.append(time); }
  return meta;
}

export function createPageEntry(page: { url: string; title: string; timestamp?: number; snippet?: string }): { article: HTMLElement; details: HTMLDetailsElement; body: HTMLElement; summary: HTMLElement } {
  const article = document.createElement('article'); article.className = 'content-item';
  const details = document.createElement('details'); details.className = 'content-entry'; details.dataset.url = page.url;
  const summary = document.createElement('summary'); summary.setAttribute('aria-label', `Preview ${page.title || page.url}`);
  const title = document.createElement('span'); title.className = 'result-title'; title.textContent = page.title || page.url;
  const caret = icon('caret-down'); caret.classList.add('content-entry-caret');
  summary.append(sourceMeta(page.url, page.timestamp), title, caret);
  const body = document.createElement('div'); body.className = 'content-entry-body';
  if (page.snippet) { const passage = document.createElement('p'); passage.textContent = page.snippet; body.append(passage); }
  details.append(summary, body); article.append(details);
  return { article, details, body, summary };
}

export function installSharedStyles(): void {
  if (document.getElementById('wr-shared-style')) return;
  const style = document.createElement('style'); style.id = 'wr-shared-style';
  const assets = chrome.runtime.getURL('dist/beta/');
  const names = ['caret-down', 'magnifying-glass', 'x', 'list', 'arrow-left', 'arrow-right', 'arrow-up-right', 'paper-plane-right', 'chat-circle', 'arrow-u-up-left', 'file-text', 'book', 'gear', 'stack', 'clock-counter-clockwise'];
  style.textContent = `
    @font-face { font-family:'Inter Variable';font-style:normal;font-weight:100 900;font-display:swap;src:url('${assets}fonts/inter-latin.woff2') format('woff2'); }
    @font-face { font-family:'Inter Variable';font-style:normal;font-weight:100 900;font-display:swap;src:url('${assets}fonts/inter-latin-ext.woff2') format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
    ${DESIGN_STYLES}
    :root { --text:var(--ink);--bg:var(--page);--border:var(--line);--surface-muted:var(--preview);--accent:var(--violet);--accent-contrast:#fff;--link:var(--violet);--muted-strong:var(--muted); }
    [hidden] { display:none !important; }
    #app-root { max-width:480px;margin:0 auto;min-height:100dvh;font-weight:400;line-height:1.5; }
    #app-root[data-view=sidepanel] { max-width:none; }
    .beta-sidepanel-shell .search-header { top:0; }
    .beta-sidepanel-shell .search-row { gap:12px; }
    .beta-sidepanel-shell .app-menu-button { min-height:36px; }
    .beta-sidepanel-shell .panel-menu { top:40px; }
    .wr-utility-navigation { display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px; }
    .wr-empty-memory { padding:28px 6px; }
    .search-filters { margin-top:10px;color:var(--muted);font-size:12px; }
    .search-filters > summary { cursor:pointer;width:fit-content; }
    .search-filters form { padding-top:10px;display:grid;gap:10px;color:var(--ink); }
    .search-filters input { min-width:0;max-width:65%; }
    .content-entry-body[data-reading] > :not(.saved-reader-host) { display:none; }
    .saved-reader-host { min-width:0; }
    .saved-reader-text { white-space:pre-wrap;overflow-wrap:anywhere;max-width:75ch;line-height:1.65; }
    .saved-reader-text mark { color:var(--ink);background:var(--mark); }
    .saved-reader-history { margin:12px 0; }
    .saved-reader-history > div { display:grid;gap:10px;padding-top:10px; }
    .saved-reader-history select { min-width:0;max-width:75%; }
    .saved-reader-history .field-note,.capture-notice { color:var(--ink); }
    .capture-notice { font-size:12px;line-height:1.6; }
    .saved-version-confirm { padding:10px 0; }
    .saved-reader-live { display:inline-block;margin-top:20px; }
    .wr-empty-memory > p { margin:0 0 6px;font-size:14px; }
    .wr-empty-memory > .wr-help { font-size:12px; }
    .wr-empty-memory .button-row { margin-top:18px; }
    .wr-recall-guide { padding:0 0 20px; }
    .wr-recall-guide h2 { font-size:14px;font-weight:500;margin:0 0 6px; }
    .wr-recall-guide .wr-help { margin:0 0 12px;max-width:65ch; }
    .wr-icon { display:inline-block;vertical-align:middle;width:16px;height:16px;flex-shrink:0;background:currentColor;mask-size:contain;mask-position:center;mask-repeat:no-repeat; }
    ${names.map(name => `.icon-${name}{mask-image:url('${assets}ui/${name}.svg');}`).join('\n')}
    .browser-header .wr-icon { width:16px;height:16px; }
    .brand-mark { display:inline-block;width:16px;height:16px;flex-shrink:0;background:currentColor;mask:url('${assets}icons/mark.png') center/contain no-repeat; }
    summary { list-style:none;cursor:pointer; } summary::-webkit-details-marker { display:none; }
    .app-menu-button { display:flex; }
    .panel-menu { top:30px; }
    .panel-menu a { display:flex;gap:9px;align-items:center;padding:9px 7px;font-size:12px;border-radius:4px; }
    .panel-menu a:hover,.panel-menu a:focus-visible { background:var(--preview); }
    .panel-menu [aria-current] { color:var(--violet); }
    .utility-back { color:var(--muted); }
    .wr-page { padding:12px 16px 28px;--muted:#6f6878;--meta:#6f6878; }
    :root[data-theme=dark] .wr-page { --muted:#b3adbf;--meta:#b3adbf; }
    h1 { font-size:18px;line-height:24px;letter-spacing:-.4px;font-weight:550;margin:14px 0 18px; }
    h2,h3 { font-weight:500; }
    .wr-status,.beta-status,.status-line { font-size:12px;line-height:19px;color:var(--muted);overflow-wrap:anywhere;margin:8px 0; }
    .wr-status:empty,.beta-status:empty,.status-line:empty { display:none; }
    [data-variant=error],.danger,.danger-text { color:var(--error); }
    .wr-help,.wr-muted,.beta-help { font-size:11px;line-height:17px;color:var(--muted);overflow-wrap:anywhere; }
    .wr-inline { display:flex;gap:12px;align-items:center;flex-wrap:wrap; }
    .view-control > summary .wr-icon { width:13px;height:13px; }
    .view-control[open] > summary .icon-caret-down,.content-entry[open] > summary .icon-caret-down,.settings-group[open] > summary .icon-caret-down,.setting-detail[open] > summary .icon-caret-down { transform:rotate(180deg); }
    .content-entry-caret { width:15px;height:15px; }
    .content-entry-body h2 { font-size:12px;line-height:18px;color:var(--muted);margin:0 0 8px; }
    input,textarea,select { color:var(--ink);caret-color:var(--violet); }
    textarea { font:inherit; }
    .beta-field { display:flex;flex-direction:column;gap:7px;margin:12px 0;font-size:12px;line-height:18px; }
    .beta-field input,.beta-field select,.beta-field textarea { width:100%;min-width:0;border:1px solid var(--preview-line);border-radius:5px;padding:8px 10px;background:var(--field-surface);font-size:12px; }
    .beta-toggle { display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;font-size:12px;line-height:18px; }
    .beta-toggle input { order:2; }
    .beta-settings-root .beta-card { border:0;padding:0;background:none;box-shadow:none;scroll-margin-top:44px; }
    .beta-card > h2 { display:none; }
    .wr-settings-group { padding:10px 0 14px; }
    .wr-setting-feedback { font-size:11px;line-height:17px;color:var(--violet); }
    .beta-settings-root button { margin-top:8px; }
    .beta-settings-root #beta-settings-status { margin:12px 0; }
    .beta-settings-root .setting-detail-body { padding-bottom:14px; }
    .wr-setting-summary { display:block;font-size:12px;line-height:18px;color:var(--muted);margin-top:3px;font-weight:400; }
    .wr-model-download { border-bottom:1px solid var(--preview-line); }
    .wr-model-download > summary { display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;font-size:13px;line-height:19px; }
    .wr-model-download > summary > span:first-child { min-width:0;overflow-wrap:anywhere; }
    .wr-model-download small { display:block;margin-top:4px; }
    .wr-model-download[open] > summary > .wr-icon { transform:rotate(180deg); }
    .wr-model-download-body { padding:0 0 12px; }
    .wr-model-download-body p { white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 8px; }
    .wr-browser-transfer { padding:12px 0 16px;border-bottom:1px solid var(--preview-line); }
    .wr-browser-transfer > p:first-child { font-size:13px;margin:0 0 6px;overflow-wrap:anywhere; }
    .wr-browser-transfer progress { display:block;width:100%;height:5px;margin:12px 0;accent-color:var(--violet);border:0; }
    .wr-browser-transfer progress::-webkit-progress-bar { background:var(--preview-line);border-radius:3px; }
    .wr-browser-transfer progress::-webkit-progress-value { background:var(--violet);border-radius:3px; }
    .beta-search-results { padding:0; }
    .beta-result-card { border-bottom:1px solid var(--line); }
    .beta-result-card > details > summary { padding:9px 10px; }
    .beta-result-card .content-entry-body > p { font-size:13px;line-height:19px;margin:0; }
    .wr-match-details { font-size:11px;color:var(--muted);margin-top:12px; }
    .wr-match-details p { margin:4px 0; }
    .wr-match-details summary { display:inline-flex;align-items:center;gap:5px;padding:6px 0; }
    .wr-match-details .wr-icon { width:12px;height:12px; }
    .wr-match-details[open] .wr-icon { transform:rotate(180deg); }
    .highlight-source > .wr-icon { position:absolute;top:25px;right:0;color:var(--muted); }
    .highlight-source:hover > .wr-icon { color:var(--violet); }
    .beta-search-form { margin:0; }
    .beta-search-form input { width:100%;border:0;outline:0;padding:0;background:none;height:100%;font-size:14px; }
    .beta-search-form button { flex-shrink:0; }
    #beta-search-submit { display:none; }
    #beta-ask-host { margin:0 -4px 12px;padding:12px 14px;background:var(--preview);border-radius:7px; }
    .content-entry-body #beta-ask-host { margin:14px 0 0;padding:0;border-top:1px solid var(--preview-line);border-radius:0; }
    .wr-ask-header { display:flex;align-items:center;gap:8px;justify-content:space-between;border-bottom:1px solid var(--preview-line);padding-bottom:8px;margin-bottom:12px;font-size:13px;font-weight:500; }
    .wr-ask-scope { font-size:12px;color:var(--muted);font-weight:400; }
    .beta-ask-form { display:flex;flex-direction:column;gap:10px;margin:0; }
    .wr-composer { display:flex;align-items:flex-end;gap:8px;border:1px solid var(--preview-line);border-radius:6px;padding:5px 6px 5px 9px;background:var(--field-surface); }
    .wr-composer:focus-within { border-color:var(--violet); }
    #beta-ask-input { flex:1;min-width:0;resize:vertical;max-height:160px;min-height:28px;height:28px;background:none;border:0;outline:0;padding:4px 0;font-size:12px;line-height:20px; }
    .beta-ask-options { font-size:11px;color:var(--muted);border-top:1px solid var(--preview-line);padding:10px 0; }
    .beta-ask-options label { display:flex;align-items:center;gap:8px;margin:6px 0; }
    .beta-ask-options input[type=number] { width:80px; }
    .beta-ask-actions { display:flex;gap:14px;align-items:center;justify-content:flex-end; }
    .beta-ask-answer { font-size:13px;line-height:20px;margin:12px 0;overflow-wrap:anywhere; }
    .beta-ask-answer[data-streaming=true] { white-space:pre-wrap; }
    .beta-ask-answer p { margin:0 0 10px; }
    .beta-ask-answer a { font-size:11px;color:var(--violet);padding:1px 4px;background:var(--mark);border-radius:3px; }
    .beta-ask-answer pre,.beta-ask-answer code { white-space:pre-wrap;overflow-wrap:anywhere; }
    .beta-ask-answer ul,.beta-ask-answer ol { padding-left:20px; }
    .beta-ask-sources .beta-result-card { border:0;margin-bottom:8px; }
    .beta-ask-sources .content-entry { padding:0;background:none; }
    .beta-ask-sources .content-entry > summary { padding:5px 0;font-size:12px; }
    .beta-ask-sources .result-title { font-size:12px; }
    .beta-ask-sources .content-entry-body { font-size:12px;line-height:19px; }
    #beta-ask-activity,.wr-ask-options { font-size:11px;color:var(--muted);margin:8px 0; }
    .beta-ask-log { max-height:180px;overflow:auto;font-size:11px;line-height:18px; }
    .wr-source-chooser { padding:10px 0;font-size:12px; }
    .wr-source-chooser label { display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--preview-line); }
    .wr-source-chooser small { display:block;color:var(--muted);font-size:11px; }
    #beta-capture-setup { margin:16px 0; }
    #beta-capture-setup h2 { font-size:14px; }
    #beta-queue-section { font-size:12px;margin-top:14px; }
    #beta-queue-section > summary { color:var(--muted);padding:8px 0; }
    #beta-capture-status { color:var(--ink); }
    #beta-capture-status ul { padding:0;list-style:none; }
    #beta-capture-status li { display:flex;justify-content:space-between;gap:10px;padding:8px 0; }
    #beta-capture-status li > span { flex:1;min-width:0;overflow-wrap:anywhere; }
    #beta-capture-status li > button { flex:none;align-self:start;white-space:nowrap; }
    .wr-row-progress { display:block;font-size:11px;margin:6px 0; }
    .manage-actions { display:flex;gap:12px;align-items:center; }
    .manage-title { display:flex;justify-content:space-between;align-items:baseline;gap:12px; }
    .forget-scope-form { display:grid;gap:12px;padding:12px 0; }
    .forget-scope-form input { min-width:0;max-width:65%; }
    .forget-scope-form .field-note { color:var(--ink); }
    .wr-storage-block + .wr-storage-block { border-top:1px solid var(--preview-line);margin-top:14px;padding-top:14px; }
    .wr-storage-block h2 { font-size:13px;line-height:19px;font-weight:550;margin:0 0 8px; }
    .wr-storage-row { display:flex;justify-content:space-between;align-items:center;gap:12px; }
    .wr-storage-row .field-note { margin:0;overflow-wrap:anywhere; }
    .wr-storage-row .text-button { flex-shrink:0;min-height:30px; }
    #settings-storage :is(.wr-storage-row, .button-row, .backup-key-entry) button { margin-top:0; }
    #settings-storage .status-line:empty { margin:0; }
    #settings-storage .beta-toggle input { margin:0; }
    #manage-folder-backup { margin-top:14px; }
    .wr-folder-options .compact-setting { margin:0 0 8px; }
    #manage-import-label { position:relative;overflow:hidden; }
    #manage-import { position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer; }
    #manage-import-label:focus-within { outline:2px solid var(--violet);outline-offset:3px; }
    #manage-select-row { font-size:12px;padding:10px 0; }
    #manage-rows.is-selecting .content-item { padding-left:26px; }
    #manage-rows:not(.is-selecting) .memory-selection { display:none; }
    #logs-list pre { white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:18px;margin:0; }
    .wr-visually-hidden:not([data-variant=error]) { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap; }
    .beta-result-card .result-snippet { display:block; }
    .beta-result-card details[open] > summary .result-snippet { display:none; }
    .beta-result-card > .content-entry > summary > .content-entry-caret { top:20px;bottom:auto; }
    .wr-ask-question { font-size:13px;line-height:20px;font-weight:500;margin:12px 0; }
    .wr-ask-turn { padding-bottom:16px;margin-bottom:16px;border-bottom:1px solid var(--border); }
    .wr-item-ask-state:not(:empty) { display:block;margin-top:4px;color:var(--accent); }
    .preview-toggle { margin-bottom:8px; }
    .content-entry-body:has(> #beta-ask-host:not([hidden])) > .preview-toggle { display:none; }
    .content-entry-body:has(> #beta-ask-host:not([hidden])) > .wr-help { display:none; }
    .wr-ask-options > summary { padding:5px 0; }
    .wr-source-chooser { max-height:300px;overflow:auto; }
    .tool-disclosure > summary > .wr-icon { margin-left:auto;color:var(--muted); }
    .tool-disclosure[open] > summary > .icon-caret-down { transform:rotate(180deg); }
    .setting-detail > summary > .wr-icon,.settings-group > summary > .wr-icon { color:var(--muted); }
    .wr-refresh-recents { margin-top:14px; }
    .beta-search-results > .beta-result-card { margin-inline:4px; }
    .beta-search-results > .beta-result-card .source-meta { font-size:12px; }
    .source-meta .wr-icon { width:14px;height:14px; }
    .content-entry-body:has(> #beta-ask-host:not([hidden])) > p,.content-entry-body:has(> #beta-ask-host:not([hidden])) > .preview-actions,.content-entry-body:has(> #beta-ask-host:not([hidden])) > .wr-match-details { display:none; }
    .content-entry-body #beta-ask-host { margin:0;border:0; }
    #beta-ask-status[data-state=ready] { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%); }
    .beta-ask-form { display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;row-gap:8px; }
    .wr-composer { grid-column:1/-1; }
    #beta-ask-input { resize:none; }
    .wr-ask-options { margin:0;min-width:0; }
    .wr-ask-options[open] { grid-column:1/-1; }
    .beta-ask-actions { align-self:start;padding-top:5px; }
    .beta-ask-actions .text-button { font-size:11px; }
    #settings-advanced .beta-field:has(input[type=number]),#settings-advanced .beta-field:has(select),#settings-appearance .beta-field { display:grid;grid-template-columns:minmax(0,1fr) 145px;gap:12px;align-items:center; }
    #settings-advanced input[type=number] { width:82px;justify-self:end; }
    #settings-advanced .beta-field > p { grid-column:1/-1;margin:0; }
    #settings-appearance select { width:145px; }
    .wr-remote-notice { padding:8px 16px;font-size:11px;line-height:17px;color:var(--error);border-bottom:1px solid var(--line); }
  `;
  document.head.append(style);
}

export function relativeDate(timestamp: number): string {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
