# ADR-0001: Long-running work executes in a runtime host

Status: Accepted

## Context

Two kinds of work do not fit the MV3 service worker: (1) ONNX embedding inference, which wants WebGPU or WASM threads and can run for minutes during indexing; (2) a streaming LLM response, which can exceed the service worker's ~30s idle lifetime mid-stream — a plain in-flight `fetch` does not keep the worker alive.

Chromium offers the offscreen document for this: a hidden extension page with DOM and worker capability that stays alive while a port is open (Chrome 114+ resets idle timers per port message). Firefox does not implement `chrome.offscreen`, but it does allow MV3 extensions to opt a background script out of event-page unload via `browser_specific_settings.gecko.background.persistent`.

The project requirement is cross-browser (Chrome, Edge, Brave, Opera, Firefox), so the execution strategy must work on both platforms without forking the pipeline.

## Decision

All long-lived or CPU-heavy work — embedding inference and LLM streaming — runs in a **runtime host** abstraction:

- **Chromium:** an offscreen document (reason `WORKERS`), created on demand after a `chrome.offscreen.hasDocument()` check (only one may exist), kept alive by an open port to the service worker, closed when idle.
- **Firefox:** the background script itself, registered persistent via `browser_specific_settings.gecko.background.persistent`.

The service worker remains a thin router on both platforms: message bus, crawl queue, IndexedDB access, retrieval, prompt assembly. It never holds a fetch whose lifetime matters.

## Consequences

- One host module with a small platform switch; embedding and streaming code is written once and runs in either host.
- Kill-safe behavior is still required: Chromium's offscreen document has version-dependent idle rules, and Firefox's persistent page is only persistent while the browser runs. Jobs checkpoint to IndexedDB per batch (03, 05), so a kill costs at most one 32-chunk batch.
- The `offscreen` permission exists only in the Chromium build target (07, ADR-0009).
- The Firefox persistent background page trades battery friendliness for correctness; the extension has no recurring background work, so the cost is negligible outside active indexing or streaming.
