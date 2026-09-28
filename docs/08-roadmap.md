# 08 — Roadmap

Milestones are ordered and gated: each exits only when its acceptance criteria pass. M0 is the documentation-first milestone this repository currently implements.

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Design and docs** | Requirements, architecture, component design, threat model, data model, LLM contract, manifest justification, ADRs; repo scaffold with CI | Docs approved; typecheck, lint, and test pass in CI; initial commit contains docs and shared types only |
| **M1 — Shell** | Vite + crxjs build with Chromium and Firefox targets; manifest per 07; validated message bus per 03; options page with BYOK key entry and test-key flow; popup shell with state machine | Both platforms load unpacked; key saves, masks, tests, and survives restart; message validation tests pass |
| **M2 — Indexing** | Crawler (robots, sitemap, dedup, politeness, caps, resume), Readability ingestion, heading-aware chunker, transformers.js embedder with WebGPU/WASM, per-origin IndexedDB stores | Index a 200-page site from the popup; sources view lists pages, chunks, timestamp; kill mid-crawl and resume with no loss; retrieval p95 < 500ms at 10k chunks on WASM |
| **M3 — QA end-to-end** | Retriever, prompt assembler with hierarchy guardrails, DeepSeek streaming client with error mapping and token accounting, chat UI with citations and sanitized render | Answer streams with `[n]` citations resolving to real URLs; 401/402/429 banners behave per 06; spend readout updates from real usage; context and output budgets enforced |
| **M4 — Hardening and release** | Injection red-team suite (04 scenarios executed against both model tiers), LRU eviction, incremental refresh via ETag and content hash, storage pressure UI, CSP audit, Web Store and AMO packaging (web-ext lint clean), privacy policy copy | Capability matrix in 04 verified by tests; packages < 60MB; both stores' linters pass; hostile-page suite green on default model |
| **M5 — Beyond v1** | WebGPU tuning and benchmarks; hybrid BM25 retrieval; HNSW beyond 50k chunks; PDF support via pdf.js; Safari feasibility assessment (Safari's MV3 gaps around persistent execution and optional host permissions are the open questions); index export/import | Per-item acceptance written when scheduled; none gate v1 release |

## Delivery order rationale

- Docs before code (M0) because the security model — BYOK, runtime host, per-origin isolation, prompt hierarchy — changes code layout everywhere, and it is far cheaper to correct on paper.
- The shell (M1) precedes indexing (M2) because the message bus and key handling are the attack-surface boundary; every later feature rides on it.
- QA (M3) lands before hardening (M4) so red-team findings can still reshape implementation, not just tests.
- Release gates (M4) treat the store linters and the injection suite as equal citizens.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| DeepSeek API surface shifts (model IDs, thinking schema) | High | Medium | All model config user-facing (06); test-key call is the verification vehicle; no hardcoded request shape beyond OpenAI-compatible envelope |
| Firefox runtime differences surface late | Medium | Medium | Firefox is a first-class CI target from M1 (web-ext + Playwright smoke); runtime host abstraction isolates the delta (ADR-0001) |
| WASM embedding throughput disappoints on low-end hardware | Medium | Medium | WebGPU path from M2; batch and checkpoint design; benchmark gate in M2 exit criteria |
| Browser storage eviction removes indexes silently | Medium | Low | `unlimitedStorage` plus LRU and pressure UI (05); rebuild is a click |
| Web Store / AMO review friction over permissions | Medium | Medium | 07 documents every permission against a user-visible feature; optional host permissions keep default install minimal |
| Injection defenses weaker than expected on a specific model | Medium | High | Client-side citation and rendering validations are the backstop (04); red-team suite runs per model tier in M4 |

## Definition of done (every milestone)

- Typecheck, lint, and tests pass on both platform targets.
- Docs updated in the same change as the code they describe.
- No TODOs, no dead code, no generated artifacts committed.
