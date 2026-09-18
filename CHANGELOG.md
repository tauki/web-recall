Changelog
=========

All notable changes to this project are documented in this file.
This project adheres to Semantic Versioning. Prior to 1.0.0, minor versions may include breaking changes.

0.2.0 - Unreleased
------------------
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
