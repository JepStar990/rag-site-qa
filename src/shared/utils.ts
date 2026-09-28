/**
 * Small shared utilities. Kept dependency-free; tested in tests/utils.test.ts.
 */

/** Hex-encoded SHA-256 of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Per-origin IndexedDB database name.
 *
 * Stable, filesystem-safe, and enables clean per-site deletion by closing and
 * deleting one database per origin (ADR-0005). The hash avoids leaking the
 * origin into database names.
 */
export async function siteDbName(origin: string): Promise<string> {
  const hex = await sha256Hex(origin);
  return `site-${hex.slice(0, 16)}`;
}

/**
 * Clamp a politeness delay into the enforced 250-1000ms band so no crawler
 * configuration can hammer a target site or stall indexing.
 */
export function clampPoliteness(ms: number): number {
  return Math.min(1000, Math.max(250, ms));
}

/**
 * Approximate IndexedDB footprint of a site index (docs/05 storage budget):
 * ~2KB of text plus a 1.5KB Float32Array vector per ~512-token chunk.
 */
export function estimateSiteSize(chunkCount: number): number {
  return chunkCount * 3500;
}
