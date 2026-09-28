# SiteQA

Browser-only RAG question answering over **entire websites**. Open a site, click SiteQA, and ask questions about anything the site says — docs, blogs, reference manuals, course pages.

There is no backend. Crawling, embedding, retrieval, and vector storage all run inside the browser extension — on Chrome, Edge, Brave, Opera, and Firefox from one codebase. The only external service is the DeepSeek LLM API, which each user calls with their own key (BYOK).

## How it works

1. **Index** — on any site you activate, SiteQA crawls the same-origin pages (robots.txt and sitemap.xml aware), extracts readable text, chunks it, and embeds it locally with a bundled ONNX model (transformers.js, WebGPU when available).
2. **Ask** — questions are answered with retrieval-augmented generation: the top matching chunks are retrieved from the local IndexedDB vector store and sent to DeepSeek with a strict instruction-hierarchy prompt that treats page content as untrusted data.
3. **Verify** — every claim in the answer carries a `[n]` citation that resolves to the exact source URL and heading. Answers render as sanitized markdown; nothing the model returns is executed.

## Why there is no backend

- A shared API key shipped inside a distributed extension would be extractable by any user. SiteQA ships keyless: each user pastes their own DeepSeek key into the settings page on first use. The key lives in `chrome.storage.local` and never reaches content scripts or page contexts.
- Browser storage replaces the server: IndexedDB per-origin vector stores, `chrome.storage.local` for settings.
- This makes the system free to run and free to distribute: no hosting, no infrastructure, no per-user server costs.

## Documentation

| Doc | Contents |
|---|---|
| [01 — Requirements](docs/01-requirements.md) | Goals, non-goals, personas, user stories, NFRs, platform constraints |
| [02 — Architecture](docs/02-architecture.md) | C4 context/container diagrams, components, design principles |
| [03 — Component Design](docs/03-component-design.md) | Module designs, sequence diagrams, crawl state machine |
| [04 — Security & Threat Model](docs/04-security-threat-model.md) | STRIDE, attack tree, prompt-injection defense, CSP |
| [05 — Data Model](docs/05-data-model.md) | IndexedDB schema, quota budget, eviction policy |
| [06 — LLM Integration](docs/06-llm-integration.md) | DeepSeek contract, error matrix, token accounting, BYOK UX |
| [07 — Manifest & Permissions](docs/07-manifest-permissions.md) | Manifest sketch, per-permission justification |
| [08 — Roadmap](docs/08-roadmap.md) | Milestones M0-M5 with acceptance criteria |
| [ADR index](docs/adr/README.md) | Architectural decision records |

## Quick start (development)

```bash
npm install
npm run check   # typecheck + lint + test
```

Extension build tooling lands in M1 (see roadmap). The current tree is the documentation-first deliverable of M0 plus the shared domain types and utilities that the docs specify.

## Privacy

All site content stays on your machine. The only data that leaves the browser is the assembled prompt sent to DeepSeek: the system prompt, your question, and the top retrieved chunks of the site you are asking about. There is no analytics, no telemetry, and no third-party code loaded at runtime.
