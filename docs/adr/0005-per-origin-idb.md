# ADR-0005: One IndexedDB database per origin, with hashed names

Status: Accepted

## Context

Site indexes must be strictly isolated (a granted site must not be able to read or poison another site's index — 04) and independently deletable. Options: one database with origin-keyed stores, or one database per origin.

## Decision

One IndexedDB database per origin, named `site-` + the first 16 hex characters of SHA-256(origin) (`siteDbName` in `src/shared/utils.ts`). Inside: `pages`, `chunks`, `crawl_queue`, `meta` (05).

## Consequences

- Isolation is structural, not by discipline: a handle to one database cannot touch another's data. Combined with SW-side origin re-validation, there is no cross-origin read path.
- Deleting a site is `indexedDB.deleteDatabase(name)` — atomic, fast, reclaims quota immediately (US-6).
- Eviction (05) selects whole origin databases LRU-first — the natural granularity for storage pressure.
- The hash keeps origin strings out of database names; the 16-hex truncation is collision-acceptable for this scope (per-origin DBs are opened lazily and names are derived, not trusted).
- Cost: one open database per recently used origin; browsers handle this comfortably at human scale (a handful of indexed sites).
