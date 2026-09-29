# 06 — LLM Integration

## Contract

DeepSeek exposes an OpenAI-compatible chat completions API.

| Property | Value |
|---|---|
| Base URL | `https://api.deepseek.com` (OpenAI SDK path `/v1` also works) |
| Auth | `Authorization: Bearer <user key>` (BYOK, ADR-0006) |
| Endpoint | `POST /chat/completions` |
| Streaming | SSE via `stream: true`; deltas in `choices[0].delta.content`; final chunk carries `usage` |

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    {"role": "system", "content": "<hierarchy prompt from 04>"},
    {"role": "user", "content": "<documents>...</documents>\n<question>...</question>"}
  ],
  "stream": true,
  "max_tokens": 2048,
  "temperature": 0.3,
  "extra_body": {"thinking": {"type": "disabled"}}
}
```

## Models

DeepSeek's model IDs were in transition in 2026: the legacy `deepseek-chat` and `deepseek-reasoner` aliases were retired (July 2026) in favor of the V4 family.

| Model ID | Role | Notes |
|---|---|---|
| `deepseek-v4-flash` | Default | Fast and cheap; preferred for routine QA |
| `deepseek-v4-pro` | Flagship | Stronger reasoning; higher price |
| `deepseek-flash` | Newer alias | Reported to route to V4.1; verified at implementation time (M3) |
| Custom ID | User-entered | For future models without an extension update |

**Thinking mode.** V4 models default to thinking ON. SiteQA sends an explicit `extra_body.thinking` toggle on every request so behavior never depends on provider defaults. The schema was verified against the live DeepSeek docs during M3 ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)): `extra_body: {"thinking": {"type": "enabled" | "disabled"}}`. While thinking is on, DeepSeek ignores `temperature` and `top_p` — SiteQA omits `temperature` from the request body entirely in that mode, and the settings UI disables those fields. Thinking deltas arrive in the stream as `reasoning_content` and are ignored; SiteQA renders the answer content only.

All model configuration (`modelId`, `thinking`, `temperature`, `maxOutputTokens`) is user-facing state in `modelPrefs` (05).

## Error matrix

| Status | Meaning | Retry | User-facing message |
|---|---|---|---|
| 400 | Malformed request (bad model ID or body) | No | "Request rejected by DeepSeek. Check the model ID in settings." |
| 401 | Invalid API key | No | "API key rejected. Verify it in settings." Banner with deep link to options |
| 402 | Insufficient balance | No | "DeepSeek account has no balance. Top up or wait." |
| 422 | Payload constraint (context too large, etc.) | No | "Request too large. Try a shorter question or smaller context budget." |
| 429 | Rate limited | Yes, with backoff | "Rate limited by DeepSeek. Retrying automatically." |
| 500 / 502 / 503 | Provider-side failure | Yes, with backoff | "DeepSeek is having trouble. Retrying." |
| Network error / timeout | Local connectivity | Yes | "Could not reach DeepSeek. Check your connection." |
| `interrupted` (popup-only) | The stream's owner died and no live stream remains (ADR-0010) | No | "This answer was interrupted. Ask again." — input re-enabled; a re-ask is a new billed request |

The `interrupted` reason is synthetic, produced only by the popup watchdog: it never travels over the host port and the wire validators reject it there.

**Retry policy:** exponential backoff with jitter (1s, 2s, 4s, ±20%), maximum 3 attempts, only while nothing has streamed yet — a partially streamed answer is never re-sent, so no request is ever billed twice by a retry. Each retry is surfaced to the popup as `answer-retry`. Persistent failure ends the stream with the mapped error, which the popup shows as a dismissible banner. A 30s connect timeout (AbortController) bounds every attempt.

## Token accounting and spend control

- **Budgets per request:** assembled context capped at `contextTokenBudget` (8000); `maxOutputTokens` (2048) bounds generation. Both are settings the user can lower.
- **Concurrency:** one QA request in flight at a time (a single global slot in the SW); a concurrent ask is rejected as busy and the popup disables the Ask button while one runs. The slot is SW-memory state and is lost if the SW is torn down mid-answer — on a restarted SW, the preflight re-checks the stored transcript against the runtime host and reports busy while the old stream can still reach a terminal state, so a fresh ask cannot double-bill an answer already in flight (ADR-0010).
- **Spend tracking:** every response's `usage` (prompt/completion tokens) is multiplied by the user-editable per-1M-token prices and added to `budget.spentThisMonthUsd`. A response without `usage` counts as zero cost (no estimation). Defaults are flash off-peak pricing (2026-08): $0.22 input / $0.66 output per 1M; pro is $0.66 / $1.98. The counter is stamped with `budget.spendMonth` and resets when the local calendar month changes; only the SW and the runtime host's takeover path write both fields (05), serialized under a Web Locks mutex.
- **Spend cap:** when `spentThisMonthUsd` reaches `monthlyLimitUsd` (default $5), new requests are blocked with a reset-time message. The cap is an estimate — DeepSeek has no server-side cap for BYOK keys; this is a local guardrail, not a guarantee.
- **Usage readout:** the popup footer shows tokens and estimated cost of the last answer, plus month-to-date spend against the cap.

## Streaming protocol (extension-internal)

The stream must survive popup close and service-worker idle kills (ADR-0008), so it lives in the runtime host (ADR-0001: offscreen document on Chromium, persistent background page on Firefox) and is relayed over ports:

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant OFF as Runtime Host
    participant D as DeepSeek API

    SW->>OFF: start-stream {requestId, messages, key, prefs, origin, question, askedAt, citationDocs}
    OFF->>D: POST /chat/completions (stream)
    loop SSE
        D-->>OFF: delta
        OFF->>SW: stream-chunk {requestId, delta}
        SW->>SW: append to transcript, reset idle
    end
    OFF->>SW: stream-done {requestId, usage}
    SW->>SW: update budget state
    SW->>SW: validate citations, persist transcript
    alt SW died mid-stream (ADR-0010)
        OFF->>OFF: finish the stream, validate citations from citationDocs,
        OFF->>OFF: account spend, write the terminal transcript itself
    end
```

