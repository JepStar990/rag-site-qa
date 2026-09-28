/**
 * Retrieval benchmark (docs/03 vector store, M2 exit criterion deferred to
 * M3): p95 < 500ms at 10k chunks on WASM. Run with `npm run bench:retrieval`.
 *
 * Measures the per-query variable cost: one IndexedDB pass over all chunks
 * plus the dot-product scan and top-k pack. The query embedding itself is a
 * fixed one-pass cost and is not part of the scan. Vitest reports p95.
 */

import { bench, describe } from 'vitest';
import 'fake-indexeddb/auto';
import { getAllChunks, openSiteDbNamed, putChunks } from '../src/lib/db/site-db.js';
import { retrieveChunks } from '../src/lib/qa/retrieve.js';
import type { ChunkRecord, PageRecord } from '../src/shared/types.js';
import { EMBED_DIM } from '../src/shared/types.js';

const CHUNK_COUNT = 10_000;
const PAGE_COUNT = 100;
const DB_NAME = 'bench-site';

const randomVec = (): Float32Array => {
  const vec = new Float32Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    const v = Math.random() * 2 - 1;
    vec[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
};

async function seed(): Promise<{ pagesByHash: Map<string, PageRecord>; queryVec: Float32Array }> {
  const db = await openSiteDbNamed(DB_NAME);
  try {
    const chunks: ChunkRecord[] = Array.from({ length: CHUNK_COUNT }, (_, i) => ({
      chunkId: `${i}`,
      urlHash: `page-${i % PAGE_COUNT}`,
      text: `chunk ${i} `.padEnd(2000, 'x'),
      tokens: 512,
      headingPath: '',
      order: i % 100,
      vec: randomVec(),
    }));
    await putChunks(db, chunks);
  } finally {
    db.close();
  }

  const pagesByHash = new Map<string, PageRecord>();
  for (let i = 0; i < PAGE_COUNT; i++) {
    pagesByHash.set(`page-${i}`, {
      urlHash: `page-${i}`,
      url: `https://example.com/page-${i}`,
      title: `Page ${i}`,
      etag: null,
      contentHash: 'h',
      headings: [],
      crawledAt: 0,
    });
  }
  return { pagesByHash, queryVec: randomVec() };
}

const seeded = await seed();

describe(`retrieval at ${CHUNK_COUNT} chunks (384-dim)`, () => {
  bench(
    'full query scan: IndexedDB pass + dot products + top-k pack',
    async () => {
      const db = await openSiteDbNamed(DB_NAME);
      try {
        const chunks = await getAllChunks(db);
        retrieveChunks(chunks, seeded.pagesByHash, seeded.queryVec, {
          topK: 8,
          contextTokenBudget: 8000,
        });
      } finally {
        db.close();
      }
    },
    { time: 2000, warmupTime: 500 },
  );
});
