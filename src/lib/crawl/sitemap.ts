/**
 * sitemap.xml / sitemap index parsing (sitemaps.org protocol).
 *
 * Entries are classified by nearest ancestor element (`<url>` under
 * `<urlset>`, `<sitemap>` under `<sitemapindex>`); origin filtering is the
 * crawler's job, not the parser's. The entry cap bounds work from hostile
 * or pathological sitemaps before `caps.maxPages` applies. DOMParser exists
 * in service workers on both platforms, so this runs in the SW.
 */

export interface SitemapResult {
  urls: string[];
  subSitemaps: string[];
}

export const MAX_SITEMAP_ENTRIES = 10000;

export function parseSitemap(xmlText: string): SitemapResult | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  } catch {
    return null;
  }
  const root = doc.documentElement?.tagName.toLowerCase();
  if (root !== 'urlset' && root !== 'sitemapindex') return null;
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  const urls: string[] = [];
  const subSitemaps: string[] = [];
  const locs = doc.getElementsByTagName('loc');
  for (let i = 0; i < locs.length && urls.length + subSitemaps.length < MAX_SITEMAP_ENTRIES; i++) {
    const text = locs[i]?.textContent?.trim() ?? '';
    if (!text) continue;
    const parent = nearestNamedAncestor(locs[i]?.parentElement ?? null, 'url', 'sitemap');
    if (parent === 'url') urls.push(text);
    else if (parent === 'sitemap') subSitemaps.push(text);
  }
  return { urls, subSitemaps };
}

function nearestNamedAncestor(el: Element | null, ...names: string[]): string | null {
  for (let p = el; p; p = p.parentElement) {
    const n = p.tagName.toLowerCase();
    if (names.includes(n)) return n;
  }
  return null;
}
