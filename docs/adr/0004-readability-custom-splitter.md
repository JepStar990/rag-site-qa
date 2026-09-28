# ADR-0004: Readability extraction plus a custom heading-aware splitter

Status: Accepted

## Context

Ingestion turns crawled HTML into embeddable chunks. Two decisions: how to extract readable content, and how to split it.

Candidates for extraction: @mozilla/readability, trafilatura (port), bespoke DOM stripping. Candidates for splitting: LangChain-style recursive splitters, pure token-window splitting, heading-structure-aware splitting.

## Decision

- **Extraction:** `@mozilla/readability` — battle-tested boilerplate removal, active maintenance, small bundle, works on both platforms' runtime hosts.
- **Splitting:** a custom splitter that (1) splits at h1-h6 heading boundaries from the extracted outline, then (2) subdivides long sections by the embedding model's own tokenizer to 512 tokens with 64 overlap.

## Consequences

- Heading boundaries become chunk metadata (`headingPath`), which powers readable citations ("Installation > Requirements") and keeps related content in the same chunk — directly serving the citation UX (US-2).
- Using the model's own tokenizer makes chunk sizing match the model's accounting, so context-budget trimming (03) is accurate without a second tokenizer.
- A generic recursive splitter was rejected because it ignores document structure; a full heading-hierarchy library was rejected because the custom splitter is ~80 lines and tested.
- Chunk quality is verifiable in unit tests against fixture HTML, including adversarial headings.
