import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  countChunks,
  countChunksByPage,
  countQueue,
  deletePageContent,
  dequeueNext,
  enqueueItems,
  getChunksByUrlHash,
  getMeta,
  getPage,
  listPages,
  openSiteDb,
  putChunks,
  putMeta,
  putPage,
  requeueInterrupted,
  updateQueueItem,
} from '../src/lib/db/site-db.js';
import type { ChunkRecord, CrawlQueueItem, PageRecord, SiteMeta } from '../src/shared/types.js';
import { siteDbName } from '../src/shared/utils.js';

/** Each test uses its own origin so databases never share state. */
const originOf = (tag: string) => `https://${tag}.test`;

function page(url: string, urlHash: string): PageRecord {
  return {
    urlHash,
    url,
    title: 'Page',
    etag: null,
    contentHash: `hash-of-${urlHash}`,
    headings: ['H1'],
    crawledAt: 1000,
  };
}

function chunk(urlHash: string, order: number): ChunkRecord {
  return {
    chunkId: `${urlHash}:${order}`,
    urlHash,
    text: `text ${order}`,
    tokens: 4,
    headingPath: 'H1',
    order,
    vec: new Float32Array([0.1, 0.2, 0.3]),
  };
}

describe('site-db', () => {
  it('creates the four stores under a hashed database name', async () => {
    const origin = originOf('stores');
    const db = await openSiteDb(origin);
    try {
      expect(db.name).toBe(await siteDbName(origin));
      expect([...db.objectStoreNames].sort()).toEqual(['chunks', 'crawl_queue', 'meta', 'pages']);
    } finally {
      db.close();
    }
  });

  it('round-trips pages', async () => {
    const db = await openSiteDb(originOf('pages'));
    try {
      await putPage(db, page('https://a.test/a', 'hash-a'));
      expect(await getPage(db, 'hash-a')).toEqual(page('https://a.test/a', 'hash-a'));
      expect(await getPage(db, 'missing')).toBeUndefined();
      await putPage(db, page('https://a.test/b', 'hash-b'));
      expect((await listPages(db)).map((p) => p.urlHash).sort()).toEqual(['hash-a', 'hash-b']);
    } finally {
      db.close();
    }
  });

  it('stores chunks per page and counts them', async () => {
    const db = await openSiteDb(originOf('chunks'));
    try {
      await putChunks(db, [chunk('hash-a', 0), chunk('hash-a', 1), chunk('hash-b', 0)]);
      expect(await countChunks(db)).toBe(3);
      expect(await getChunksByUrlHash(db, 'hash-a')).toHaveLength(2);
      expect(await countChunksByPage(db)).toEqual(new Map([['hash-a', 2], ['hash-b', 1]]));
    } finally {
      db.close();
    }
  });

  it('deletes a page and its chunks', async () => {
    const db = await openSiteDb(originOf('delete'));
    try {
      await putPage(db, page('https://a.test/a', 'hash-a'));
      await putChunks(db, [chunk('hash-a', 0), chunk('hash-b', 0)]);
      await deletePageContent(db, 'hash-a');
      expect(await getPage(db, 'hash-a')).toBeUndefined();
      expect(await countChunks(db)).toBe(1);
      expect((await getChunksByUrlHash(db, 'hash-a'))).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('enqueues new items, never touches done items, and resets failed ones', async () => {
    const db = await openSiteDb(originOf('enqueue'));
    try {
      const done = { url: 'https://a.test/done', depth: 0, status: 'done', attempts: 1 } satisfies CrawlQueueItem;
      const failed = { url: 'https://a.test/failed', depth: 0, status: 'failed', attempts: 3 } satisfies CrawlQueueItem;
      await updateQueueItem(db, done);
      await updateQueueItem(db, failed);

      const added = await enqueueItems(db, [
        { url: 'https://a.test/new', depth: 0 },
        { url: 'https://a.test/done', depth: 0 },
        { url: 'https://a.test/failed', depth: 1 },
      ]);
      expect(added).toBe(2);

      // dequeueNext makes no ordering promise; drain and assert on the set.
      const dequeued: CrawlQueueItem[] = [];
      for (let i = 0; i < 2; i++) {
        const item = await dequeueNext(db);
        if (!item) break;
        dequeued.push(item);
        await updateQueueItem(db, { ...item, status: 'done' });
      }
      expect(dequeued.map((i) => i.url).sort()).toEqual([
        'https://a.test/failed',
        'https://a.test/new',
      ]);
      expect(dequeued.find((i) => i.url === 'https://a.test/failed')).toEqual({
        url: 'https://a.test/failed',
        depth: 1,
        status: 'queued',
        attempts: 0,
      });
      // The done item never resurfaced as queued.
      expect(await dequeueNext(db)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('lowers depth of an existing queued item and counts by status', async () => {
    const db = await openSiteDb(originOf('depth'));
    try {
      await enqueueItems(db, [{ url: 'https://a.test/a', depth: 5 }]);
      await enqueueItems(db, [{ url: 'https://a.test/a', depth: 2 }]);
      const item = await dequeueNext(db);
      expect(item?.depth).toBe(2);
      expect(await countQueue(db, 'queued')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('requeues interrupted fetching items, preserving attempts', async () => {
    const db = await openSiteDb(originOf('resume'));
    try {
      const fetching = { url: 'https://a.test/mid', depth: 0, status: 'fetching', attempts: 1 } satisfies CrawlQueueItem;
      await updateQueueItem(db, fetching);
      expect(await requeueInterrupted(db)).toBe(1);
      expect(await dequeueNext(db)).toEqual({ ...fetching, status: 'queued' });
    } finally {
      db.close();
    }
  });

  it('round-trips site meta', async () => {
    const origin = originOf('meta');
    const db = await openSiteDb(origin);
    try {
      const meta: SiteMeta = {
        origin,
        status: 'ready',
        lastCrawledAt: 2000,
        chunkCount: 42,
        sizeEstimateBytes: 147000,
      };
      await putMeta(db, meta);
      expect(await getMeta(db, origin)).toEqual(meta);
    } finally {
      db.close();
    }
  });
});
