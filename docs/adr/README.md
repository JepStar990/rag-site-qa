# Architectural Decision Records

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-runtime-host-execution.md) | Long-running work runs in a runtime host: offscreen document on Chromium, persistent background page on Firefox | Accepted |
| [0002](0002-bundled-model-vs-cdn.md) | Embedding model bundled in the package, not loaded from a CDN | Accepted |
| [0003](0003-brute-force-vs-hnsw.md) | Brute-force cosine now; HNSW deferred past 50k chunks | Accepted |
| [0004](0004-readability-custom-splitter.md) | Readability plus a custom heading-aware splitter | Accepted |
| [0005](0005-per-origin-idb.md) | One IndexedDB database per origin with hashed names | Accepted |
| [0006](0006-byok-storage.md) | BYOK key in chrome.storage.local, never synced | Accepted |
| [0007](0007-preact.md) | Preact for extension pages | Accepted |
| [0008](0008-streaming-path.md) | LLM streaming through the runtime host with port relay | Accepted |
| [0009](0009-cross-browser-packaging.md) | One codebase, two build targets, namespace shim | Accepted |
| [0010](0010-stream-takeover.md) | On SW death mid-stream, the host writes the terminal transcript itself; the popup watchdog resolves streams nothing can finish | Accepted |

Format: one ADR per file; status Accepted or Superseded; superseded ADRs link to their replacement.
