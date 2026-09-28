import { browserApi } from '../../shared/browser-api';
import type { SiteIndexStatus } from '../../shared/types';
import { getMeta, openSiteDb } from '../../lib/db/site-db';

/**
 * Per-origin site status (docs/03-component-design.md state machine):
 * `inactive` without the permission grant, otherwise the persisted
 * meta.status of the site database (`idle` before the first index run).
 */
export async function getSiteStatus(origin: string): Promise<SiteIndexStatus | 'inactive'> {
  const granted = await browserApi.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) return 'inactive';
  const db = await openSiteDb(origin);
  try {
    return (await getMeta(db, origin))?.status ?? 'idle';
  } finally {
    db.close();
  }
}
