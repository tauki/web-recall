Changelog
=========

All notable changes to this project are documented in this file.
This project adheres to Semantic Versioning. Prior to 1.0.0, minor versions may include breaking changes.

0.3.0
-----
- Show the same outlined black-and-white icon in the Chrome toolbar and Extensions page, with the existing toolbar pause badge.
- Match the Chrome outline in the Mac companion’s app and menu-bar icons.
- Save and restore encrypted backup files with a copyable recovery key, including opt-in daily backups to a folder chosen in the Mac companion. Keep three verified copies by default, with configurable retention, and leave older unencrypted backups untouched.
- Save the daily backup toggle and retention count automatically when changed.
- Export all, filtered, or selected saved pages as Markdown or JSON, separately from full backups. Reject mixed-revision backup and export files if the library changes during the transfer.
- Move saved pages, history, text search and queued work from IndexedDB into a single local SQLite library. Verify existing records before activating the copy; retire old records, report missing active storage rather than replacing it, and do not re-embed on upgrade.
- Put storage and backup controls in Settings, with shortcuts from Memory Manager and a direct restore link when the library is missing. Group bulk embedding and summary work under Maintenance.
- Restore a missing saved library from a user-confirmed backup. Activate the replacement only after the full backup verifies; do not replace an existing file or expose an interrupted restore as the library.
- Show the empty state in Memory Manager only after the saved-page list loads successfully.
- Refresh Memory after a stopped or failed backup import so already restored pages are visible without reopening.
- Keep keyboard focus on the next step after choosing manual capture and saving the first page, without interrupting other work.
- Open the side panel from its shortcut or Chrome context menu without losing the user gesture.
- Keep the capture shortcut on the triggering tab even if another tab becomes active.
- Return a consistent capture queue snapshot while indexing runs, without sending saved page bodies or recovery data to the views.
- Retry only the current failed capture job; overlapping retries cannot restart an active attempt or restore a page that was deleted while retrying.
- Notify open views when the capture queue changes without rereading and broadcasting saved page content on every transition.
- Show pending save and durable confirmation in an empty library, and keep capture or retry feedback visible across background refreshes until the next explicit search or refresh.
- Distinguish cached browser-model files from verified readiness after restart. Never trust a persisted ready flag; verify explicit downloads through a fresh cache-only load before reporting success, and keep cached-file failures separate from saved page data.
- Search all saved text and retained versions inside the SQLite worker, without moving page bodies or vectors into the background process. Use a bounded search index to avoid opening unrelated text; preserve Stop, scoped search and original saved passages even if derived search data needs to be rebuilt.
- Recheck search-result identities and capture dates against the text-only view instead of cloning embedding vectors. Preserve result order and historical ambiguity checks, and prevent a late offscreen reply from starting another storage read after Stop.
- Keep whole-library text search independent from stored embedding vectors. Maintain its lightweight text records in the same durable transactions as captures, restores and history changes; upgrade existing libraries without re-embedding or recapturing pages.
- Rank meaningful words above common prose and word fragments while preserving literal partial and quoted lookup. Show dense multiword passages in results and the saved reader instead of jumping to an isolated word in a captured heading.
- Guide first use through saving, finding and reading saved text before optional AI setup. New installations keep automatic AI off; upgrades preserve prior model behavior and preferences. Stop automatic capture enrichment, queued summaries and Search refinement on opt-out without cancelling explicit Ask or manual maintenance. Discover providers only when Models is opened.
- Explain in Ask that automatic AI is off but questions still need a chat model. Keep retrieved pages visible when a response cannot be generated without claiming the model sent an empty reply.
- Start with chat disabled on new installations. Hide Ask and stop active questions when chat is disabled, without changing saved pages, embedding settings, or configured provider details.
- Make the saved reader the primary action in page previews and label the separate live-page link.
- Show an on-demand browser storage estimate in Memory tools, explain version retention and browsing-history independence, and link directly to scoped forgetting. Keep storage failures separate from page operations and refresh visible estimates after library changes.
- Stream large retained histories in framed backups, preserving previous import formats and optional metadata. Validate the whole file before restore, replace complete pages atomically, expose Stop, and report interrupted or uncertain transfers honestly. Fence active and queued model work against same-identity restores without changing saved version IDs.
- Preserve headings, lists, code and tables in visible saved content; identify omitted embedded and collapsed content, and report unsupported PDF or embedded-only captures explicitly.
- Retain the latest five content versions plus explicitly kept older versions. Keep imported history protected until released, distinguish recapture from re-indexing, and provide a saved-history reader with Keep, Release and individual removal.
- Carry saved-version identities through search, reranking, Ask and source references so recaptures cannot silently substitute newer text for earlier evidence.
- Search retained earlier text without a model, group each page to its best matching snapshot, and apply site/date filters to the matched version. Recheck unavailable versions after refinement and reject ambiguous legacy capture times.
- Add manual-only capture setup, quick pause/resume and site exclusion from the panel menu. Exclusions keep existing saves; forgetting does not exclude future saves.
- Forget only reviewed versions matching a site/date scope, including kept versions, while preserving other captures of the same page. Promote the newest remaining version when needed, recheck frozen identities and dates transactionally, and cancel only matching indexing/summary work after commit. Failed removal leaves active work intact.
- Stop active summary and re-embedding work after whole-page Delete or individual historical Remove commits. Use the exact removed snapshots so retained or newly captured versions keep running; Keep and Release never cancel inference.
- Clear obsolete capture-indexing failures after successful Memory re-embedding, without clearing newer jobs. Keep concurrent page/job revisions distinct even when writes share a clock millisecond.
- Save page text and its indexing job in one durable transaction before acknowledging capture. Index in the background, preserve newer captures against late writes, cancel forgotten work, and retain actionable indexing errors with Retry while saved text remains searchable.
- Distinguish saving, saved text, waiting/indexing, indexed and failed indexing in the panel and Memory Manager. Recheck current site rules for queued, recovered and retried work without treating paused automatic collection as a block on indexing already-saved pages.
- Require foreground visibility and a fresh dwell before automatic capture; discard stale eligibility replies after navigation or switching away. Explicit exclusions override allowlists across manual and automatic capture. Manual capture reports the background confirmation or actual failure.
- Show whole-library text matches before optional model-based search refinement. Search saved URLs and quoted phrases, preserve older exact matches, and retain visible text results when refinement is stopped or fails.
- Filter saved-page search by site and capture dates, including browsing a filtered library without entering keywords. Apply the same scope to text results and optional semantic refinement.
- Read full saved captures without opening the live website or running a model, highlight the matched passage, and show capture time. Retained historical captures remain readable; unavailable captures fail explicitly instead of silently substituting newer text.

