import { browserApi } from '../../shared/browser-api';
import type { SiteIndexStatus } from '../../shared/types';

/**
 * Per-origin site status (docs/03-component-design.md state machine).
 * M1 answers from the permission grant; M2 replaces 'idle' with the
 * persisted meta.status of the site database.
 */
export async function getSiteStatus(origin: string): Promise<SiteIndexStatus | 'inactive'> {
  const granted = await browserApi.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) return 'inactive';
  return 'idle';
}
