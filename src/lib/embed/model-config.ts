/**
 * Bundled embedding model (ADR-0002).
 *
 * Files live in public/models/bge-small-en-v1.5/ — fetched at build time by
 * scripts/fetch-model.mjs with sha256-pinned hashes, never committed. The
 * pinned artifact is Xenova/bge-small-en-v1.5, the original transformers.js
 * conversion of BAAI/bge-small-en-v1.5 (Q8, 384-dim, CLS pooling);
 * onnx-community/bge-small-en-v1.5 no longer exists on the Hub.
 */
export const EMBED_MODEL_ID = 'bge-small-en-v1.5';
