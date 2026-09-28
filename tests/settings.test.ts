import { describe, expect, it } from 'vitest';
import { publicSettings, sanitizeSettings } from '../src/shared/settings.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types.js';

describe('sanitizeSettings', () => {
  it('returns defaults for empty input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('merges partial input over the stored settings', () => {
    const stored: Settings = {
      ...DEFAULT_SETTINGS,
      modelPrefs: { ...DEFAULT_SETTINGS.modelPrefs, modelId: 'deepseek-v4-pro' },
    };
    const next = sanitizeSettings({ caps: { maxPages: 250 } }, stored);
    expect(next.caps.maxPages).toBe(250);
    expect(next.modelPrefs.modelId).toBe('deepseek-v4-pro');
    expect(next.retrieval).toEqual(stored.retrieval);
  });

  it('clamps out-of-bounds numbers', () => {
    const next = sanitizeSettings({
      caps: { maxPages: 10_000_000, maxDepth: 0, politenessMs: 1 },
      retrieval: { topK: 999, contextTokenBudget: 1 },
      modelPrefs: { maxOutputTokens: -5 },
    });
    expect(next.caps.maxPages).toBe(10000);
    expect(next.caps.maxDepth).toBe(1);
    expect(next.caps.politenessMs).toBe(250);
    expect(next.retrieval.topK).toBe(50);
    expect(next.retrieval.contextTokenBudget).toBe(512);
    expect(next.modelPrefs.maxOutputTokens).toBe(64);
  });

  it('ignores non-numeric garbage', () => {
    const next = sanitizeSettings({ caps: { maxPages: 'lots' }, modelPrefs: { thinking: 'yes' } });
    expect(next.caps.maxPages).toBe(DEFAULT_SETTINGS.caps.maxPages);
    expect(next.modelPrefs.thinking).toBe(false);
  });

  it('forces chunk overlap below chunk size', () => {
    const next = sanitizeSettings({ caps: { chunkTokens: 100, chunkOverlapTokens: 500 } });
    expect(next.caps.chunkOverlapTokens).toBe(99);
  });

  it('never accepts apiKey or spentThisMonthUsd from the bus', () => {
    const stored: Settings = {
      ...DEFAULT_SETTINGS,
      apiKey: 'sk-stored',
      budget: { ...DEFAULT_SETTINGS.budget, spentThisMonthUsd: 1.5 },
    };
    const next = sanitizeSettings({ apiKey: 'sk-injected', budget: { spentThisMonthUsd: 999 } }, stored);
    expect(next.apiKey).toBe('sk-stored');
    expect(next.budget.spentThisMonthUsd).toBe(1.5);
  });
});

describe('publicSettings', () => {
  it('strips the key from bus responses', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, apiKey: 'sk-secret' };
    expect(publicSettings(settings).apiKey).toBeNull();
  });
});
