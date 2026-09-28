# ADR-0002: The embedding model is bundled in the package

Status: Accepted

## Context

Embeddings must be computed locally (DeepSeek has no embeddings endpoint, and a paid embedding API would violate the free-first constraint). transformers.js can load ONNX weights from a URL (Hugging Face CDN) or from the extension package.

Options considered:

- **CDN at first run:** package stays tiny; first indexing waits on a 30-60MB download; Web Store and AMO review remote-code policies treat runtime-downloaded WASM as risky; offline and restricted-network users are locked out; the CDN becomes a supply-chain dependency.
- **Bundle at build time:** package grows by ~34MB (bge-small-en-v1.5 Q8); first run works offline; no remote code; integrity comes from the lockfile-pinned model artifact.

## Decision

Bundle the quantized model (`onnx-community/bge-small-en-v1.5` Q8, ~34MB, 384-dim, CLS pooling) in the package, shipped to both platforms. MiniLM-L6-v2 Q8 (~23MB, also 384-dim) remains an evaluated fallback if size pressure ever demands it; the two models are drop-in interchangeable because dimensions match.

## Consequences

- Package size ~40-45MB, inside both stores' limits (ADR docs 07).
- No network dependency for embedding; indexing works offline end to end.
- Model updates ride the extension release train (reviewed, signed), not a silent CDN change.
- Upgrading or swapping the model is a normal release; vectors are 384-dim in both options, so indexes survive a swap without re-embedding.
