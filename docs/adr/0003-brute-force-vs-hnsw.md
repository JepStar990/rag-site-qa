# ADR-0003: Brute-force cosine similarity now; HNSW deferred

Status: Accepted

## Context

Retrieval searches one origin's vectors for the top-k nearest to the query embedding. Two candidate strategies: a brute-force scan over the origin's Float32Array vectors, or an approximate nearest-neighbor index (HNSW) maintained in IndexedDB.

## Decision

Brute-force scan with plain Float32Array dot products for v1. HNSW is scheduled for M5, gated on measured need.

## Consequences

- At the default site scale (10k chunks x 384 dims) the scan is ~10ms in JavaScript, comfortably inside the p95 < 500ms retrieval target (NFR-1); an HNSW dependency would add index maintenance, memory, and bug surface for a latency win that does not matter yet.
- No library dependency; the search loop is ~20 lines and trivially testable.
- The per-origin chunk cap of 50k (05) is the re-evaluation trigger: if real sites approach it and p95 degrades past budget, HNSW (or chunk-count-triggered sharding) lands in M5 with a benchmark gate.
- Storing vectors as Float32Array (not number[]) keeps the scan cache-friendly and the storage budget at 4 bytes per dimension.