0.2.3 - Unreleased
------------------
- Keep blocking companion socket accept/read loops off Swift's cooperative task pool while preserving ordered MainActor request handling. Exercise idle and concurrent clients with single-worker scheduling in CI, and bound only the CI test step to ten minutes; model inference still has no automatic deadline.
- Restrict embedding/summary backfill and cancellation to trusted extension UI senders, including individual summary jobs sharing the backfill registry.
- Recheck Private Cloud Compute consent after saved-memory tools finish, withholding newly retrieved text if consent was revoked while a tool was running.
- Preserve literal backslashes and incomplete Unicode escape boundaries in streamed Ask drafts without clearing already decoded text.
- Map case-insensitive Unicode search matches back to original saved-text offsets so previews and follow-up passage reads reach the actual evidence.
- Show session-cached recents while refreshing immediately when the sidepanel becomes visible. Read bounded metadata-only index pages instead of the whole library, lazy-load older recents while scrolling, and invalidate cached snapshots after deletion or restore without changing saved content or vectors.
- Keep updater controls only in the companion dashboard, show them inline without a Details disclosure, and use a stable update-check button and status area without a Cancel check control. Clarify Refresh model status separately from app updates.
- Keep Web Recall's right-click menu available on selections, links, media, editable fields and frames. Capture this page saves the current tab, even when automatic capture is paused, while respecting domain rules.
- Simplify the companion menu: keep model and version details in the dashboard, shorten its tooltip to status, and label its entry Open dashboard.
- Add dependency-free companion updates from signed GitHub releases: pinned Ed25519 metadata, archive and app verification, atomic replacement, startup confirmation, rollback and relaunch. Keep automatic updates opt-in, drain existing inference without a deadline, and sign companion release assets in CI with a dedicated updater key.
- Preserve capture opt-in and declared defaults when loading partial saved settings. Retire misleading calibration weights in favor of the explicit source and context budgets, and preserve fused retrieval ranking when Ask combines searches.
- Give explicit summary requests priority over automatic work, cancel superseded inference without deadlines, and settle cancelled queued jobs promptly. Summarize pages that fit in one pass; retain whole-page section reduction for longer pages and atomic stale-content checks without rereading vectors every pass.
- Dispose invalidated per-page Ask subscriptions while retaining ongoing conversations during normal navigation. Preserve Memory refresh errors after successful summary regeneration and clear stale companion readiness after failed availability checks.
- Stop writing duplicate embedding/highlight caches; preserve existing legacy stores until explicit deletion. Fetch only selected records for individual backfill and shortlisted chunk scoring, and remove unused summary-model settings, provider stubs and the placeholder WASM seam.
- Remove the superseded native passage-tool stack; Apple Ask uses only the canonical browser-owned tool bridge. Version the cleaned native protocol as 2 and prompt users to update older companions before generation. Keep native regression tests before extension packaging; assemble, sign and package the companion app only for release tags.
- Identify Apple Foundation Models safety blocks explicitly in Ask and its activity log instead of suggesting a generic failure or Settings fix. Keep other provider errors and explicit cancellation unchanged.
- Do not report a missing summary when an older background response omits summary metadata. Refresh Memory after summary completion and ignore stale page-list responses that arrive after a newer refresh.
- Keep per-page embedding failure reasons visible when later summary work succeeds, including when progress events are missed. Show summary availability in Memory and record automatic capture embedding/summary outcomes separately in Logs.
- Keep the Models summary, provider fields and status aligned with the saved chat provider regardless of whether settings or provider details load first; do not mislabel Apple chat as Ollama while provider metadata is pending.
- Exempt local library and browser-model storage from Chrome eviction with `unlimitedStorage`. Request strict durability for saved pages, summaries, migrations and capture jobs; report aborted writes and initialization failures instead of silently continuing or leaving operations pending.
- Add Regenerate summary to individual Memory items. It replaces only that page's summary, never runs embedding backfill, exposes Stop summary while working, and retains saved data on failure or cancellation.
- Build whole-page summaries from independent section notes, balanced bounded reductions and a final overview anchored to the title and opening context. Add explicit summary regeneration in Memory backfill; defaults still reuse existing summaries, and failed or stale replacements leave saved data intact.
- Individual Memory Re-embed also creates that page's summary if missing after the embedding update, independently of the bulk backfill checkbox. Existing summaries remain unchanged.
- Generate compact background summaries after capture using the selected chat provider, reuse them for unchanged content, and invalidate them when saved text changes. Prefer saved summaries in previews, retaining raw text when inference is unavailable. Add opt-in missing-summary creation after embedding backfill, including already-embedded pages, with progress and cancellation.
- Keep individual-page Ask requests running when browsing another item, with independent streaming, Stop controls and Answering/Answer ready indicators. Show compact saved-text previews with Show more/Show less instead of a long clipped paragraph.
- Keep earlier Ask turns visible during follow-ups, clear the composer immediately on send, and compact longer conversations without deleting their visible history. Preserve source IDs across turns and keep each page selection's context separate.
- Preserve complete short saved passages instead of clipping them to a retrieval snippet, and focus conversation compaction on the current follow-up so relevant earlier facts remain available.
- Share browser-owned, scoped saved-memory tools between Ollama and Apple. Load pages on demand, bound passage reads, return continuation arguments, expose correlated tool activity and run states, and enforce the same per-call allowance.
- Preserve actual cached tool results, allow failed calls to retry, retain Ollama continuation fields, and distinguish insufficient evidence from failed generation. Render Apple citations from structured source IDs rather than relying on citation punctuation in generated prose.
- Compact research context and continue with saved evidence when needed; finalize without tools when the call allowance is exhausted or recovery remains stalled. Detect repeated reads across different tools, retain explicit Stop, and do not add an inference deadline or automatically re-embed saved pages.
- Reuse the extension mark in the Mac menu bar, show the reported Apple model and companion version, and provide actionable Chrome native-host setup errors.
- Finish Apple answers from already-read saved evidence when a native tool reaches its context or reading budget, preserving citations and Stop instead of aborting the whole answer.
- Add a Mac menu-bar companion with live status and hover text, a small operational dashboard, Pause/Resume, Stop, Quit, and opt-in launch at login. Keep browser data in Chrome and communicate through a private local socket; quitting never silently restarts the app.
- Add an optional Apple Foundation Models Mac proof of concept: Swift Native Messaging helper, streamed page-scoped Ask, saved-source citations, explicit Stop, and bounded read-only passage tools.
- Detect model context size at runtime, keep browser embeddings and saved vectors unchanged, and make Private Cloud Compute an explicit off-by-default choice requiring an eligible, entitled helper.
- Restrict model-operation messages to extension UI pages; native-app access is an optional permission requested when selecting Apple.

