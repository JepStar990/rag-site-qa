# ADR-0010: Stream takeover on service-worker death

Status: Accepted

## Context

ADR-0008 established that the QA stream lives in the runtime host (offscreen document on Chromium, background event page on Firefox) and relays to the service worker over a port, so the stream survives popup close. But the other end of the relay can die too: Chromium tears the SW down mid-answer (the ~5-minute per-event cap, memory pressure, dev reload, crash), the port disconnects, and the host keeps streaming to completion — the user is billed for an answer nobody persists. The transcript under `qa:<origin>` stays `status: 'streaming'` forever, so a reopened popup restores an `asking` phase with the input hidden and "Answering..." on screen indefinitely. The only way out is re-asking the same question, which bills the answer twice.

Verified during design (2026-09): a `port.postMessage` on a dead port throws, and a throw inside the stream client's delta relay aborts the stream (the client rethrows once content has streamed, by design — no double-billing). A takeover therefore cannot naively keep posting: every post must be throw-proof.

## Decision

**Three layers cooperate; none depends on another for correctness of the whole.**

1. **Host-side takeover (Chromium offscreen document).** The `start-stream` frame carries the session context — `origin`, `question`, `askedAt`, and `citationDocs` (citation metadata only; the chunk text already travels in `messages`). The host tracks each stream in a lifecycle: deltas buffer locally and every post goes through a throw-proof wrapper that self-heals on dead-port throws. When the port disconnects before the stream terminates, the host finishes the stream and writes the terminal transcript to `chrome.storage.session` itself: `done` with citations validated from `citationDocs` and spend accounted through the same budget write the SW uses, or `error` with the mapped reason and the partial answer. The lifecycle reports `active` to `stream-status` queries until the terminal post **or** write fully settles, and normal completion still posts to the SW exactly as before — the takeover write runs only on the disconnect path, so no double accounting.

2. **SW-side liveness answers and the busy guard.** A new bus message `get-qa-stream {origin, requestId}` answers whether a terminal state can still arrive: `heldBySw` when this SW's in-flight slot matches (live port events will flow), otherwise a raw-port `stream-status` query to the offscreen document — deliberately not through the runtime-host instance, whose `dispose()` closes the document and would kill a takeover stream mid-write. The ask preflight re-checks a stored `streaming` transcript against the host and reports busy while the old stream can still settle, closing the restart-second-ask double-billing window that the SW-memory slot alone cannot.

3. **Popup watchdog (both platforms).** Every `asking` phase — fresh ask or restored `streaming` transcript — is backed by a watchdog that polls the transcript every 2s: a terminal state landing there (from the SW or from a takeover write) is applied; silence (no answer growth) for 60s triggers a liveness re-check, which extends the window while the stream reports active (thinking can be silent for minutes) and marks the stream `interrupted` — "This answer was interrupted. Ask again." — once nothing can produce a terminal state. The absolute askedAt+10min cap fires only when the status query itself keeps failing. The interrupted marker is written back to the transcript (requestId-guarded, so a stale watchdog cannot clobber a newer ask). `interrupted` is a popup-only reason: the host-port validators reject it on the wire.

## Consequences

- On Chromium, an answer whose SW died mid-stream is preserved with citations and spend accounting; the user is never billed twice for one answer.
- The offscreen document has a second writer role for `qa:<origin>` transcripts and the spend counter. Spend writes are serialized with a Web Locks mutex (`siteqa:spend`), available in both the SW and the offscreen document; where unavailable the write falls back to unguarded (spend is an estimate by design, 06).
- The takeover host has no one to dispose it after a takeover; it idles until the next SW host use disposes it (ADR-0001). Acceptable: one idle hidden document.
- Firefox has no takeover writer — when the event page dies the stream dies with it, and the watchdog resolves the transcript as interrupted. The user re-asks knowingly; that re-ask is a new billed request, never a re-send.
- The no-double-billing invariant is stated precisely: a partially streamed answer is never re-sent (ADR-0008/06); a re-ask after a genuinely interrupted answer is a new billed request.
- If the whole browser dies (crash, restart), nothing can write — `chrome.storage.session` clears anyway, and the restart path discards incomplete answers as before (05).
