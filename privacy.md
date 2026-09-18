# Web Recall Privacy Statement

_Last updated: 2026-04-08_

Web Recall is designed to keep your browsing memory on your device. By default,
the extension does not send your captured page content, search queries, or Ask
history to us or to third-party analytics services.

## Data stored locally
- Captured page text, chunks, embeddings, summaries, highlights, and search
  metadata are stored in your browser, primarily in IndexedDB.
- Settings such as provider configuration, model choices, and feature flags are
  stored in `chrome.storage.local`.
- Web Recall does **not** ship usage analytics, advertising SDKs, or remote
  telemetry.

## Network access
- By default, model-backed features talk only to your configured Ollama server,
  usually `http://localhost:11434` or `http://127.0.0.1:11434`.
- If you switch the embedding provider to **In-browser**, the extension may
  download the selected embedding model files from Hugging Face on first use.
  After download, embeddings run locally in the browser.
- If you point the chat or embedding provider to a remote host instead of a
  local Ollama server, your prompts and retrieved context will be sent to that
  host. Only use providers you trust.

## Ask tools
- Ask tools operate on captured pages already stored in memory.
- `fetch_more` can expand additional text from a stored page that was already
  returned by memory search, but it does not fetch arbitrary uncaptured URLs.
- `search_memory` and `get_page_summary` operate only on locally stored data.

## Permissions rationale
- Host permissions (`http://localhost:11434/*`, `http://127.0.0.1:11434/*`,
  `<all_urls>`) are required for local model connectivity, page capture, manual
  capture, and extension pages such as Manage, Logs, and Highlights.
- Other Chrome permissions (`sidePanel`, `activeTab`, `storage`, `scripting`,
  `tabs`, `offscreen`, `contextMenus`) support the side panel UI, content
  capture, model/offscreen workflows, and local persistence.

## Third-party services
- Web Recall does not integrate with external analytics or advertising
  services.
- The only third-party network dependency in the default product surface is the
  optional Hugging Face model download used by the in-browser embedding
  runtime.

## Changes to this statement
We will update this document if privacy practices change. Review the latest
version at:
https://github.com/tauki/web-recall/blob/main/privacy.md

## Contact
For questions about privacy or security, open an issue at
https://github.com/tauki/web-recall/issues