0.2.2 - Unreleased
------------------
- Keep first-run capture choices visible independently of the idle queue, and preserve keyboard focus and expanded metadata when new log entries arrive.
- Bring the compact design to Search, inline saved-page previews, contextual Ask, Settings, Memory Manager, Highlights and Logs, with shared navigation and locally bundled Inter and Phosphor assets.
- Remove the duplicate sidepanel title, use the available width, and keep the capture queue hidden while idle unless opened from Menu. Show active and failed work with retry controls.
- Keep page-scoped Ask, follow-ups, retrieval tools and citations within the selected saved URLs, retrieving question-matching passages even with tools disabled, with cancellation and stale-response protection when the selection changes.
- Preserve the real capture, settings, backup, embedding, highlights and log handlers behind the redesigned pages; give empty memory direct capture and setup actions.
- Add downloaded browser model inventory with pinned revisions, file counts, estimated sizes, selected-model state and explicit Use/Remove controls. Removal preserves saved pages and vectors.
- Require an explicit browser model download when files are missing. Show per-file download progress, a separate preparation state, cancellation and retry with completed cached files retained.
- Restore active download controls when Models is reopened, ignore stale status reads after newer progress updates, serialize model loading and inference, wait for cleanup before removal, and prevent stale model work from marking a different selection ready.
- Apply the selected faceted interlocking mark across toolbar icons, extension management, favicons and in-page branding, with transparent PNG exports verified at actual toolbar sizes.
- Clear recovered log refresh errors, preserve keyboard focus through navigation, and add regression coverage plus an isolated preview for non-LLM flows and browser model controls.

