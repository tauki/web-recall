# Web Recall Privacy Statement

_Last updated: 2026-11-16_

Web Recall helps you save, search and ask questions about web pages. Your saved
library is stored in your Chrome profile. We do not operate a service that
receives your browsing-memory library, and Web Recall has no advertising,
analytics SDKs or remote usage telemetry.

## What stays in your browser

- Saved page URLs, titles, capture timestamps, readable page text and chunks.
- Derived embeddings, page summaries, highlights and local diagnostic logs.
- Capture preferences, domain rules, model-provider settings and appearance
  preferences. Questions and answers are processed for the conversations you
  initiate; relevant context is supplied to your selected model provider.

Page data primarily lives in IndexedDB. Settings and migration/recovery data
may also live in `chrome.storage.local`. Automatic capture starts paused; you
can save pages manually or enable capture for the sites you choose. Domain
allowlists/blocklists also apply to manual capture. A saved page or question
can contain sensitive information, so choose capture scope and providers with
care.

The extension requests `unlimitedStorage` to protect the library and browser
model cache from Chrome's storage eviction. This is not a backup or a guarantee
against profile deletion, corruption, uninstalling the extension or disk failure.

## Model processing and downloads

### In-browser embeddings

When you explicitly download a selected EmbeddingGemma model, model files and
configuration are fetched from Hugging Face and its download infrastructure,
using the pinned revision configured for that model. Hosts receive ordinary
request metadata such as your IP address and requested file; your saved page
text is not uploaded for the model download. Once available, the model runs
locally in Chrome. The extension's executable JavaScript and WebAssembly are
bundled with the extension, not downloaded from those hosts.

### Configured model servers

Ollama normally runs on localhost. In this configuration, embeddings, chat and
summaries are processed on your machine. If you explicitly configure a remote
model endpoint and acknowledge it, relevant text, search queries, prompts and
retrieved page passages are sent to that endpoint for inference. Its operator's
privacy practices apply. There is no automatic fallback to a remote provider.

### Optional Mac companion

If you select Apple Foundation Models and grant Chrome's optional native-app
permission, the separately installed Web Recall companion processes inference
requests using Apple's on-device model. Chrome communicates with a registered
native messaging bridge and local companion socket. Selected prompts and page
context are passed to the companion; it does not keep a second saved-page
library. The app must be running and the Apple model available.

Apple Private Cloud Compute is a separate, explicit opt-in. If eligible hardware,
macOS and an entitled companion support it, enabling this mode sends relevant
prompts and selected page context to Apple's servers under Apple's applicable
terms and privacy practices. It is off by default and never activates as an
automatic fallback. The standard companion does not require cloud mode.

### Companion updates

Manually checking for companion updates contacts GitHub's release API. Opt-in
automatic updates also perform these checks. Downloading an update contacts
GitHub's release-download infrastructure. These requests include normal network
metadata, not your saved library or questions. Update metadata is verified
against the app's trusted signing key and the downloaded archive is checked
before installation. The Chrome extension updates separately through Chrome.

## Ask and saved-memory tools

Ask can search saved pages, retrieve additional stored passages and use saved
summaries. These tools operate on the local captured library; they do not browse
arbitrary uncaptured websites. The retrieved material needed for an answer is
provided to your selected local or explicitly enabled remote inference provider.

## Your controls and retention

You can pause automatic capture, configure domain rules, delete saved pages in
Memory Manager, manage browser-model downloads, clear conversations, configure
local logging, and export/import library backups. Exported files stay wherever
you save them; Web Recall does not automatically upload them. You are responsible
for protecting or deleting those files.

Older databases/settings may be retained locally during an upgrade to protect
against migration loss. Deleting a page from the current library is not a secure
erase of historical recovery copies or backups. To remove all extension-owned
data, remove its Chrome profile storage or uninstall the extension; separately
delete exported backups and the optional companion if you no longer need them.

We do not sell your data, use it for advertising, or transfer it for purposes
unrelated to the browsing-memory features you request. Any information you
voluntarily post in a public GitHub issue is public; do not include private
page content, credentials or diagnostic logs without reviewing them first.

## Why Chrome permissions are needed

- `sidePanel`: presents search, previews, Ask and settings beside web pages.
- `activeTab`, `tabs`, `scripting` and host access: identify and read supported
  pages for capture, track navigation and inject the bundled capture script.
- `contextMenus`: provides right-click capture actions.
- `storage` and `unlimitedStorage`: retain preferences, saved pages and models.
- `offscreen`: runs browser embedding/retrieval tasks outside the service worker.
- Optional `nativeMessaging`: connects the user-selected Mac companion.
- Host permissions also enable explicitly configured model servers and requested
  browser-model downloads. Capture remains subject to your pause/domain settings
  and Chrome's restrictions on protected pages.

## Contact and changes

Privacy/security questions: https://github.com/tauki/web-recall/issues

We update this statement when privacy practices change. The current published
policy is at https://github.com/tauki/web-recall/blob/main/privacy.md.
