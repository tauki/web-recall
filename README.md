Web Recall
==========

Web Recall is a privacy-preserving Chrome extension. It captures the visible
text of pages you visit, generates semantic embeddings locally via either
Ollama or the optional in-browser runtime, stores the results in your browser,
and provides a side-panel UI for semantic search. You can also ask questions
about what you've read using retrieval-augmented generation (RAG) powered by
locally running models.

Directory contents
------------------

- `manifest.json`: MV3 manifest targeting the bundled `dist/beta/` workspace.
- `src/background/`: service worker modules for capture, embeddings, search,
  Ask, settings, storage orchestration, providers, highlights, logs, and
  offscreen coordination.
- `src/content/`: top-level content script that extracts page text, chunks it,
  and sends capture payloads to the background queue.
- `src/ui/sidepanel/`: Search, Ask, and Settings surfaces.
- `src/ui/manage/`, `src/ui/highlights/`, `src/ui/logs/`: full-page tools for
  memory management, daily highlights, and structured logs.
- `src/shared/`: shared config, IndexedDB helpers, logging, vector math, tools,
  and wasm/offscreen support.

Setup
-----

0. Install Node.js + pnpm

   Web Recall's 0.2.x workspace uses Node.js 20.x with pnpm for dependency
   management. If you use `nvm`, select a Node 20.x runtime and run
   `corepack enable pnpm` so CLI scripts resolve the correct toolchain.

1. Install dependencies

   ```bash
   pnpm install
   pnpm build:beta
   ```

   `pnpm build:beta` bundles all MV3 entrypoints into `dist/beta/` via esbuild.
   Re-run the build whenever you change `src/` or HTML entrypoints.

2. Install and start Ollama

   The default runtime uses Ollama for embeddings and local chat/summarisation.
   Install Ollama on your machine and start the server:

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
   ollama pull embeddinggemma
   ```

   For summarisation and chat, pull one or more instruct-tuned models, such as
   `gpt-oss`, `llama3`, or `gemma:2b`:

   ```bash
   ollama pull llama3
   ollama pull gemma:2b
   ollama pull gpt-oss:latest
   ```

3. Load the extension in Chrome

   * Open `chrome://extensions/` and enable **Developer mode**.
   * Click **Load unpacked** and select the repository root.
   * Ensure `pnpm build:beta` has been run so `dist/beta/` exists.
   * In DevTools -> Service Workers, verify the console logs
     `[beta-background] Initialising service worker` without errors.

4. Configure capture + embeddings in the side panel

   * Open the Chrome side panel, switch to the Web Recall tab, and visit **Settings**.
   * Toggle **Pause automatic capture**, add allowlist/denylist domains (one per line), and click **Save capture rules**.
   * Enter the Ollama base URL/model in **Embedding provider** and click **Save embedding settings**.
   * Optional: switch the embedding provider to **In-browser (experimental)** to
     download the pinned local embedding model. If the browser runtime is not
     available, the extension will report an error.
   * Run a smoke query from the **Search** tab to ensure captured pages appear and the runtime path works.

5. Browse as usual

   After visiting pages, open the side panel. The extension captures visible
   text from pages you visit, embeds it locally, and stores the vectors in your
   browser.

   Use **Search** to retrieve relevant captured pages.
   Use **Ask** to query your captured memory and get a grounded cited answer.

6. Manage & inspect captures

   - **Memory Manager**: open `chrome://extensions`, click **Details** on Web Recall, then **Extension options**. Search, sort, delete, import, export, and re-embed stored pages. Exports follow `docs/Pack.md` (schema v1).
   - **Highlights dashboard**: navigate to `chrome-extension://<EXTENSION_ID>/dist/beta/ui/highlights/index.html` to review daily summaries.
   - **Logs viewer**: visit `chrome-extension://<EXTENSION_ID>/dist/beta/ui/logs/index.html` to inspect structured background logs.

7. Use chat, tools, and model selection (optional)

   Choose embedding settings in the **Embedding provider** card and chat models
   in the **Chat provider** card. Use **Save provider**, **Test connection**,
   and **Refresh models** to configure the Ollama base URL and active chat
   model. The connection test probes the actual chat endpoint, which helps
   surface `OLLAMA_ORIGINS` misconfiguration.

   If Tools are enabled, Ask can call:
   - `search_memory({ query, k? })`
   - `get_page_summary({ url })`
   - `get_page_chunks({ url, limit? })`
   - `search_within_page({ url, query, k? })`
   - `fetch_more({ url, chunkIndex })`
   - `fetch_more({ url, aroundChunkIndex, radius })`
   - `fetch_more({ url, start, end })`

   `Max tool steps = 0` means no user-imposed limit. `Tool timeout (ms)` applies
   to tool calls only; it does not abort slow `/api/chat` inference.

8. Shortcuts and context menu

   - Keyboard: `Ctrl+Shift+Y` (Windows/Linux) or `Command+Shift+Y` (macOS) opens
     the side panel.
   - Right-click: open the panel, capture the current page now, search the
     current selection, toggle pause, or open Highlights.

9. Capture rules and pause

   - Configure allowlist/denylist domain rules in Settings. When the allowlist
     is non-empty, only listed domains are captured. Use the Pause toggle to
     temporarily stop auto-capture.

Release
-------

- Current version: `0.2.0`.
- See [CHANGELOG.md](./CHANGELOG.md) for details.

Security and privacy
--------------------

* The extension never sends your browsing data to any remote server by default.
  Embeddings run either against your local Ollama server or locally in-browser
  via the optional downloaded model.
* Ask tools operate only on stored page URLs and captured content already in
  memory. `fetch_more` can expand a page already returned by memory search, but
  it does not fetch arbitrary uncaptured URLs.
* Host permissions include `<all_urls>` to enable capture and page-scoped
  actions; the extension does not exfiltrate page content.

Limitations
-----------

* Semantic search still uses a browser-local retrieval pipeline over stored
  embeddings; larger datasets will need more aggressive optimization.
* Reranking uses a local chat model. Keep candidate sets small for predictable latency.
* Memory Manager and logs are functional but still likely to evolve.

Export/Import
-------------
- Export creates a JSON object with `schemaVersion: 1`, `exportedAt`, optional `embeddingMeta { model, dim }`, and `pages: []`.
- Import accepts legacy arrays or the v1 object. If a file declares a newer schemaVersion, import is best-effort.
- Embedding compatibility: if stored embedding dimension differs from imported items, incompatible items/versions are skipped and reported after import.