0.2.1 - Unreleased
------------------
- Wait for pending capture admissions before restoring or deleting pages, including delayed retry lookups; keep later captures working normally.
- Restore complete backup records instead of merging destination summaries, history or embedding timestamps; omitted optional fields are cleared and explicit empty values are preserved.
- Recheck provider consent before every request and retry, and reject redirects before data can reach another endpoint. Direct endpoints and transient-error retries remain supported.
- Cancel old capture work atomically with page restoration; reject malformed backup fields before normalization without rejecting legitimate empty captures or legacy migrations.
- Serialize configuration saves and retain the last persisted settings after write failures. UI regressions now exercise production runtime error handling.
- Capture only rendered page text, preserving headings and code while excluding hidden content without modifying the page.
- Apply the same domain rules and content-script recovery to manual capture from the sidepanel, keyboard and context menu; pause still permits manual capture.
- Prevent failed older captures from overwriting newer queued content, and preserve debug log levels through storage and filtering.
- Stream versioned single-file backups and validate them before restore, retaining legacy JSON import support. Large libraries and historical captures beyond legacy import limits are supported; individual backup records are bounded to 16 MiB.
- Preserve article headers, code blocks, and inline code when capturing page text.
- Require acknowledgement before saving or contacting remote model providers, including embedding endpoints; keep unacknowledged provider settings readable for review and correction.

