/**
 * Small shared utilities. Kept dependency-free; tested in tests/utils.test.ts.
 */

/**
 * Per-origin IndexedDB database name.
 *
 * Stable, filesystem-safe, and enables clean per-site deletion by closing and
 * deleting one database per origin (ADR-0005). The hash avoids leaking the
 * origin into database names.
 */
export async function siteDbName(origin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `site-${hex.slice(0, 16)}`;
}

/**
 * Clamp a politeness delay into the enforced 250-1000ms band so no crawler
 * configuration can hammer a target site or stall indexing.
 */
export function clampPoliteness(ms: number): number {
  return Math.min(1000, Math.max(250, ms));
}
