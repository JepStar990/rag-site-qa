import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EMBED_DIM } from '../src/shared/types.js';

describe('DEFAULT_SETTINGS', () => {
  it('ships keyless (BYOK onboarding starts with no key)', () => {
    expect(DEFAULT_SETTINGS.apiKey).toBeNull();
  });

  it('keeps every cap inside its documented bounds', () => {
    const { caps, retrieval, modelPrefs } = DEFAULT_SETTINGS;
    expect(caps.politenessMs).toBeGreaterThanOrEqual(250);
    expect(caps.politenessMs).toBeLessThanOrEqual(1000);
    expect(caps.chunkOverlapTokens).toBeLessThan(caps.chunkTokens);
    expect(retrieval.topK).toBeGreaterThan(0);
    expect(retrieval.contextTokenBudget).toBeGreaterThan(retrieval.topK * caps.chunkTokens);
    expect(modelPrefs.maxOutputTokens).toBeGreaterThan(0);
  });

  it('uses the documented default DeepSeek model', () => {
    expect(DEFAULT_SETTINGS.modelPrefs.modelId).toBe('deepseek-v4-flash');
  });
});

describe('EMBED_DIM', () => {
  it('matches both supported embedding models (bge-small, MiniLM)', () => {
    expect(EMBED_DIM).toBe(384);
  });
});
