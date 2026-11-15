Changelog
=========

All notable changes to this project are documented in this file.
This project adheres to Semantic Versioning. Prior to 1.0.0, minor versions may include breaking changes.

0.2.2 - Unreleased
------------------
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
