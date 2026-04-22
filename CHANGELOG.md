Changelog
=========

All notable changes to this project are documented in this file.
This project adheres to Semantic Versioning. Prior to 1.0.0, minor versions may include breaking changes.

0.2.0 - 2026-04-06
------------------
- Added a full sidepanel workflow for Search, Ask, and Settings so captured pages can be searched, queried, and configured without leaving the current tab.
- Added dedicated Manage, Highlights, and Logs pages for reviewing saved pages, re-embedding content, browsing daily highlights, and inspecting extension activity.
- Added in-browser embeddings as an option alongside Ollama, including download/status feedback and automatic fallback behavior when the browser model is unavailable.
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
