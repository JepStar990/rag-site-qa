# 02 — Architecture

## System context

```mermaid
C4Context
    title SiteQA System Context

    Person(user, "User", "Site visitor with questions about a website")

    System_Boundary(browser, "Web Browser") {
        System(siteqa, "SiteQA Extension", "RAG QA over whole sites")
        System(target, "Target Website", "Any site the user activates")
    }

    System_Ext(deepseek, "DeepSeek API", "OpenAI-compatible LLM")

    Rel(user, siteqa, "asks questions and manages sites")
    Rel(siteqa, target, "crawls same-origin pages")
    Rel(siteqa, deepseek, "sends prompt with retrieved context using the user's own key")
```

The extension is the entire system. The only external dependency is DeepSeek, called directly from the browser with the user's own key (BYOK). No data flows through any server the project operates.

## Containers

```mermaid
C4Container
    title SiteQA Containers

    Person_Ext(user, "User", "Uses the popup and options pages")

    System_Boundary(ext, "SiteQA Extension") {
        Container(popup, "Popup UI", "Preact + TypeScript", "Chat, sources, index status")
        Container(options, "Options Page", "Preact + TypeScript", "BYOK key entry, model and budget settings")
        Container(sw, "Background Service Worker", "TypeScript, MV3", "Thin router: message bus, crawl queue, IDB access")
        Container(host, "Runtime Host", "TypeScript + transformers.js", "Embedding and LLM streaming; offscreen document on Chromium, background event page with API-call heartbeats on Firefox")
        ContainerDb(idb, "IndexedDB", "site-hash16 per origin", "Pages, chunks, vectors, crawl queue, meta")
        ContainerDb(store, "chrome.storage.local", "Extension storage", "API key and settings only")
    }

    System_Ext(target, "Target Website", "Same-origin pages")
    System_Ext(deepseek, "DeepSeek API", "Chat completions")

    Rel(popup, sw, "messages over chrome.runtime ports")
    Rel(options, store, "reads and writes settings")
    Rel(sw, host, "delegates embed and stream jobs")
    Rel(sw, idb, "reads and writes records")
    Rel(host, idb, "writes embedded chunks")
    Rel(sw, target, "crawls via optional host permissions")
    Rel(host, deepseek, "streams chat completions with the user key")
```

Two platform facts shape this split (ADR-0001, ADR-0008):

- A plain in-flight `fetch` does not keep the MV3 service worker alive; it is killed after ~30s idle and a streaming LLM response can exceed that. Both embedding inference and LLM streaming therefore live in a runtime host — an offscreen document on Chromium, the background event page itself on Firefox, kept alive by the extension-API calls the job makes anyway (ADR-0001) — with streamed chunks relayed to the popup over ports. Each relayed message resets idle timers (Chrome 114+).
- Closing the popup kills popup-initiated fetches. Nothing the user's answer depends on may run in the popup itself.

The service worker stays a thin router: it owns the message bus, the crawl queue, and IndexedDB access, and delegates CPU-heavy or long-lived work to the offscreen document.

## Components

```mermaid
graph TD
    subgraph UI["Extension pages"]
        CHAT[Chat view]
        SRC[Sources view]
        KEY[Key entry]
        CFG[Model and budget settings]
    end

    subgraph SW["Background service worker"]
        RTR[Message router]
        CRW[Crawler]
        ING[Ingestor]
        RET[Retriever]
        ASM[Prompt assembler]
    end

    subgraph RH["Runtime host"]
        EMB[Embedder]
        LLM[LLM streaming client]
    end

    IDB[(IndexedDB site-hash16)]
    STORE[(chrome.storage.local)]
    DEEP[DeepSeek API]
    SITE[Target website]

    CHAT -->|ask question| RTR
    SRC -->|list sources| RTR
    KEY -->|save key| STORE
    CFG -->|save prefs| STORE
    RTR -->|validate + route| CRW
    RTR -->|top-k query| RET
    CRW -->|fetch page| SITE
    CRW -->|extract + chunk| ING
    ING -->|batch of 32| EMB
    EMB -->|vectors + text| IDB
    RET -->|read vectors| IDB
    ASM -->|context + guardrail prompt| LLM
    LLM -->|stream| DEEP
    LLM -->|relay chunks| RTR
    RTR -->|render stream| CHAT
    RET -->|chunks| ASM
```