- The key travels SW to the runtime host over the port for the lifetime of one request only; it is never stored in host state and never appears in any `runtime.onMessage` payload.
- The popup renders deltas as sanitized markdown as they arrive; citation validation runs on the complete answer.
- If the popup is closed mid-stream, the SW finishes the stream to completion (bounded by the output cap), persists the transcript to `storage.session` under `qa:<origin>` (05), and the user can reopen the popup to read it — a reopened popup restores the transcript mid-stream and keeps appending deltas.
- **Takeover (ADR-0010):** if the SW dies mid-stream, the offscreen document finishes the answer and writes the terminal transcript itself — the answer the user was billed for is never lost, so an interrupted answer does not have to be re-asked and billed twice. A re-ask after an answer that genuinely ended in `interrupted` is a new billed request.
- Firefox: the runtime host is the background event page (ADR-0001). Each chunk relay and each `chrome.storage.session` delta write is a parent extension-API call, which resets Firefox's event-page idle timer (Bug 1844041), so the stream stays alive with or without the popup open. There is no separate takeover writer — when the event page dies, the stream dies with it, and the popup watchdog resolves the transcript as interrupted.

## BYOK onboarding UX

1. **Keyless until first question.** Indexing, sources browsing, and storage management never require a key. The first `ask` without a key opens the options page with a one-line explainer.
2. **Key entry.** Password-style masked input; paste is allowed; the stored value shows as last-4 characters only. Replace and delete actions are adjacent.
3. **Test key button.** Sends a 1-token chat call and maps the result: success, 401 (invalid), 402 (no balance), 429 (rate limited), network error. The test also validates the configured model ID.
4. **Runtime invalidation.** A 401 mid-conversation ends the stream with the banner above; the index and history are untouched.
5. **Never synced.** The key is excluded from `chrome.storage.sync` (8KB cap, syncs to Google's servers) — ADR-0006. A new browser profile starts keyless by design.

## Privacy note (what the LLM call contains)

Each DeepSeek request contains the system prompt, the user's question, and the top retrieved chunks from the site being asked about — nothing else. No key material, no other sites' indexes, no browsing history. This is the only data that leaves the browser, and it is stated in the README privacy section and the Web Store listing.
