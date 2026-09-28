import { describe, expect, it } from 'vitest';
import { isSameOrigin, normalizeUrl } from '../src/shared/url.js';

describe('normalizeUrl', () => {
  it('strips fragments', () => {
    expect(normalizeUrl('https://example.com/docs#section')).toBe('https://example.com/docs');
  });

  it('canonicalizes non-root trailing slashes', () => {
    expect(normalizeUrl('https://example.com/docs/')).toBe('https://example.com/docs');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com/a/b/c/')).toBe('https://example.com/a/b/c');
  });

  it('keeps query strings', () => {
    expect(normalizeUrl('https://example.com/docs/?q=1#x')).toBe('https://example.com/docs?q=1');
  });

  it('lowercases the host and drops default ports via the URL parser', () => {
    expect(normalizeUrl('https://EXAMPLE.com/Docs')).toBe('https://example.com/Docs');
    expect(normalizeUrl('https://example.com:443/docs')).toBe('https://example.com/docs');
  });

  it('returns null for non-fetchable URLs', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://example.com/file')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('isSameOrigin', () => {
  it('accepts any path inside the origin', () => {
    expect(isSameOrigin('https://example.com/a/b?c=1', 'https://example.com')).toBe(true);
    expect(isSameOrigin('https://example.com', 'https://example.com')).toBe(true);
  });

  it('rejects other hosts, schemes, and garbage', () => {
    expect(isSameOrigin('https://other.org/a', 'https://example.com')).toBe(false);
    expect(isSameOrigin('http://example.com/a', 'https://example.com')).toBe(false);
    expect(isSameOrigin('https://example.com.evil.org/a', 'https://example.com')).toBe(false);
    expect(isSameOrigin('javascript:alert(1)', 'https://example.com')).toBe(false);
    expect(isSameOrigin('garbage', 'https://example.com')).toBe(false);
  });
});