### Module responsibilities

| Module | Context | Responsibility |
|---|---|---|
| Message router | SW | Validates sender and schema of every message; dispatches to modules; owns popup ports |
| Crawler | SW | Queue, fetch, robots.txt and sitemap.xml, dedup, politeness, resume (03) |
| Ingestor | SW | Readability extraction, heading-aware chunking, content hashing |
| Embedder | Runtime host | transformers.js inference, WebGPU with WASM fallback, batched, checkpointed |
| Retriever | SW | Cosine similarity over per-origin vectors, top-k, context budget trimming |
| Prompt assembler | SW | Instruction-hierarchy prompt; delimited untrusted documents (04) |
| LLM streaming client | Runtime host | DeepSeek SSE streaming, retries, error mapping, token accounting (06) |
| Popup UI | Popup | Chat with citations, index status, sources list |
| Options page | Options | Key entry, model picker, thinking toggle, budget and caps |

## Design principles

1. **The browser is the server.** No backend exists by design; every server capability is reimplemented with browser storage and execution contexts.
2. **The key belongs to its owner.** BYOK throughout; key material never leaves `chrome.storage.local` and the offscreen fetch scope (ADR-0006, 04).
3. **Untrusted by default.** Crawled page content is treated as hostile input at every stage: sanitized at extraction, bounded at chunking, and fenced at prompting (04).
4. **Free first.** Every component is open source and runs locally; the only spend is the user's own DeepSeek usage, metered and capped (06).
5. **Kill-safe by construction.** Every long job is resumable: crawl queue persists, embedding batches checkpoint, streams re-establishable (03).
6. **Per-origin isolation.** Indexes, quotas, and permissions are scoped per origin; a site can only ever poison or waste its own index (04, 05).

## Technology stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript strict | Shared types across all four extension contexts |
| Build | Vite + @crxjs/vite-plugin (M1) | MV3-aware bundling, HMR |
| UI | Preact + signals | Popup-sized UI without a framework tax (ADR-0007) |
| HTML extraction | @mozilla/readability | Battle-tested boilerplate removal |
| Embeddings | transformers.js v3, onnx-community/bge-small-en-v1.5 Q8 (~34MB, 384-dim, CLS pooling); MiniLM-L6-v2 Q8 (~23MB) as fallback | Free, local, bundled in the package (ADR-0002) |
| Vector store | Hand-rolled IndexedDB + Float32Array cosine | ~10ms brute force at 10k chunks; no dependency worth its weight (ADR-0003) |
| Markdown rendering | marked + DOMPurify | Output is data, never markup that can execute |
| Tests | vitest | Fast, same-idiom as build |

## Key decisions

| Decision | ADR |
|---|---|
| Runtime host: offscreen document on Chromium, background event page with API-call heartbeats on Firefox | [ADR-0001](adr/0001-runtime-host-execution.md) |
| Model bundled in the package, not CDN-loaded | [ADR-0002](adr/0002-bundled-model-vs-cdn.md) |
| Brute-force cosine now, HNSW later | [ADR-0003](adr/0003-brute-force-vs-hnsw.md) |
| Readability plus custom heading-aware splitter | [ADR-0004](adr/0004-readability-custom-splitter.md) |
| Per-origin IndexedDB databases | [ADR-0005](adr/0005-per-origin-idb.md) |
| BYOK key in storage.local, never synced | [ADR-0006](adr/0006-byok-storage.md) |
| Preact for extension pages | [ADR-0007](adr/0007-preact.md) |
| Streaming path through offscreen + ports | [ADR-0008](adr/0008-streaming-path.md) |
| One codebase, two build targets, namespace shim | [ADR-0009](adr/0009-cross-browser-packaging.md) |
