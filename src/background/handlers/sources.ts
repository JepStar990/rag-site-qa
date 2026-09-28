import type { SourceInfo } from '../../shared/types';
import { countChunksByPage, listPages, openSiteDb } from '../../lib/db/site-db';

/**
 * Sources view rows (docs/03): pages with chunk counts and crawl
 * timestamps, most recently crawled first.
 */
export async function listSources(origin: string): Promise<SourceInfo[]> {
  const db = await openSiteDb(origin);
  try {
    const [pages, counts] = await Promise.all([listPages(db), countChunksByPage(db)]);
    return pages
      .map((p) => ({
        url: p.url,
        title: p.title,
        chunkCount: counts.get(p.urlHash) ?? 0,
        crawledAt: p.crawledAt,
      }))
      .sort((a, b) => b.crawledAt - a.crawledAt);
  } finally {
    db.close();
  }
}
