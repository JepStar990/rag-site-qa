import { describe, expect, it } from 'vitest';
import { answerCostUsd, currentMonthKey } from '../src/lib/qa/spend.js';

describe('answerCostUsd', () => {
  const prices = { input: 0.22, output: 0.66 };

  it('computes cost from token counts and per-1M prices', () => {
    expect(answerCostUsd(1_000_000, 0, prices)).toBeCloseTo(0.22, 10);
    expect(answerCostUsd(0, 1_000_000, prices)).toBeCloseTo(0.66, 10);
    expect(answerCostUsd(5_000, 2_000, prices)).toBeCloseTo((5000 / 1e6) * 0.22 + (2000 / 1e6) * 0.66, 10);
  });

  it('is zero when no tokens were used', () => {
    expect(answerCostUsd(0, 0, prices)).toBe(0);
  });
});

describe('currentMonthKey', () => {
  it('formats the local month with padding', () => {
    expect(currentMonthKey(new Date(2026, 0, 15))).toBe('2026-01');
    expect(currentMonthKey(new Date(2026, 11, 1))).toBe('2026-12');
  });
});
