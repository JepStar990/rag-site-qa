# 05 — Data Model

## IndexedDB schema

One database per origin, named `site-` + the first 16 hex characters of SHA-256(origin) (`siteDbName` in `src/shared/utils.ts`). Hashing avoids leaking origins into database names and makes per-site deletion a single `indexedDB.deleteDatabase` call. All record shapes are declared in `src/shared/types.ts`.

```mermaid
erDiagram
    SITE_META ||--o{ PAGES : describes
    PAGES ||--o{ CHUNKS : contains
    CRAWL_QUEUE }o--|| SITE_META : belongs to

    SITE_META {
        string origin PK
        string status
        number lastCrawledAt
        number chunkCount
        number sizeEstimateBytes
    }
    PAGES {
        string urlHash PK
        string url
        string title
        string etag
        string contentHash
        string headings
        number crawledAt
    }
    CHUNKS {
        string chunkId PK
        string urlHash FK
        string text
        number tokens
        string headingPath
        number order
        float32array vec
    }
    CRAWL_QUEUE {
        string url PK
        number depth
        string status
        number attempts
    }
```

| Store | Key | Indexes | Purpose |
|---|---|---|---|
| `pages` | `urlHash` = SHA-256(url) hex | — | Canonical page records; `contentHash` gates re-embedding on refresh |
| `chunks` | `chunkId` = `urlHash:order` | `urlHash` | Text plus 384-dim Float32Array vector; per-page retrieval and deletion |
| `crawl_queue` | `url` (normalized) | `status` | Persisted crawl state; the resume mechanism (03) |
| `meta` | `origin` | — | Index status, timestamps, chunk count, size estimate, LRU clock |

Vector storage is `Float32Array` (not `number[]`) — 4 bytes per dimension, structured-cloneable into IndexedDB, and iterable for cosine similarity without re-boxing.

## chrome.storage.local

`chrome.storage.local` holds settings only (10MB quota, wholesale serialized writes — unsuitable for indexes). See ADR-0006.

| Key | Shape | Notes |
|---|---|---|
| `apiKey` | `string \| null` | BYOK; never synced, never in messages |
| `modelPrefs` | `{modelId, thinking, temperature, maxOutputTokens}` | Model picker state |
| `budget` | `{monthlyLimitUsd, spentThisMonthUsd, spendMonth, pricePerMTokens}` | Spend tracking and caps; `spentThisMonthUsd` + `spendMonth` (`YYYY-MM`) are SW-written only — the counter resets when the calendar month changes |
| `caps` | `{maxPages, maxDepth, maxChunksPerSite, politenessMs, chunkTokens, chunkOverlapTokens}` | Crawl and chunk bounds |
| `retrieval` | `{topK, contextTokenBudget}` | Retrieval budget |

`chrome.storage.session` (in-memory only, cleared on browser restart) holds transient stream state while a QA answer is in flight: the per-origin transcript `qa:<origin>` (streaming deltas buffered as they arrive, replaced by the final answer with citations, usage, and cost on completion, or the mapped error on failure) and per-batch indexing progress. It is never a source of truth — on restart, incomplete answers are discarded and indexing resumes from IndexedDB checkpoints. On Firefox it doubles as the heartbeat medium that keeps the background event page alive during long jobs (ADR-0001).

## Storage budget

| Item | Size |
|---|---|
| One 384-dim Float32Array vector | 1.5 KB |
| One ~512-token chunk of text | ~2 KB |
| 10k chunks (default site) | ~15 MB vectors + ~20 MB text |
| Per-origin cap (50k chunks) | ~77 MB vectors + ~100 MB text ≈ 200 MB |
| Model bundle (bge-small Q8) | ~34 MB on disk in the package |
| Settings + key | < 1 KB |

The extension requests the `unlimitedStorage` permission (silent, no prompt) to lift IndexedDB above the default extension quota. Memory stays bounded regardless: the embedder holds one 32-chunk batch at a time, and retrieval loads vectors per origin in a single pass.

## Eviction policy

IndexedDB is not guaranteed persistent. When `navigator.storage.estimate()` reports usage within 15% of quota (or when an origin's `sizeEstimateBytes` exceeds its cap):

1. Compute per-origin recency from `meta.lastAccessAt` (updated on every query and index action).
2. Evict least-recently-used origin databases first by deleting the whole `site-<hash16>` database, until projected usage drops below 60% of quota.
3. A site currently being indexed is never evicted; eviction defers until the job finishes or is cancelled.
4. The popup surfaces storage pressure with a per-site breakdown so the user can delete manually instead.

Origin selection order is deterministic (LRU), so eviction behaves the same on every restart. Chunk-level eviction within an origin is not implemented in v1: a site over its cap stops ingesting and reports `failed` with a clear message rather than silently dropping content.

## Consistency and concurrency

- IndexedDB transactions are used for every multi-record write (batch of chunks, checkpoint advance). The service worker and runtime host are the only writers, and embedding batches are processed sequentially, so no two contexts write the same origin concurrently.
- A write is acknowledged only after the transaction commits — this is what makes kill-resume lossless (03).
