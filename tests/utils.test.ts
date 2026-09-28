import { describe, expect, it } from 'vitest';
import { clampPoliteness, estimateSiteSize, formatBytes, sha256Hex, siteDbName } from '../src/shared/utils.js';

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

describe('sha256Hex', () => {
  it('matches the known SHA-256 of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('estimateSiteSize', () => {
  it('uses the documented 3.5KB per chunk figure (05)', () => {
    expect(estimateSiteSize(0)).toBe(0);
    expect(estimateSiteSize(10000)).toBe(35_000_000);
  });
});

describe('formatBytes', () => {
  it('formats byte, kilobyte, and megabyte magnitudes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(35_000)).toBe('34.2 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
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
