import { describe, expect, it } from 'vitest';
import { parseCitations } from '../src/lib/qa/citations.js';
import type { RetrievedDoc } from '../src/lib/qa/retrieve.js';

const docs: RetrievedDoc[] = [1, 2, 3].map((index) => ({
  index,
  chunkId: `${index}:0`,
  text: `text ${index}`,
  tokens: 1,
  url: `https://example.com/${index}`,
  title: `Title ${index}`,
  headingPath: `Head ${index}`,
  score: 1,
}));

describe('parseCitations', () => {
  it('resolves valid markers to provenance in first-occurrence order', () => {
    const citations = parseCitations('See [2] and [1] and [2].', docs);
    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({ index: 2, url: 'https://example.com/2', title: 'Title 2' });
    expect(citations[1]).toMatchObject({ index: 1, headingPath: 'Head 1' });
  });

  it('drops out-of-range markers and non-markers', () => {
    const citations = parseCitations('Cites [3] [99] [0] and [x]', docs);
    expect(citations.map((c) => c.index)).toEqual([3]);
  });

  it('extracts a valid marker from inside doubled brackets', () => {
    // The inner [2] resolves to a real document; the stray brackets render as text.
    const citations = parseCitations('See [[2]].', docs);
    expect(citations.map((c) => c.index)).toEqual([2]);
  });

  it('handles multi-digit markers and missing citations', () => {
    expect(parseCitations('no citations here', docs)).toEqual([]);
    expect(parseCitations('', docs)).toEqual([]);
    expect(parseCitations('[12]', docs)).toEqual([]);
  });
});
