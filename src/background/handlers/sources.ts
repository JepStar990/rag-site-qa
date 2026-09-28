import type { FailedUrl } from '../../shared/msg-protocol';
import type { SourceInfo } from '../../shared/types';
import { countChunksByPage, getFailedQueueItems, listPages, openSiteDb } from '../../lib/db/site-db';

/**
 * Sources view rows (docs/03): every indexed page with its chunk count and
 * crawl time, newest first, plus queue items that failed after retries.
 */
export async function listSourcesInfo(
  origin: string,
): Promise<{ sources: SourceInfo[]; failed: FailedUrl[] }> {
  const db = await openSiteDb(origin);
  try {
    const [pages, counts, failedItems] = await Promise.all([
      listPages(db),
      countChunksByPage(db),
      getFailedQueueItems(db),
    ]);
    const sources = pages
      .map((page) => ({
        url: page.url,
        title: page.title,
        chunkCount: counts.get(page.urlHash) ?? 0,
        crawledAt: page.crawledAt,
      }))
      .sort((a, b) => b.crawledAt - a.crawledAt);
    return {
      sources,
      failed: failedItems.map(({ url, attempts }) => ({ url, attempts })),
    };
  } finally {
    db.close();
  }
}