0.2.0 - Unreleased
------------------
- Report Ollama HTTP failures and origin configuration guidance instead of misleading incomplete-vector errors; retry only transient failures and preserve saved vectors.
- Remove automatic inference and Ask tool deadlines, add Stop to Search and embedding backfill, retain Ask cancellation, and keep the service worker active only while model work is pending.
- Add extension and toolbar icons in 16, 32, 48 and 128px sizes; include them in release ZIPs and reject missing or incorrectly sized declared icons during packaging.
- Migrate legacy pause, allowlist and denylist choices before capture resumes; preserve existing 0.2.0 settings and serialize partial updates to avoid lost changes.
- Preserve valid legacy captures and version history beyond external-import size limits, while keeping imported JSON bounded and validated.
- Retain saved vectors and model identity for unchanged chunks when recapture inference fails, including concurrent backfill results; changed chunks remain unembedded until inference succeeds.
- Preserve empty 0.1.0 captures during migration so failed legacy embeddings cannot block access to the library; keep import validation strict.
- Show the full library in Memory Manager so pages beyond the newest 500 remain available for filtering and maintenance.
- Migrate the 0.1.0 IndexedDB library once, preserving passages, vectors and version history; accept legacy JSON exports without silently discarding content. Retain the old database as an upgrade backup.
- Prevent processing transitions and retries from recreating deleted capture jobs.
- Keep fragment URLs and matched passages through Search and Ask, and combine text matches with semantic results during partial re-embedding.
- Use the same installed-model fallback in Settings and Ask; reserve chat health probes for explicit connection tests instead of sidepanel polling.
- Added pinned EmbeddingGemma 2 as a text-only WebGPU browser model option alongside the original WASM default. Switching models never starts a backfill; existing vectors are preserved until explicitly re-embedded.
- Updated Transformers.js to 4.3.1 and bundled its matching ONNX WASM assets for local extension execution.
- Updated the development and CI runtime to Node.js 24 LTS; newer Node versions are allowed.
- Fixed release packaging to build and include runtime bundles, with PR validation and artifact checks.
- Made memory deletion remove chunk text, embeddings and queued jobs, and invalidate highlights atomically.
- Restored interrupted capture jobs on service-worker startup; queue acceptance now waits for persistence.
- Made missing-only backfill preserve existing vectors, reject failed/stale updates and refresh retrieval.
- Fixed Ollama tool arguments, retained retrieved passages and stable source IDs through Ask, and restored streamed answers with a five-minute request deadline.
- Fixed switching browser embeddings back to Ollama and retrying failed browser model loads.
- Tagged new embeddings with their model space. Existing untagged vectors remain stored but require an explicit Re-embed to participate in semantic search; text fallback remains available.
- Switched toolbar toggling to Chrome's native behavior and corrected lifecycle events. Minimum Chrome is now 142; no permissions or host permissions were added.
- Added deterministic regression checks for persistence, backfill, recovery, provider switching, references and streaming.
- Added Stop/Clear to Ask, cancelled provider requests on Stop, and prevented stale responses from replacing newer results.
- Rendered a safe subset of answer Markdown with clickable source references; moved verbose activity into expandable history.
- Prioritized Search results, restored recents with Clear, and wrapped score details for narrow panels.
- Grouped Settings, showed only the selected embedding provider's fields, and clarified first-time model download actions.
- Added keyboard tab navigation, accessible control labels, consistent themed controls, and shared navigation across tools.
- Added per-page re-embed progress, explicit replacement controls, and exact-level log filtering with visible entry counts.

- Added a full sidepanel workflow for Search, Ask, and Settings so captured pages can be searched, queried, and configured without leaving the current tab.
- Added dedicated Manage, Highlights, and Logs pages for reviewing saved pages, re-embedding content, browsing daily highlights, and inspecting extension activity.
- Added in-browser embeddings as an option alongside Ollama, including download/status feedback and explicit failure reporting when the browser model is unavailable.
- Improved manual capture so `Capture current tab` works reliably even when the page was opened before the extension loaded, while still respecting allowlist and denylist rules.
- Improved capture controls with pause support, allowlist/denylist filtering, and clearer recovery flows for failed or queued captures.
- Improved Ask and Search with query rewriting, separate reranking controls, page-level sources, and tool-assisted answer generation.
- Added configurable chat and embedding settings, including provider connection testing, model refresh, answer mode, logging controls, and theme support.
- Added export/import and per-page maintenance tools so saved memory can be moved, cleaned up, and refreshed from the Manage page.

0.1.0 - 2025-10-01
------------------
- Initial public preview.
- Capture visible page text with whitelist/blacklist rules and pause toggle.
- Local embeddings via Ollama `/api/embed`; chat and summarization via `/api/chat`.
- Side panel: semantic search, Ask with optional tools.
- IndexedDB storage with daily highlights cache.
- Memory Manager for browse/delete/export/import and summary backfill.
- Debug Logs viewer and configurable logging.
- Provider Settings for Ollama base URL with connectivity test; keyboard shortcut and context menu actions.
