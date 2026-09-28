# 01 — Requirements

## Goals and non-goals

**Goals**

- G1. RAG-based question answering over an **entire website** (not a single page), triggered from any site the user chooses.
- G2. Runs entirely in the browser. No backend, no hosting, no infrastructure to operate.
- G3. Distributed to many users via the Chrome Web Store without any shared secret.
- G4. Free resources first: local embeddings, local vector storage, open-source libraries. The only paid component is the user's own DeepSeek API usage.
- G5. Production-grade security: the system must survive hostile web pages, prompt-injection content, and abusive usage.

**Non-goals**

- Cross-site or internet-wide search. One index per origin, isolated from all others.
- Syncing indexes or settings across devices (revisit after v1).
- Safari support in v1. Chromium-family browsers (Chrome, Edge, Brave, Opera) and Firefox are v1 targets; Safari's MV3 gaps (persistent execution, optional host permissions) are tracked as an M5 assessment.
- PDF and non-HTML content in v1 (M5).
- Training or fine-tuning models. Retrieval-augmented generation only.

## Personas

- **P1, the researcher** — reads long documentation sites and specs; asks precise questions with sources.
- **P2, the student** — studies from course sites and wikis; needs plain-language answers about the material.
- **P3, the cautious power user** — understands API billing; wants token budgets, spend caps, and model control.

## User stories

| ID | Story | Acceptance |
|---|---|---|
| US-1 | As a user, I activate SiteQA on a site and it indexes the site so I can ask questions | Site indexed without a key; progress shown; works keyless |
| US-2 | As a user, I ask a question and get an answer with citations to source pages | Every claim `[n]` maps to a retrieved chunk URL and heading |
| US-3 | As a user, I enter my DeepSeek key on first use and can test it | Masked input, test button, clear 401/402/429 diagnostics |
| US-4 | As a user, I control cost | Per-request token budget, monthly spend cap, usage readout |
| US-5 | As a user, I re-index to pick up site changes | Incremental refresh skips unchanged pages via content hash and ETag |
| US-6 | As a user, I delete one site's index or everything | Per-origin and global deletion, with storage reclaimed |
| US-7 | As a user, I know what is indexed and when | Sources list with crawl timestamp and page count |
| US-8 | As a user, I am protected from malicious site content | Prompt-injection defenses active on every request; answers rendered without executable content |

## Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | Crawl is same-origin only; cross-origin URLs are never fetched |
| FR-2 | robots.txt is honored; sitemap.xml is used for discovery when present |
| FR-3 | Crawl respects configurable caps: max pages (default 1000), max link depth (default 6), politeness delay 250-1000ms |
| FR-4 | Ingestion extracts readable article text (Readability), chunks with heading-aware splitting (default 512 tokens, 64 overlap), and embeds locally |
| FR-5 | Retrieval is top-k (default 8) cosine similarity over per-origin vectors, constrained by a context token budget (default 8000) |
| FR-6 | QA calls DeepSeek with a configurable model ID and explicit thinking toggle; responses stream to the UI |
| FR-7 | Answers cite retrieved chunks as `[n]`; citations resolve client-side to the stored source URL and heading; model-supplied URLs are never rendered |
| FR-8 | The extension works without an API key for indexing and browsing sources; a key is requested at first question |
| FR-9 | Crawl and embedding jobs are resumable across service-worker and offscreen-document kills |
| FR-10 | Per-origin index status, page count, chunk count, and storage size are visible in the popup |

## Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Retrieval latency | p95 < 500ms at 10k chunks |
| NFR-2 | First answer token after question send | < 3s typical on default model |
| NFR-3 | Indexing throughput (WASM fallback, 512-token chunks) | > 4 chunks/s sustained |
| NFR-4 | Extension package size | < 60MB including bundled model |
| NFR-5 | Storage per origin | Capped at 50k chunks (~200MB); LRU eviction |
| NFR-6 | Browser memory during embedding | Bounded by batch size (32 chunks); checkpoint per batch |
| NFR-7 | Availability | Degrades gracefully: keyless mode, model failure banners, resumable jobs |
| NFR-8 | Compatibility | Chromium 114+ and Firefox 121+; WebGPU optional (Chrome 113+), WASM fallback everywhere |

## Platform constraints (drive several ADRs)

| Constraint | Consequence |
|---|---|
| MV3 service worker killed after ~30s idle; plain fetch does not keep it alive | Embedding and LLM streaming run in an offscreen document; SW is a thin router |
| Popup-close kills popup-initiated fetches | LLM streaming lives in the offscreen document, relayed over ports |
| `chrome.storage.local` quota is 10MB and writes are wholesale-serialized | Settings and key only; indexes live in IndexedDB |
| Extensions' IndexedDB is quota-limited unless granted | Request `unlimitedStorage` (silent permission) |
| Content scripts can read `chrome.storage` | No `content_scripts` in the manifest; a minimal script is injected on demand |
| Web Store remote-code policy | The ONNX model is bundled in the package, not downloaded at runtime |
| One offscreen document at a time | Single shared offscreen context for embedding and LLM streaming |
| Firefox has no `chrome.offscreen`; MV3 backgrounds are always event pages | Runtime host abstraction: offscreen document on Chromium, background event page kept alive by extension-API-call heartbeats on Firefox (ADR-0001) |
| Namespace and packaging differ per platform | Two build targets, minimal namespace shim (ADR-0009) |
| DeepSeek V4 models default to thinking ON | Explicit `thinking` toggle on every request |

## Acceptance criteria (M1-M4 excerpts; full list in 08-roadmap)

- **M2**: index a 200-page site from the popup; sources list shows pages, chunks, timestamp; kill mid-crawl and resume without loss.
- **M3**: ask a question; answer streams with `[n]` citations resolving to real URLs; retrieval p95 < 500ms at 10k chunks.
- **M4**: injection red-team suite passes; hostile-page capability matrix verified; Web Store package < 60MB; CSP audit clean.
