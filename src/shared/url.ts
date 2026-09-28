/**
 * URL normalization and same-origin checks for crawling (docs/03).
 *
 * Shared between the popup, the message-bus validator, and the crawler so
 * that one canonical form is used everywhere. The URL parser itself
 * lowercases the host and drops default ports.
 */

/** True when `url` is an http(s) URL inside `origin`. */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Canonical crawl form of an http(s) URL: fragment removed and non-root
 * trailing slash removed (dedup rule in docs/03). Returns null for
 * anything that is not a fetchable http(s) URL.
 */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}
