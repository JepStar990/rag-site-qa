import { describe, expect, it } from 'vitest';
import { clampPoliteness, siteDbName } from '../src/shared/utils.js';

describe('siteDbName', () => {
  it('produces a stable 21-char name for a given origin', async () => {
    const name = await siteDbName('https://example.com');
    expect(name).toMatch(/^site-[0-9a-f]{16}$/);
  });

  it('is deterministic for the same origin', async () => {
    expect(await siteDbName('https://example.com')).toBe(await siteDbName('https://example.com'));
  });

  it('differs across origins', async () => {
    expect(await siteDbName('https://example.com')).not.toBe(await siteDbName('https://other.org'));
  });
});

describe('clampPoliteness', () => {
  it('passes values inside the band through unchanged', () => {
    expect(clampPoliteness(500)).toBe(500);
  });

  it('clamps low values to 250ms', () => {
    expect(clampPoliteness(0)).toBe(250);
    expect(clampPoliteness(-10)).toBe(250);
  });

  it('clamps high values to 1000ms', () => {
    expect(clampPoliteness(5000)).toBe(1000);
  });
});
