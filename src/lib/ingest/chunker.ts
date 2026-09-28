/**
 * Heading-aware chunking (ADR-0004, docs/03).
 *
 * Sections arrive already split at h1-h6 heading boundaries. Long sections
 * are subdivided into token windows of `chunkTokens` with
 * `chunkOverlapTokens` overlap, measured by the model's own tokenizer so
 * chunk sizes match the model's accounting.
 *
 * Every window of a long section is exactly `chunkTokens` tokens: windows
 * advance by `chunkTokens - chunkOverlapTokens`, and the final window is
 * back-extended to full size rather than left as a sliver tail (a
 * chunkTokens-or-nothing rule that keeps coverage lossless — consecutive
 * windows always overlap, so no token range is skipped).
 */

import type { Tokenizer } from './tokenizer';

export interface ChunkSeed {
  text: string;
  headingPath: string;
  /** Global chunk order within the page; the chunkId suffix (05). */
  order: number;
}

export function chunkSections(
  sections: { headingPath: string; text: string }[],
  tokenizer: Tokenizer,
  chunkTokens: number,
  chunkOverlapTokens: number,
): ChunkSeed[] {
  const seeds: ChunkSeed[] = [];
  const stride = Math.max(1, chunkTokens - chunkOverlapTokens);
  let order = 0;

  for (const section of sections) {
    const ids = tokenizer.encode(section.text);
    if (ids.length === 0) continue;

    if (ids.length <= chunkTokens) {
      seeds.push({ text: section.text.trim(), headingPath: section.headingPath, order: order++ });
      continue;
    }

    let start = 0;
    while (start < ids.length) {
      const end = Math.min(start + chunkTokens, ids.length);
      const text = tokenizer.decode(ids.slice(start, end)).trim();
      if (text) seeds.push({ text, headingPath: section.headingPath, order: order++ });
      if (end >= ids.length) break;
      start += stride;
      // Back-extend the final window to full size instead of emitting a tail.
      if (start + chunkTokens >= ids.length) start = ids.length - chunkTokens;
    }
  }

  return seeds;
}
