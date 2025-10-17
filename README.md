Web Recall
==========

Web Recall is a privacy‑preserving Chrome extension. It captures the visible
text of pages you visit, generates semantic embeddings locally via the Ollama
API, stores the results in your browser, and provides a side‑panel UI for
semantic search. You can also ask questions about what you’ve read using
retrieval‑augmented generation (RAG) powered by locally running models.

Directory contents
------------------

- `manifest.json`: MV3 manifest. Permissions include `activeTab`, `storage`,
  `scripting`, `tabs`, `offscreen`, `contextMenus`; host permissions cover
  `http://localhost:11434/*`, `http://127.0.0.1:11434/*`, and `<all_urls>` for
  provider tests/page-scope operations. Default action opens the side panel.
- `background.js`: Service worker handling capture queue, embeddings/chat,
  IndexedDB storage, search/Ask/highlights, provider status, and settings.
- `content.js`: Top-level content script that extracts readable text, chunks it,
  respects allow/deny rules, and sends `SAVE_PAGE` payloads to background.
- UI surfaces:
  - `sidepanel.html/js`: search, Ask (with tools), highlights trigger, settings.
  - `manage.html/js`: memory manager (browse/delete/backfill/export/import).
  - `highlights.html/js`: daily highlights dashboard with cache backfill.
  - `logs.html/js`: structured log viewer with filters/auto refresh.
- Shared utilities:
  - `db.js`: IndexedDB schema helpers (pages/highlights stores).
  - `tools.js`: Ask tool runtime (`fetch_more`, `get_page_summary`,
    `search_memory`) with validation/timeout/metrics.
  - `vectors.js`: cosine similarity, recency weighting, centroid helpers.
  - `text.js`: text normalization/chunk helpers used by capture/background.
  - `logger.js`: shared logging façade for modules and UIs.
  - `offscreen.html/js`: performs heavier scoring/centroid work off main worker.

## Validation & Release Notes

- Manual regression coverage log: `docs/alpha-regression-log-template.md`
- Alpha release note summarising scope/risks/follow-ups: `docs/alpha-release-note.md`

Setup
-----

1. Install and start Ollama

   The extension uses Ollama to generate embeddings and to run the
   generative models for summarisation and Q&A.  Install Ollama on your
   machine and start the server:

   ```bash
   # Install Ollama (see https://ollama.com/download for instructions)
   # Start the Ollama daemon (by default it listens on port 11434)
   ollama serve
   ```

   Tip: If you run into CORS errors accessing Ollama from the extension, see
   [FIX_OLLAMA_ORIGINS.md](./FIX_OLLAMA_ORIGINS.md) for step-by-step instructions
   to allow your Chrome extension origin.

   Pull the models you want to use. For embeddings pull an embedding model such
   as `embeddinggemma` (default in this repo), `mxbai-embed-large`, or
   `nomic-embed-text`:

   ```bash
   ollama pull embeddinggemma    # or another embedding model
   ```

   For summarisation and chat, pull one or more instruct‑tuned models, such as
   `gpt-oss` or `llama3` or `gemma:2b`:

   ```bash
   ollama pull llama3
   ollama pull gemma:2b
   ollama pull gpt-oss:latest
   ```

   The extension calls `/api/embed` for embeddings and `/api/chat` for
   summaries/answers. The default embedding model is `embeddinggemma` and can be
   changed from the side panel Settings (Model selectors).

2. Load the extension in Chrome

   * Open `chrome://extensions/` in Chrome.
   * Enable “Developer mode”.
   * Click “Load unpacked” and select this repository folder.

3. Browse as usual

   After visiting pages, open the side panel (click the extension icon and
   choose “Show in side panel” or use Chrome’s side panel button).  The
   extension captures the visible text of pages you visit, embeds it
   locally via Ollama, and stores the vectors in your browser.

   Type queries like “rust raft diagram” or “news about AI I read
   yesterday” and press **Search**.  The extension will find the most
   relevant passages from your stored pages and display them.

   The side panel includes a **Today’s Highlights** button to generate a concise
   summary of everything captured today using per‑page summaries.

4. Use chat, tools, and model selection (optional)

   Choose embedding/summary/chat models from the drop-downs. Use Provider
   Settings to set the Ollama base URL (the “Test” button checks reachability with a 5s timeout).
   If Tools are enabled, Ask can call:
   - fetch_more(url, start/end | chunkIndex) — fetch additional text (stored pages only, length-capped)
   - get_page_summary(url) — return stored summary
   - search_memory(query, k) — quick cosine search with timeout and partials
   Max tool steps and Tool timeout (ms) are configurable; default timeout is disabled to support slower local runs.
   A live status feed shows tool activity, and per-tool metrics are logged under the answer.

5. Shortcuts and context menu

   - Keyboard: `Ctrl+Shift+Y` (Windows/Linux) or `Command+Shift+Y` (macOS) opens
     the side panel.
   - Right‑click: open the panel, capture the current page now, search the
     current selection, toggle pause, or open Highlights.

6. Manage memory and logs

   - Memory Manager: open from Settings to browse/delete items, bulk actions,
     and export/import JSON.
   - Debug Logs: open from Settings to view recent operational logs.

7. Capture rules and pause

   - Configure whitelist/blacklist domain rules in Settings. When the whitelist
     is non‑empty, only listed domains are captured. Use the Pause toggle to
     temporarily stop auto‑capture.

Release
-------

- Current version: `0.1.0` (pre‑1.0 SemVer; minor versions may contain breaking changes).
- See [CHANGELOG.md](./CHANGELOG.md) for details.
- Chrome extension note: the manifest version is numeric and used for store updates.


Security and privacy
--------------------

* The extension never sends your browsing data to any remote server by default.
  All embeddings are generated locally via the HTTP server you run yourself.
* Tools operate primarily on stored page URLs. When a tool requests a URL that
  isn’t yet captured (e.g., `fetch_more` on a new link), the extension will
  fetch that page directly and run it through the same on-device embedding flow.
  Consider allowing only trusted domains in Settings if that usage is a concern.
* Host permissions include `<all_urls>` to enable certain MV3 features
  (e.g., provider connectivity tests and page‑scoped actions); the extension
  does not exfiltrate page content.

Limitations
-----------

* Semantic search currently uses a linear scan over your stored embeddings,
  which works for a few hundred pages but won’t scale to thousands.
* Reranking uses a local chat model. Keep candidates small (e.g., 5–10) for
  predictable latency; batch reranking reduces calls.
* Memory Manager and logs are basic and may change.

Export/Import
--------------
- Export creates a JSON object with `schemaVersion: 1`, `exportedAt`, optional `embeddingMeta { model, dim }`, and `pages: []`.
- Import accepts legacy arrays or the v1 object. If a file declares a newer schemaVersion, you can still proceed; import is best‑effort.
- Embedding compatibility: if stored embedding dimension differs from imported items, incompatible items/versions are skipped and reported after import. When no local metadata exists, the importer infers and persists the dimension from the first embedded item.

