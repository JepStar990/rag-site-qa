import { describe, expect, it } from 'vitest';
import { retrieveChunks } from '../src/lib/qa/retrieve.js';
import type { ChunkRecord, PageRecord } from '../src/shared/types.js';

const vec = (values: number[]): Float32Array => {
  const v = new Float32Array(384);
  values.forEach((value, i) => {
    v[i] = value;
  });
  return v;
};

const page = (hash: string, url = `https://example.com/${hash}`): PageRecord => ({
  urlHash: hash,
  url,
  title: `Page ${hash}`,
  etag: null,
  contentHash: 'h',
  headings: [],
  crawledAt: 0,
});

const chunk = (id: string, urlHash: string, text: string, v: Float32Array, tokens = 10): ChunkRecord => ({
  chunkId: id,
  urlHash,
  text,
  tokens,
  headingPath: '',
  order: 0,
  vec: v,
});

const query = vec([1, 0, 0]); // matches vec([1,0,0]) best, vec([0,1,0]) not at all

describe('retrieveChunks', () => {
  it('ranks by cosine similarity and numbers docs 1..n', () => {
    const chunks = [
      chunk('b:0', 'b', 'weak', vec([0, 1, 0])),
      chunk('a:0', 'a', 'strong', vec([1, 0, 0])),
    ];
    const pages = new Map([
      ['a', page('a')],
      ['b', page('b')],
    ]);
    const docs = retrieveChunks(chunks, pages, query, { topK: 8, contextTokenBudget: 1000 });
    expect(docs.map((d) => d.chunkId)).toEqual(['a:0', 'b:0']);
    expect(docs.map((d) => d.index)).toEqual([1, 2]);
    expect(docs[0]?.score).toBeCloseTo(1, 5);
    expect(docs[1]?.score).toBeCloseTo(0, 5);
  });

  it('caps the result at topK', () => {
    const chunks = Array.from({ length: 5 }, (_, i) => chunk(`${i}:0`, `${i}`, `t${i}`, vec([1 - i * 0.1, 0])));
    const pages = new Map(chunks.map((c) => [c.urlHash, page(c.urlHash)]));
    const docs = retrieveChunks(chunks, pages, query, { topK: 3, contextTokenBudget: 1000 });
    expect(docs).toHaveLength(3);
  });

  it('stops packing at the token budget and truncates the final doc', () => {
    const chunks = [
      chunk('a:0', 'a', 'x'.repeat(100), vec([1, 0]), 60),
      chunk('b:0', 'b', 'y'.repeat(100), vec([0.9, 0]), 60),
    ];
    const pages = new Map(chunks.map((c) => [c.urlHash, page(c.urlHash)]));
    const docs = retrieveChunks(chunks, pages, query, { topK: 8, contextTokenBudget: 100 });
    expect(docs).toHaveLength(2);
    expect(docs[0]?.tokens).toBe(60);
    // Second doc truncated by ratio: 40 tokens of 60 -> 2/3 of 100 chars.
    expect(docs[1]?.tokens).toBe(40);
    expect(docs[1]?.text.length).toBe(66);
  });

  it('skips chunks with pending (empty) vectors or missing page records', () => {
    const orphan = chunk('z:0', 'z', 'orphan', vec([1, 0]));
    const pending = { ...chunk('p:0', 'p', 'pending', vec([0.8, 0])), vec: new Float32Array(0) };
    const good = chunk('a:0', 'a', 'good', vec([1, 0]));
    const pages = new Map([['a', page('a')], ['p', page('p')]]);
    const docs = retrieveChunks([orphan, pending, good], pages, query, { topK: 8, contextTokenBudget: 1000 });
    expect(docs.map((d) => d.chunkId)).toEqual(['a:0']);
  });

  it('resolves provenance from the page record', () => {
    const pages = new Map([['a', { ...page('a'), title: 'Docs', url: 'https://example.com/docs' }]]);
    const docs = retrieveChunks([chunk('a:0', 'a', 'text', vec([1, 0]))], pages, query, { topK: 8, contextTokenBudget: 1000 });
    expect(docs[0]).toMatchObject({ title: 'Docs', url: 'https://example.com/docs', index: 1 });
  });

  it('returns no docs for an empty store or a zero budget', () => {
    expect(retrieveChunks([], new Map(), query, { topK: 8, contextTokenBudget: 1000 })).toEqual([]);
    const pages = new Map([['a', page('a')]]);
    expect(retrieveChunks([chunk('a:0', 'a', 't', vec([1, 0]))], pages, query, { topK: 8, contextTokenBudget: 0 })).toEqual([]);
  });
});
