// Shared visual system from the approved Web Recall prototype.
export const DESIGN_STYLES = `

:root {
  font-family: 'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  color: var(--ink); background: var(--page); font-synthesis: none; font-size: 14px; color-scheme: light;
  --ink: #242429; --muted: #777780; --meta: #77737f; --violet: #7354b1;
  --page: #fbfbfa; --surface: #fff; --header: #f2f1f4; --line: #e5e5e9;
  --preview: #f3f0f9; --preview-line: #d9d1e6; --hover: #f5f4f7; --mark: #e5d7fa;
  --sticky-surface: #fbfbfaf5; --field-surface: #ffffffba; --error: #b42318;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --ink: #eeeaf4; --muted: #aaa3b3; --meta: #b3adbf; --violet: #b9a0eb;
  --page: #18181c; --surface: #242429; --header: #212126; --line: #37323e;
  --preview: #272330; --preview-line: #494052; --hover: #25222b; --mark: #554271;
  --sticky-surface: #18181cf5; --field-surface: #242429; --error: #fca5a5;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 280px; -webkit-font-smoothing: antialiased; }
button, input, select { font: inherit; }
button, select, a { -webkit-tap-highlight-color: transparent; }
button, a, select { touch-action: manipulation; }
button { color: inherit; cursor: pointer; border: 0; background: none; padding: 0; }
button:disabled { cursor: default; }
a { color: inherit; text-decoration: none; }
button, a, input, select { outline-offset: 3px; }
:focus-visible { outline: 2px solid var(--violet); }
svg { flex-shrink: 0; vertical-align: middle; }
::selection { background: #e2d4fa; }
.prototype-stage { width: 100%; min-height: 100dvh; }
.recall-panel { max-width: 480px; min-height: 100dvh; margin: 0 auto; }
.browser-header { position: sticky; top: 0; z-index: 6; height: 32px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; background: var(--header); }
.identity { display: flex; align-items: center; gap: 9px; font-size: 14px; font-weight: 600; letter-spacing: -.25px; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 5px; color: var(--muted); flex-shrink: 0; }
.icon-button:hover { background: var(--hover); color: var(--ink); }
.search-header { padding: 12px 16px 0; position: sticky; top: 32px; z-index: 5; background: var(--sticky-surface); backdrop-filter: blur(10px); }
.search-row { display: flex; gap: 10px; align-items: center; }
.search-form { display: flex; align-items: center; gap: 10px; height: 36px; min-width: 0; flex: 1; border: 1px solid var(--line); border-radius: 7px; padding: 0 9px 0 11px; color: var(--muted); background: var(--field-surface); transition: border-color 100ms ease; }
.search-form:focus-within { border-color: #9476cb; box-shadow: 0 0 0 1px #9476cb22; }
.search-form input { min-width: 0; width: 100%; padding: 0; border: 0; outline: 0; background: none; color: var(--ink); font-size: 14px; height: 100%; }
.search-form input::placeholder { color: var(--muted); }
.search-form .icon-button { width: 24px; height: 26px; }
.menu-anchor { position: relative; }
.app-menu-button { display: inline-flex; align-items: center; gap: 5px; min-height: 26px; padding: 0 3px; border-radius: 4px; font-size: 11px; color: var(--muted); }
.app-menu-button:hover, .app-menu-button[aria-expanded='true'] { color: var(--violet); background: var(--hover); }
.panel-menu { position: absolute; top: 35px; right: 0; z-index: 10; width: 211px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 28px #24242912; padding: 5px; }
.panel-menu button { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; font-size: 12px; border-radius: 4px; padding: 9px 7px; }
.panel-menu button:hover { background: var(--preview); }
.menu-divider { border-top: 1px solid var(--line); margin: 4px 6px; }
.results-toolbar { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
.ask-results { display: inline-flex; gap: 6px; align-items: center; color: var(--violet); font-size: 12px; font-weight: 500; padding: 6px 0; }
.ask-results:hover { text-decoration: underline; text-underline-offset: 4px; }
.about-prototype { display: flex; gap: 12px; align-items: flex-start; margin: 0 0 12px; padding: 9px 10px; border-left: 2px solid #c3b2df; color: #65616d; background: var(--preview); font-size: 12px; line-height: 1.5; }
.about-prototype p { margin: 0; }
.about-prototype .icon-button { width: 18px; height: 20px; }
.results-list { padding: 0 12px 24px; }
.result { position: relative; margin: 0 4px; padding: 8px 10px 6px; border-bottom: 1px solid var(--line); }
.result:not(.is-expanded):hover { background: var(--hover); }
.result.is-expanded { margin: 0 0 12px; padding: 12px 14px; border: 0; border-radius: 7px; background: var(--preview); }
.preview-toggle { position: relative; display: block; width: 100%; text-align: left; border-radius: 3px; }
.preview-toggle:focus-visible { outline-offset: 5px; }
.source-meta { display: flex; align-items: center; gap: 7px; color: var(--meta); font-size: 12px; line-height: 16px; padding-right: 11px; }
.source-meta > svg { color: var(--muted); }
.source-meta > .note-icon { color: #8060b4; }
.source-icon { width: 14px; height: 14px; object-fit: contain; flex-shrink: 0; }
.source-icon[src$='web.svg'] { width: 15px; height: 15px; }
.domain { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.metadata-dot { margin: 0 -2px; }
.saved-date { flex-shrink: 0; white-space: nowrap; }
.result-title { display: block; font-size: 14px; line-height: 20px; letter-spacing: -.26px; font-weight: 500; margin-top: 2px; padding-right: 24px; }
.preview-caret { position: absolute; right: 0; top: 17px; color: var(--muted); }
.result:not(.is-expanded) .preview-caret { opacity: 0; }
.result:not(.is-expanded):hover .preview-caret, .preview-toggle:focus-visible .preview-caret { opacity: 1; }
.result-snippet { margin: 2px 0 0; color: var(--meta); font-size: 12px; line-height: 16px; }
.preview-body { margin-top: 9px; }
.passage { margin: 0; padding-top: 12px; border-top: 1px solid var(--preview-line); font-size: 13px; line-height: 19px; letter-spacing: -.2px; }
mark { background: var(--mark); border-radius: 3px; color: inherit; padding: 0 1px 1px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.preview-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-top: 14px; }
.open-page-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; color: #fff; background: #302d38; border: 1px solid #302d38; border-radius: 5px; padding: 6px 10px; font-size: 12px; line-height: 17px; }
.open-page-button:hover { background: #49404f; }
.ask-this-page { display: inline-flex; align-items: center; gap: 6px; color: var(--violet); font-size: 13px; font-weight: 500; min-height: 30px; }
.ask-this-page:hover { text-decoration: underline; text-underline-offset: 4px; }
.original-link { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; color: var(--muted); }
.original-link:hover { color: var(--violet); text-decoration: underline; text-underline-offset: 3px; }
.scope-toolbar { display: flex; align-items: center; justify-content: flex-start; gap: 6px; border-bottom: 1px solid var(--preview-line); padding-bottom: 6px; margin-top: -5px; }
.source-picker { position: relative; }
.source-picker-trigger { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; color: var(--muted); font-size: 12px; border-radius: 3px; }
.source-picker-trigger:hover { color: var(--violet); }
.sources-popover { position: absolute; top: calc(100% + 8px); left: 0; z-index: 4; width: min(350px, calc(100vw - 56px)); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 28px #24242918; padding: 12px; }
.sources-popover-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--ink); font-size: 12px; font-weight: 550; }
.sources-popover-heading .icon-button { width: 22px; height: 22px; }
.source-selection-toolbar { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 4px; font-size: 11px; color: var(--muted); }
.source-selection-toolbar button { color: var(--violet); padding: 4px 0; }
.source-options { max-height: min(330px, 48dvh); overflow-y: auto; overscroll-behavior: contain; }
.source-option { display: flex; align-items: center; gap: 9px; padding: 9px 2px; border-bottom: 1px solid var(--line); cursor: pointer; }
.source-option:hover { background: var(--hover); }
.source-option-text { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; font-size: 12px; line-height: 16px; }
.source-option-text small { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.source-option input { width: 14px; height: 14px; margin: 0 2px 0 4px; accent-color: var(--violet); cursor: pointer; flex-shrink: 0; }
.sources-popover-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; font-size: 10px; color: var(--muted); }
.sources-popover-footer button { font-size: 11px; color: var(--violet); font-weight: 500; padding: 5px 6px; border-radius: 4px; }
.sources-popover-footer button:hover { background: var(--preview); }
.back-to-passage { width: 23px; height: 20px; margin-left: auto; }
.back-to-passage:hover { background: var(--hover); }
.ask-intro { font-size: 13px; line-height: 20px; color: var(--muted); margin: 13px 0 14px; }
.exchange + .exchange { border-top: 1px solid var(--preview-line); padding-top: 12px; margin-top: 15px; }
.question { font-size: 13px; line-height: 19px; font-weight: 550; letter-spacing: -.24px; margin: 10px 0 8px; overflow-wrap: anywhere; }
.answer p { margin: 0; font-size: 13px; line-height: 19px; letter-spacing: -.19px; }
.answer p + p { margin-top: 10px; }
.citation { color: var(--violet); font-size: inherit; line-height: inherit; text-decoration: underline; text-underline-offset: 3px; border-radius: 2px; padding: 1px 2px; white-space: nowrap; }
.citation:hover, .citation.is-active { background: var(--mark); }
.citation-passage { margin: 8px 0 0; border-left: 2px solid #bba2e5; padding-left: 12px; }
.citation-heading { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 11px; line-height: 18px; gap: 8px; }
.citation-heading .icon-button { width: 21px; height: 18px; }
.citation-passage blockquote { margin: 3px 0 0; font-size: 12px; line-height: 18px; letter-spacing: -.18px; }
.citation-source { display: inline-flex; gap: 4px; align-items: center; font-size: 12px; color: var(--violet); margin: 3px 0 4px; }
.citation-source:hover { text-decoration: underline; }
.ask-form { display: flex; align-items: center; gap: 7px; padding: 3px; min-height: 32px; border: 1px solid var(--preview-line); border-radius: 6px; margin-top: 12px; background: var(--field-surface); }
.ask-form:focus-within { border-color: #9a7cc7; box-shadow: 0 0 0 1px #9a7cc71a; }
.ask-form input { min-width: 0; flex: 1; width: 100%; height: 24px; background: none; border: 0; outline: none; color: var(--ink); padding: 0 5px; font-size: 12px; }
.ask-form input::placeholder { color: var(--muted); }
.send-button { width: 24px; height: 24px; border-radius: 5px; color: #fff; background: var(--violet); }
.send-button:hover { color: #fff; background: #614294; }
.send-button:disabled { background: #e4dcee; color: #a28bbf; }
.starter-question { display: inline-block; color: var(--muted); font-size: 11px; line-height: 18px; margin: 8px 0 -3px; text-align: left; }
.starter-question:hover { color: var(--violet); }
.pending-reply > p { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; margin: 5px 0 0; }
.spinner { animation: spin 1s linear infinite; }
.results-conversation { padding-top: 16px !important; }
.results-conversation .scope-toolbar { margin-top: 0; }
.empty-state { padding: 48px 16px; text-align: center; color: var(--muted); }
.empty-state > svg { color: #a79bae; }
.empty-state h2 { font-size: 16px; font-weight: 500; color: var(--ink); margin: 14px 0 8px; }
.empty-state p { font-size: 13px; line-height: 21px; max-width: 260px; margin: 0 auto 16px; }
.text-button { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--violet); }
.utility-view { padding: 12px 16px 28px; --muted: #6f6878; --meta: #6f6878; }
:root[data-theme='dark'] .utility-view { --muted: #b3adbf; --meta: #b3adbf; }
.utility-back { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; font-size: 12px; color: var(--muted); }
.utility-back:hover { color: var(--violet); }
.utility-view h1 { font-size: 18px; line-height: 24px; font-weight: 550; letter-spacing: -.4px; margin: 14px 0 18px; }
.view-description { margin: 0 0 20px; font-size: 12px; color: var(--muted); line-height: 18px; }
.settings-section { border-top: 1px solid var(--line); padding: 15px 0; }
.settings-section h2 { font-size: 14px; font-weight: 550; margin: 0 0 12px; }
.settings-section > label { display: flex; flex-direction: column; gap: 7px; font-size: 12px; line-height: 18px; margin-top: 12px; }
.settings-section input:not([type='checkbox']), .settings-section select, .settings-section textarea { width: 100%; border: 1px solid var(--line); border-radius: 5px; padding: 8px 10px; color: var(--ink); background: var(--surface); font-size: 12px; }
.settings-section textarea { font: inherit; resize: vertical; min-height: 64px; }
.settings-section .check-setting { flex-direction: row; align-items: flex-start; gap: 12px; justify-content: space-between; margin-top: 0; }
.check-setting small { display: block; font-size: 11px; line-height: 17px; color: var(--muted); margin-top: 3px; }
.check-setting input { accent-color: var(--violet); width: 15px; height: 15px; flex-shrink: 0; margin-top: 2px; }
.field-note { font-size: 11px; color: var(--muted); line-height: 17px; margin: 10px 0 0; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
@media (max-width: 360px) {
  .browser-header { padding: 0 12px; }
  .search-header { padding-inline: 12px; }
  .results-list { padding-inline: 8px; }
  .result.is-expanded { padding-inline: 12px; }
}

/* Every view shares the same compact panel and control vocabulary. */
.recall-panel.tool-layout { max-width: 480px; }
.tool-layout .browser-header { padding-inline: 16px; }
.secondary-button { display: inline-flex; align-items: center; justify-content: center; min-height: 30px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--ink); font-size: 12px; line-height: 17px; cursor: pointer; }
.secondary-button:hover:not(:disabled) { background: var(--hover); }
.secondary-button:disabled, .text-button:disabled { opacity: .45; cursor: default; }
.tool-actions, .button-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.inline-check { display: inline-flex; gap: 7px; align-items: center; font-size: 12px; line-height: 18px; }
input[type='checkbox'] { accent-color: var(--violet); }
.inline-status { font-size: 12px; line-height: 19px; color: var(--violet); margin: 10px 0 14px; overflow-wrap: anywhere; }
.is-error, .danger-text { color: var(--error); }
/* Inline details reuse the Search/Ask surface, spacing, and source marks. */
.prototype-footnote { color: var(--muted); font-size: 11px; line-height: 17px; margin: 24px 10px 0; }
.primary-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; border-radius: 5px; padding: 6px 10px; font-size: 12px; line-height: 17px; color: #fff; background: #302d38; }
.primary-button:hover:not(:disabled) { background: #49404f; }
.primary-button:disabled { opacity: .45; }
.settings-group { border-bottom: 1px solid var(--line); scroll-margin-top: 44px; }
.settings-group > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 10px; cursor: pointer; list-style: none; border-radius: 5px; }
.settings-group > summary:hover { background: var(--hover); }
.settings-group summary::-webkit-details-marker, .setting-detail summary::-webkit-details-marker, .content-entry summary::-webkit-details-marker, .view-controls summary::-webkit-details-marker { display: none; }
.setting-group-title { display: block; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: -.2px; }
.setting-group-description { display: block; color: var(--muted); font-size: 12px; line-height: 18px; margin-top: 3px; }
.settings-group > summary > svg, .setting-detail > summary > svg { color: var(--muted); }
.settings-group[open] { background: var(--preview); border: 0; border-radius: 7px; margin: 0 -4px 8px; padding: 0 14px; }
.settings-group[open] > summary { padding-inline: 0; border-bottom: 1px solid var(--preview-line); border-radius: 0; }
.settings-group[open] > summary:hover { background: none; }
.settings-group[open] > summary > svg, .setting-detail[open] > summary > svg, .tool-disclosure[open] > summary > svg, .view-control[open] > summary > svg, .content-entry[open] > summary > svg { transform: rotate(180deg); }
.settings-section { border: 0; padding: 10px 0 14px; }
.settings-section label, .setting-detail-body > label { display: flex; flex-direction: column; gap: 7px; margin: 12px 0; font-size: 12px; line-height: 18px; }
.settings-section input:not([type='checkbox']), .settings-section select, .settings-section textarea { background: var(--field-surface); border-color: var(--preview-line); }
.settings-section .check-setting, .view-control .check-setting { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 14px; margin: 0; padding: 10px 0; font-size: 12px; line-height: 18px; }
.check-setting input { width: 15px; height: 15px; margin: 0; }
.compact-setting { display: flex !important; flex-direction: row !important; align-items: center; justify-content: space-between; gap: 12px !important; font-size: 12px; line-height: 18px; }
.compact-setting > span { min-width: 0; }
.compact-setting input[type='number'] { width: 82px; flex-shrink: 0; }
.compact-setting select { width: 145px; flex-shrink: 0; }
.setting-detail { border-top: 1px solid var(--preview-line); }
.setting-detail > summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 12px 0; font-size: 13px; line-height: 19px; }
.setting-detail > summary small { display: block; color: var(--muted); font-size: 11px; line-height: 17px; margin-top: 2px; overflow-wrap: anywhere; }
.setting-detail:first-child { border-top: 0; }
.setting-detail-body { padding: 0 0 14px; }
.setting-detail-body > .primary-button, .setting-detail-body > .button-row { margin-top: 14px; }
.setting-detail-body > .setting-detail { margin-top: 12px; }
.setting-detail-body .field-note { margin: 0 0 12px; }
.settings-section > .inline-status { margin-bottom: 0; }
.memory-search { margin-bottom: 0; }
.memory-search input::-webkit-search-cancel-button, .logs-search input::-webkit-search-cancel-button { display: none; }
.view-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 39px; color: var(--muted); font-size: 12px; }
.view-toolbar-actions { display: flex; align-items: center; gap: 14px; }
.view-toolbar .text-button { min-height: 30px; }
.view-controls { position: relative; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; column-gap: 16px; }
.view-control { display: contents; }
.view-control::details-content { display: contents; }
.view-control:not([open])::details-content { display: none; }
.view-control:not([open]) > .view-control-body { display: none; }
.view-control > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; min-height: 30px; font-size: 11px; color: var(--muted); order: 0; margin-bottom: 4px; }
.view-control > summary:hover { color: var(--violet); }
.view-control[open] > summary { color: var(--violet); }
.view-control-body { width: calc(100% + 8px); flex-shrink: 0; margin: 0 -4px 10px; order: 1; background: var(--preview); border-radius: 7px; padding: 12px 14px; }
.view-control-body input:not([type='checkbox']), .view-control-body select { background: var(--field-surface); color: var(--ink); border: 1px solid var(--preview-line); border-radius: 5px; padding: 7px 8px; font-size: 12px; }
.view-control-body .compact-setting { margin: 4px 0 8px; }
.view-control-body .field-note { margin: 0 0 12px; }
.maintenance-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; padding: 0 0 10px; }
.file-button { position: relative; overflow: hidden; }
.file-button input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-button:focus-within { outline: 2px solid var(--violet); outline-offset: 3px; }
.tool-disclosure { border-top: 1px solid var(--preview-line); }
.tool-disclosure > summary { list-style: none; display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; line-height: 18px; min-height: 40px; }
.tool-disclosure > summary > svg { margin-left: auto; color: var(--muted); }
.tool-disclosure-body, .embedding-tools { padding: 4px 0 14px; }
.embedding-tools .primary-button { margin-top: 4px; }
.muted-count { color: var(--muted); font-weight: 400; }
.queue-entry { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0 14px; }
.queue-entry strong { font-size: 12px; font-weight: 500; }
.queue-entry small { display: block; font-size: 11px; line-height: 18px; color: var(--muted); margin-top: 4px; }
.content-list { border-top: 1px solid var(--line); }
.content-item { position: relative; border-bottom: 1px solid var(--line); }
.content-entry > summary { position: relative; cursor: pointer; list-style: none; padding: 11px 10px; border-radius: 5px; }
.content-entry > summary:hover { background: var(--hover); }
.content-entry .source-meta { font-size: 11px; line-height: 16px; gap: 6px; }
.content-entry .result-title { margin-top: 3px; }
.manual-label { margin-left: auto; font-size: 10px; color: var(--muted); }
.content-entry-caret { position: absolute; right: 10px; bottom: 15px; color: var(--muted); }
.content-entry[open] { margin: 0 -4px 8px; padding: 0 14px 14px; background: var(--preview); border-radius: 7px; }
.content-item:has(.content-entry[open]) { border-bottom: 0; }
.content-entry[open] > summary { padding-inline: 0; border-radius: 0; }
.content-entry[open] > summary:hover { background: none; }
.content-entry[open] .content-entry-caret { right: 0; }
.content-entry-body { border-top: 1px solid var(--preview-line); padding-top: 12px; }
.memory-passage { font-size: 13px; line-height: 19px; margin: 0 0 14px; overflow-wrap: anywhere; }
.memory-facts { margin: 0; font-size: 11px; line-height: 17px; }
.memory-facts > div { display: grid; grid-template-columns: 94px minmax(0, 1fr); gap: 10px; margin: 7px 0; }
.memory-facts dt { color: var(--muted); }
.memory-facts dd { margin: 0; overflow-wrap: anywhere; }
.memory-facts a:hover { color: var(--violet); text-decoration: underline; text-underline-offset: 3px; }
.content-entry-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 16px; }
.memory-select-all { min-height: 34px; margin-bottom: 6px; }
.content-item.is-selecting { padding-left: 26px; }
.memory-selection { position: absolute; left: 3px; top: 25px; margin: 0; width: 14px; height: 14px; }
.view-control-body .secondary-button { border-color: var(--preview-line); }
/* Daily summaries and log details use the same inline row expansion as Memory. */
.view-control-note, .toolbar-note { color: var(--muted); font-size: 11px; line-height: 18px; }
.view-control-note { display: inline-flex; align-items: center; min-height: 30px; margin-bottom: 4px; }
.view-toolbar > .text-button { min-height: 30px; }
.highlights-filters { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; padding: 2px 0; }
.highlights-filters label { width: 100%; }
.highlights-filters input[type='date'] { width: 155px; min-width: 0; }
.highlights-filters input[aria-invalid='true'] { border-color: var(--error); }
.highlight-excerpt { display: block; color: var(--muted); font-size: 12px; line-height: 18px; margin-top: 6px; overflow-wrap: anywhere; }
.highlight-entry > summary { padding-block: 14px; }
.highlight-entry > summary .result-title { padding-right: 25px; }
.highlight-entry > summary .content-entry-caret { top: 35px; bottom: auto; }
.highlight-sources h2, .log-entry h2 { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--muted); margin: 0 0 8px; }
.highlight-source { display: block; position: relative; padding: 10px 24px 10px 0; }
.highlight-source + .highlight-source { border-top: 1px solid var(--preview-line); }
.highlight-source .result-title { font-size: 13px; line-height: 19px; padding-right: 0; }
.highlight-source > svg { position: absolute; top: 25px; right: 0; color: var(--muted); }
.highlight-source:hover .result-title, .highlight-source:hover > svg { color: var(--violet); }
.pagination { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-top: 16px; font-size: 11px; line-height: 18px; color: var(--muted); }
.pagination .text-button { min-height: 30px; }
.log-level { text-transform: uppercase; font-size: 10px; font-weight: 550; min-width: 36px; }
.level-warn { color: #805818; }
.level-error { color: var(--error); }
.log-entry pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 18px; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; tab-size: 2; }
.log-tool-actions { padding: 10px 0 14px; border-bottom: 1px solid var(--preview-line); }
.log-settings-link { margin-top: 14px; text-align: left; align-items: flex-start; line-height: 18px; }
.log-settings-link > svg { margin-top: 2px; }
.empty-tool-state { font-size: 13px; color: var(--muted); padding: 22px 0; }
:root[data-theme='dark'] .source-icon[src$='mdn.svg'], :root[data-theme='dark'] .source-icon[src$='chrome.svg'] { filter: invert(.85); }
:root[data-theme='dark'] .level-warn { color: #e5b77c; }
@media (max-width: 400px) {
  .utility-view { padding-inline: 16px; }
  .tool-layout .browser-header { padding-inline: 16px; }
  .tool-actions { gap: 6px; }
}
.result-title, .result-snippet, .passage, .answer, .citation-passage { overflow-wrap: anywhere; }
`;
