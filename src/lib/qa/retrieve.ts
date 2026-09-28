/**
 * Brute-force vector retrieval over one origin's chunk store (docs/03).
 *
 * All stored vectors and the query vector are L2-normalized 384-dim rows, so
 * cosine similarity is a dot product. At 10k chunks this is a single pass
 * over ~15MB of Float32Arrays in the service worker — the HNSW upgrade path
 * exists past ~50k chunks (ADR-0003).
 */

import type { ChunkRecord, PageRecord } from '../../shared/types';

/** One retrieved document, numbered for the `[n]` citation markers (docs/04). */
export interface RetrievedDoc {
  index: number;
  chunkId: string;
  text: string;
  tokens: number;
  url: string;
  title: string;
  headingPath: string;
  score: number;
}

export interface RetrieveOptions {
  topK: number;
  /** Token budget for the assembled context block; the final doc is truncated to fit. */
  contextTokenBudget: number;
}

const dot = (a: Float32Array, b: Float32Array): number => {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
};

/**
 * Rank chunks by cosine similarity against the query vector, keep top-K,
 * then pack by token budget. Chunks without a page record or a committed
 * vector are skipped: a citation must always resolve to a real crawled URL
 * (docs/04), and a pending (empty) vector has no score to rank by.
 *
 * Token accounting reuses the tokenizer-measured `tokens` field from
 * ingestion. The final chunk that would overflow the budget is truncated by
 * character ratio — an estimate, since tokens do not map linearly to
 * characters, but one that never exceeds the budget in expectation.
 */
export function retrieveChunks(
  chunks: ChunkRecord[],
  pagesByHash: Map<string, PageRecord>,
  queryVec: Float32Array,
  opts: RetrieveOptions,
): RetrievedDoc[] {
  const scored: { chunk: ChunkRecord; page: PageRecord; score: number }[] = [];
  for (const chunk of chunks) {
    if (chunk.vec.length === 0 || chunk.vec.length !== queryVec.length) continue;
    const page = pagesByHash.get(chunk.urlHash);
    if (!page) continue;
    scored.push({ chunk, page, score: dot(chunk.vec, queryVec) });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.topK);

  const docs: RetrievedDoc[] = [];
  let remaining = opts.contextTokenBudget;
  for (const { chunk, page, score } of top) {
    if (remaining <= 0) break;
    let text = chunk.text;
    let tokens = chunk.tokens;
    if (tokens > remaining) {
      // Truncate the last doc to the remaining budget instead of dropping it.
      const ratio = remaining / tokens;
      text = chunk.text.slice(0, Math.floor(chunk.text.length * ratio));
      tokens = remaining;
    }
    if (text.length === 0) continue;
    docs.push({
      index: 0, // assigned after selection so numbers are always 1..n
      chunkId: chunk.chunkId,
      text,
      tokens,
      url: page.url,
      title: page.title,
      headingPath: chunk.headingPath,
      score,
    });
    remaining -= tokens;
  }

  docs.forEach((doc, i) => {
    doc.index = i + 1;
  });
  return docs;
}
