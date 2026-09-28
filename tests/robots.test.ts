import { describe, expect, it } from 'vitest';
import { isAllowedByRobots, parseRobotsTxt } from '../src/lib/crawl/robots.js';

describe('parseRobotsTxt', () => {
  it('collects rules only from wildcard groups', () => {
    const policy = parseRobotsTxt([
      'User-agent: googlebot',
      'Disallow: /google-only',
      '',
      'User-agent: *',
      'Disallow: /private',
      'Allow: /public',
    ].join('\n'));
    expect(policy.rules).toEqual([
      { allow: false, pattern: '/private' },
      { allow: true, pattern: '/public' },
    ]);
  });

  it('resets group scope at a new User-agent line', () => {
    const policy = parseRobotsTxt([
      'User-agent: *',
      'Disallow: /a',
      'User-agent: bingbot',
      'Disallow: /b',
    ].join('\n'));
    expect(policy.rules).toEqual([{ allow: false, pattern: '/a' }]);
  });

  it('honors multiple wildcard user-agent lines in one group', () => {
    const policy = parseRobotsTxt(['User-agent: siteqa', 'User-agent: *', 'Disallow: /a'].join('\n'));
    expect(policy.rules).toEqual([{ allow: false, pattern: '/a' }]);
  });

  it('skips empty directives and parses crawl-delay in seconds to ms', () => {
    const policy = parseRobotsTxt(['User-agent: *', 'Disallow:', 'Crawl-delay: 1.5'].join('\n'));
    expect(policy.rules).toEqual([]);
    expect(policy.crawlDelayMs).toBe(1500);
  });

  it('treats inline # as part of the pattern value (RFC 9309)', () => {
    const policy = parseRobotsTxt(['User-agent: *', 'Disallow: /foo#bar'].join('\n'));
    expect(policy.rules).toEqual([{ allow: false, pattern: '/foo#bar' }]);
  });

  it('ignores malformed lines and non-matching fields', () => {
    const policy = parseRobotsTxt('no-colon\nSitemap: https://example.com/sitemap.xml\nUser-agent: *');
    expect(policy.rules).toEqual([]);
    expect(policy.crawlDelayMs).toBeNull();
  });
});

describe('isAllowedByRobots', () => {
  const policy = parseRobotsTxt([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/open',
    'Disallow: /*.pdf$',
  ].join('\n'));

  it('allows when nothing matches', () => {
    expect(isAllowedByRobots('/public/page', policy)).toBe(true);
  });

  it('blocks prefix matches, including subpaths', () => {
    expect(isAllowedByRobots('/private', policy)).toBe(false);
    expect(isAllowedByRobots('/private/x/y', policy)).toBe(false);
  });

  it('longest match wins', () => {
    expect(isAllowedByRobots('/private/open', policy)).toBe(true);
    expect(isAllowedByRobots('/private/other', policy)).toBe(false);
  });

  it('honors the end anchor', () => {
    expect(isAllowedByRobots('/docs/manual.pdf', policy)).toBe(false);
    expect(isAllowedByRobots('/docs/manual.pdf/extra', policy)).toBe(true);
  });

  it('ties resolve toward disallow (RFC 9309 2.2.2)', () => {
    const tie = parseRobotsTxt(['User-agent: *', 'Disallow: /x', 'Allow: /x'].join('\n'));
    expect(isAllowedByRobots('/x', tie)).toBe(false);
  });
});
