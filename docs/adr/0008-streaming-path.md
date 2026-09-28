# ADR-0008: LLM streaming runs in the runtime host and relays over ports

Status: Accepted

## Context

Streamed LLM responses are the core UX (NFR-2: first token < 3s). Two platform facts constrain where the stream may live: the MV3 service worker is killed after ~30s idle and an in-flight `fetch` does not keep it alive; and closing the popup kills fetches the popup started. A stream that dies with the popup or the worker would make answers unreliable.

## Decision

The streaming client lives in the runtime host (ADR-0001): the offscreen document on Chromium, the persistent background page on Firefox. The service worker opens the request, receives `stream-chunk` / `stream-done` messages over a port, and forwards deltas to the popup. Each port message resets MV3 idle timers (Chrome 114+).

## Consequences

- The stream survives popup close: the host finishes the response (bounded by the output cap), the SW persists the transcript, and reopening the popup restores it.
- The service worker never holds a lifetime-critical fetch.
- The API key travels SW -> runtime host over the port for one request only; it is never stored in host state and never appears in `runtime.onMessage` payloads (04).
- Retries happen only before the first streamed token, so a partial answer is never re-sent and double-billed (06).
- Firefox hosts the stream in the background event page; the chunk relays and `chrome.storage.session` delta writes it performs are parent extension-API calls that reset the event page's idle timer (Bug 1844041), so the stream stays alive even with the popup closed. The abstraction is identical from the SW's perspective.
