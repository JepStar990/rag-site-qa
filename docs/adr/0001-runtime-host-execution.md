# ADR-0001: Long-running work executes in a runtime host

Status: Accepted (supersedes the 2026-09-28 draft that assumed a persistent Firefox background; see Context)

## Context

Two kinds of work do not fit MV3 service workers or event pages: (1) ONNX embedding inference, which runs for minutes during indexing; (2) a streaming LLM response, which can exceed the ~30s idle lifetime mid-stream — an in-flight `fetch` does not keep either platform's background alive.

Verified platform behavior (checked against MDN, Chrome docs, and Firefox implementation):

- **Chromium:** the MV3 service worker is killed after ~30s idle; only extension API calls, events, WebSocket activity (Chrome 116+), and open-port messages reset the timer, with a ~5-minute per-event cap. Chrome provides the offscreen document API for exactly this case.
- **Firefox:** there is no `chrome.offscreen`. MV3 background scripts are **always event pages** — no `persistent` manifest key exists in MV3, and `browser_specific_settings.gecko` has no persistence knob. However, Firefox's event-page implementation resets the idle timer on **parent extension-API calls** (Bug 1844041, landed October 2023): a `setInterval` loop calling `browser.runtime.getBrowserInfo()` measurably prevented suspension.

## Decision

Long-lived or CPU-heavy work — embedding inference and LLM streaming — runs in a **runtime host** abstraction:

- **Chromium:** an offscreen document (reason `WORKERS`), created on demand after a `chrome.offscreen.hasDocument()` check (only one may exist), kept alive by an open port to the service worker, closed when idle.
- **Firefox:** the background event page itself is the host. Long jobs keep it alive by making extension API calls at a cadence faster than the idle timeout: stream-chunk relays (`runtime.sendMessage`) and per-batch progress writes to `chrome.storage.session`. Both are parent API calls and reset the idle timer per Bug 1844041.
- On both platforms, stream deltas are buffered into `chrome.storage.session` as they arrive, so closing the popup mid-stream does not stop the heartbeat; the service worker finishes the response and persists the transcript (ADR-0008).

The service worker remains a thin router on both platforms: message bus, crawl queue, IndexedDB access, retrieval, prompt assembly. It never holds a fetch whose lifetime matters.

## Consequences

- One host module with a small platform switch; embedding and streaming code is written once and runs in either host.
- The Firefox keepalive relies on verified current implementation behavior (parent API calls reset the idle timer). It is still kill-safe: jobs checkpoint to IndexedDB per batch (03, 05), so a kill costs at most one 32-chunk batch. If Firefox changes this behavior, the risk register (08) tracks the revisit.
- The `offscreen` permission exists only in the Chromium build target (07, ADR-0009).
- Firefox's event page trades battery friendliness for correctness during active work; SiteQA has no recurring background activity, so the cost is limited to indexing and streaming sessions.
