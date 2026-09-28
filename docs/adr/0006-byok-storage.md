# ADR-0006: The BYOK key lives in chrome.storage.local and is never synced

Status: Accepted

## Context

There is no backend, so the DeepSeek API key must live on the user's machine. Options considered: embed a project-owned key in the package (rejected outright: any user could extract it and drain the account — fatal for a multi-user distributed product); ask users to paste the key per session (unusable); store it in extension storage.

Among storage surfaces: `chrome.storage.local` (10MB, extension-private, isolated world), `chrome.storage.sync` (8KB, synced to the browser vendor's servers), IndexedDB (accessible from every extension context).

## Decision

The key lives only in `chrome.storage.local`, written only by the options page, read only by the runtime host for outbound requests. It is never in `storage.sync`, never in messages, never in logs or error paths, and the injected content script has no storage access at all (04).

## Consequences

- The key survives restarts but not browser-profile moves — correct behavior for a per-user credential.
- The key does not transit the browser vendor's sync infrastructure.
- Content scripts, page contexts, and other extensions cannot read it; the isolated world plus the no-`content_scripts` rule (07) keeps it off the page-adjacent surface entirely.
- Options UX shows last-4 and a masked input; a test-key call distinguishes 401/402/429 (06).
- Users who paste a key into chat or issues must rotate it — documented in 04.
