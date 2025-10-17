# Web Recall Privacy Statement

_Last updated: 2025-10-11_

We built Web Recall to respect your privacy. The extension is designed to run entirely on your device and does not send browsing data to any external service by default.

## Data collection
- Web Recall does **not** collect or transmit personal information, browsing history, or usage analytics to us or to third parties.
- All captured page text, embeddings, summaries, and highlights remain in your browser (IndexedDB/`chrome.storage`).
- The only network connections the extension makes by default are to your own local Ollama server (`http://127.0.0.1:11434`) for embedding and chat requests.

## Optional tool fetches
- If you enable the “fetch more” tool for Ask, it may request a URL that has not yet been captured. That content is fetched directly from the source page and processed locally. You can control which domains are allowed via the built-in allowlist/denylist.

## Permissions rationale
- Host permissions (`http://127.0.0.1:11434/*`, `<all_urls>`) are used only to communicate with your local Ollama server and to capture pages you visit. No remote services receive your data.
- Other Chrome permissions (`sidePanel`, `activeTab`, `storage`, `scripting`, `tabs`, `offscreen`, `contextMenus`) enable the side panel UI, capture workflow, and local storage functionality.

## Third-party services
- Web Recall does not integrate with external analytics or advertising services.
- You control the Ollama server used for embeddings/chat; if you point it to a remote host, ensure you trust that server.

## Changes to this statement
We will update this document if privacy practices change. Review the latest version at: https://github.com/tauki/web-recall/blob/main/docs/privacy.md

## Contact
For questions about privacy or security, open an issue at https://github.com/tauki/web-recall/issues
