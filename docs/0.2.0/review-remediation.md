# 0.2.x correctness fixes

This patch follows the implementation review and is versioned 0.2.1 because 0.2.0 already exists in the manifest and changelog.

## Data and compatibility

- IndexedDB remains authoritative. Page writes update pages and the duplicate embeddings store in one transaction; deletes also remove pending processing records and clear derived highlights.
- Missing-only backfill submits only empty chunks. Failed responses leave the page unchanged. Explicit Force/Re-embed can replace existing vectors. Compare-and-save prevents stale work from resurrecting deleted pages.
- New/imported tagged vectors carry an embedding-space key (provider, model, revision/runtime configuration). Search scores only matching keys and dimensions. Old untagged vectors are preserved, not guessed or silently recomputed; use per-page Re-embed or opt into Force. Text search remains the fallback.
- Queued/interrupted captures are restored at worker startup. Successful runtime enqueue responses follow durable persistence.

## Ask

Ollama tool arguments are normalized and validated. Initial retrieved excerpts survive synthesis; tool-returned evidence receives stable source IDs before the LLM sees it. The final reference list is resolved against that complete registry. Invalid/absent citations never turn into an unrelated full reference list. Answers stream while generating; final citation validation can replace a draft or report an unverifiable answer. Citation IDs establish provenance, not semantic proof of every claim.

## Packaging and browser support

`pnpm install --frozen-lockfile --ignore-scripts`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:beta`, `pnpm package:extension` run on Node 20.19.5 / pnpm 9.15.2.

Packaging includes only manifest.json and dist/beta runtime assets, excluding source maps and signing keys. The workflow validates PRs and attaches the package. No release is published by this patch; tag-triggered releases keep their existing behavior.

Minimum Chrome increases to 142 for supported side-panel open/close lifecycle events. Toolbar clicks use the native toggle; keyboard actions retain the explicit toggle. Permissions/CSP are unchanged.

## Validation boundaries

Regression fixtures cover real IndexedDB transaction behavior via fake-indexeddb and runtime/provider boundaries via mocks. They do not download EmbeddingGemma or replace live Ollama/Chrome end-to-end validation. Manual checks still needed: stop/restart the service worker during a long capture, backfill with Ollama offline, load browser model after a failed download, and toggle the panel after closing it with Chrome's close button.
