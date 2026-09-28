// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseSitemap } from '../src/lib/crawl/sitemap.js';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://example.com/docs</loc></url>
  <url><loc>https://example.com/guide</loc></url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-a.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-b.xml</loc></sitemap>
</sitemapindex>`;

describe('parseSitemap', () => {
  it('extracts urls from a urlset', () => {
    expect(parseSitemap(URLSET)).toEqual({
      urls: ['https://example.com/', 'https://example.com/docs', 'https://example.com/guide'],
      subSitemaps: [],
    });
  });

  it('extracts sub-sitemaps from a sitemap index', () => {
    expect(parseSitemap(INDEX)).toEqual({
      urls: [],
      subSitemaps: ['https://example.com/sitemap-a.xml', 'https://example.com/sitemap-b.xml'],
    });
  });

  it('skips empty loc entries', () => {
    expect(
      parseSitemap('<urlset><url><loc></loc></url><url><loc>https://example.com/a</loc></url></urlset>'),
    ).toEqual({ urls: ['https://example.com/a'], subSitemaps: [] });
  });

  it('returns null for non-sitemap documents', () => {
    expect(parseSitemap('<html><body>not a sitemap</body></html>')).toBeNull();
    expect(parseSitemap('garbage')).toBeNull();
    expect(parseSitemap('<urlset>unclosed')).toBeNull();
  });

  it('caps entries at MAX_SITEMAP_ENTRIES', () => {
    const locs = Array.from({ length: 10001 }, (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`).join('');
    const result = parseSitemap(`<urlset>${locs}</urlset>`);
    expect(result).not.toBeNull();
    expect(result!.urls.length + result!.subSitemaps.length).toBe(10000);
  });
});
