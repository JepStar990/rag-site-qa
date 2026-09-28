import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addSpend } from '../src/background/storage/settings-store.js';

/**
 * Minimal chrome.storage.local stub, installed before imports evaluate:
 * browser-api.ts captures `chrome` at module load.
 */
const { storageState, budgetDefaults } = vi.hoisted(() => {
  const storageState: Record<string, unknown> = {};
  const budgetDefaults = {
    monthlyLimitUsd: 5,
    spentThisMonthUsd: 0,
    spendMonth: null,
    pricePerMTokens: { input: 0.22, output: 0.66 },
  };
  storageState.budget = { ...budgetDefaults };
  storageState.apiKey = null;
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.map((key) => [key, storageState[key]]));
        },
        set: async (obj: Record<string, unknown>) => {
          Object.assign(storageState, obj);
        },
      },
    },
  };
  return { storageState, budgetDefaults };
});

beforeEach(() => {
  storageState.budget = { ...budgetDefaults };
  storageState.apiKey = null;
});

describe('addSpend', () => {
  it('adds one answer cost and stamps the current month', async () => {
    const result = await addSpend(1_000_000, 0);
    expect(result.costUsd).toBeCloseTo(0.22, 10);
    expect(result.spentThisMonthUsd).toBeCloseTo(0.22, 10);
    const budget = storageState.budget as { spentThisMonthUsd: number; spendMonth: string };
    expect(budget.spentThisMonthUsd).toBeCloseTo(0.22, 10);
    expect(budget.spendMonth).toMatch(/^\d{4}-\d{2}$/);
  });

  it('accumulates across answers within the same month', async () => {
    await addSpend(1_000_000, 0);
    const second = await addSpend(0, 1_000_000);
    expect(second.costUsd).toBeCloseTo(0.66, 10);
    expect(second.spentThisMonthUsd).toBeCloseTo(0.88, 10);
  });

  it('resets the counter when the calendar month changed', async () => {
    storageState.budget = { ...budgetDefaults, spentThisMonthUsd: 4.5, spendMonth: '2001-01' };
    const result = await addSpend(1_000_000, 0);
    expect(result.spentThisMonthUsd).toBeCloseTo(0.22, 10);
  });

  it('reports zero cost when no usage is available', async () => {
    const result = await addSpend(0, 0);
    expect(result).toEqual({ costUsd: 0, spentThisMonthUsd: 0 });
  });
});
