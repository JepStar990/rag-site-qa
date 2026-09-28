import { describe, expect, it } from 'vitest';
import { chunkSections } from '../src/lib/ingest/chunker.js';
import type { Tokenizer } from '../src/lib/ingest/tokenizer.js';

/** Word-level tokenizer with the production Tokenizer contract. */
class WordTokenizer implements Tokenizer {
  private ids = new Map<string, number>();
  private words: string[] = [];

  encode(text: string): number[] {
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => {
        let id = this.ids.get(w);
        if (id === undefined) {
          id = this.words.length;
          this.ids.set(w, id);
          this.words.push(w);
        }
        return id;
      });
  }

  decode(ids: number[]): string {
    return ids.map((id) => this.words[id]).join(' ');
  }
}

const words = (text: string): string[] => text.split(' ');

describe('chunkSections', () => {
  it('passes short sections through as a single chunk', () => {
    const seeds = chunkSections(
      [{ headingPath: 'Intro', text: 'short intro text' }],
      new WordTokenizer(),
      8,
      2,
    );
    expect(seeds).toEqual([{ text: 'short intro text', headingPath: 'Intro', order: 0 }]);
  });

  it('splits a long section into full-size windows with overlap', () => {
    const section = { headingPath: 'Docs', text: 'a b c d e f g h i j k l m n o p q r s t' };
    const seeds = chunkSections([section], new WordTokenizer(), 8, 2);
    expect(seeds.map((s) => words(s.text))).toEqual([
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      ['g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'],
      ['m', 'n', 'o', 'p', 'q', 'r', 's', 't'],
    ]);
    expect(seeds.every((s) => s.headingPath === 'Docs')).toBe(true);
    expect(seeds.map((s) => s.order)).toEqual([0, 1, 2]);
  });

  it('back-extends the final window to full size instead of a sliver', () => {
    // 17 words: plain striding would leave a 5-word tail; every window must be 8.
    const text = Array.from({ length: 17 }, (_, i) => `w${i}`).join(' ');
    const seeds = chunkSections([{ headingPath: 'H', text }], new WordTokenizer(), 8, 2);
    expect(seeds.length).toBe(3);
    for (const seed of seeds) expect(words(seed.text).length).toBe(8);
    // Coverage is lossless: the union of all windows contains every word.
    const covered = new Set(seeds.flatMap((s) => words(s.text)));
    expect(covered).toEqual(new Set(Array.from({ length: 17 }, (_, i) => `w${i}`)));
  });

  it('keeps a global order across sections and skips empty ones', () => {
    const seeds = chunkSections(
      [
        { headingPath: 'A', text: 'aaa bbb' },
        { headingPath: 'B', text: '   ' },
        { headingPath: 'C', text: 'ccc ddd' },
      ],
      new WordTokenizer(),
      8,
      2,
    );
    expect(seeds.map((s) => [s.headingPath, s.order])).toEqual([
      ['A', 0],
      ['C', 1],
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(chunkSections([], new WordTokenizer(), 8, 2)).toEqual([]);
  });
});
