import { browserApi } from '../../shared/browser-api';
import type { SiteStatusMeta } from '../../shared/msg-protocol';
import type { SiteIndexStatus } from '../../shared/types';
import { getMeta, openSiteDb } from '../../lib/db/site-db';

/**
 * Per-origin site status (docs/03-component-design.md state machine):
 * `inactive` without the permission grant, otherwise the persisted
 * meta.status of the site database (`idle` before the first index run),
 * plus the storage readout for the popup.
 */
export async function getSiteStatusInfo(
  origin: string,
): Promise<{ status: SiteIndexStatus | 'inactive'; meta: SiteStatusMeta | null }> {
  const granted = await browserApi.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) return { status: 'inactive', meta: null };
  const db = await openSiteDb(origin);
  try {
    const meta = await getMeta(db, origin);
    if (!meta) return { status: 'idle', meta: null };
    return {
      status: meta.status,
      meta: {
        chunkCount: meta.chunkCount,
        sizeEstimateBytes: meta.sizeEstimateBytes,
        lastCrawledAt: meta.lastCrawledAt,
      },
    };
  } finally {
    db.close();
  }
}
