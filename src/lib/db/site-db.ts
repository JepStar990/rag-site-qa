/**
 * Per-origin IndexedDB access (ADR-0005, docs/05-data-model.md).
 *
 * One database per origin: stores `pages`, `chunks`, `crawl_queue`, `meta`.
 * No module-scope state — the service worker may be torn down between calls
 * (ADR-0001), so callers open the database per operation and close it.
 */

import type { ChunkRecord, CrawlQueueItem, PageRecord, SiteMeta } from '../../shared/types';
import { siteDbName } from '../../shared/utils';

const DB_VERSION = 1;

export const STORES = {
  pages: 'pages',
  chunks: 'chunks',
  queue: 'crawl_queue',
  meta: 'meta',
} as const;

export async function openSiteDb(origin: string): Promise<IDBDatabase> {
  return openSiteDbNamed(await siteDbName(origin));
}

/** Opens a site database by its hashed name (the runtime host knows only the name, 03). */
export async function openSiteDbNamed(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.pages)) {
        db.createObjectStore(STORES.pages, { keyPath: 'urlHash' });
      }
      if (!db.objectStoreNames.contains(STORES.chunks)) {
        const chunks = db.createObjectStore(STORES.chunks, { keyPath: 'chunkId' });
        chunks.createIndex('urlHash', 'urlHash');
      }
      if (!db.objectStoreNames.contains(STORES.queue)) {
        const queue = db.createObjectStore(STORES.queue, { keyPath: 'url' });
        queue.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'origin' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/* Pages */

export async function putPage(db: IDBDatabase, page: PageRecord): Promise<void> {
  const tx = db.transaction(STORES.pages, 'readwrite');
  tx.objectStore(STORES.pages).put(page);
  await txDone(tx);
}

export function getPage(db: IDBDatabase, urlHash: string): Promise<PageRecord | undefined> {
  return asPromise(db.transaction(STORES.pages, 'readonly').objectStore(STORES.pages).get(urlHash));
}

export function listPages(db: IDBDatabase): Promise<PageRecord[]> {
  return asPromise(db.transaction(STORES.pages, 'readonly').objectStore(STORES.pages).getAll());
}

/* Chunks */

export async function putChunks(db: IDBDatabase, chunks: ChunkRecord[]): Promise<void> {
  const tx = db.transaction(STORES.chunks, 'readwrite');
  const store = tx.objectStore(STORES.chunks);
  for (const chunk of chunks) store.put(chunk);
  await txDone(tx);
}

export function getChunksByUrlHash(db: IDBDatabase, urlHash: string): Promise<ChunkRecord[]> {
  return asPromise(db.transaction(STORES.chunks, 'readonly').objectStore(STORES.chunks).index('urlHash').getAll(urlHash));
}

/** All chunks of one origin in a single pass — the retriever's scan (docs/03). */
export function getAllChunks(db: IDBDatabase): Promise<ChunkRecord[]> {
  return asPromise(db.transaction(STORES.chunks, 'readonly').objectStore(STORES.chunks).getAll());
}

export function countChunks(db: IDBDatabase): Promise<number> {
  return asPromise(db.transaction(STORES.chunks, 'readonly').objectStore(STORES.chunks).count());
}

/** Chunk count per page urlHash, in one index scan (sources view). */
export function countChunksByPage(db: IDBDatabase): Promise<Map<string, number>> {
  return new Promise((resolve, reject) => {
    const counts = new Map<string, number>();
    const req = db.transaction(STORES.chunks, 'readonly').objectStore(STORES.chunks).index('urlHash').openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(counts);
        return;
      }
      const key = cursor.key as string;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Write a page and its chunks in one transaction. Kill-safe crawl writes
 * (docs/03): a kill mid-write rolls the whole transaction back, so a page
 * record can never exist without its chunks.
 */
export async function putPageAndChunks(db: IDBDatabase, page: PageRecord, chunks: ChunkRecord[]): Promise<void> {
  const tx = db.transaction([STORES.pages, STORES.chunks], 'readwrite');
  tx.objectStore(STORES.pages).put(page);
  const chunkStore = tx.objectStore(STORES.chunks);
  for (const chunk of chunks) chunkStore.put(chunk);
  await txDone(tx);
}

/**
 * Merge embedding vectors into existing chunk records. Reads each record and
 * writes back only the `vec` field, so text/tokens/heading metadata written
 * during the crawl phase are never clobbered. The transaction commit is the
 * per-batch embedding checkpoint (docs/03): a kill costs at most one
 * un-checkpointed batch.
 */
export async function putChunkVecs(db: IDBDatabase, updates: { chunkId: string; vec: Float32Array }[]): Promise<void> {
  const tx = db.transaction(STORES.chunks, 'readwrite');
  const store = tx.objectStore(STORES.chunks);
  for (const { chunkId, vec } of updates) {
    const existing = await asPromise(store.get(chunkId));
    if (existing) store.put({ ...existing, vec });
  }
  await txDone(tx);
}

/** First `limit` chunks still awaiting embedding (empty `vec` is the pending marker). */
export function getPendingChunks(db: IDBDatabase, limit: number): Promise<ChunkRecord[]> {
  return new Promise((resolve, reject) => {
    const out: ChunkRecord[] = [];
    const req = db.transaction(STORES.chunks, 'readonly').objectStore(STORES.chunks).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      const value = cursor.value as ChunkRecord;
      if (value.vec.length === 0) out.push(value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export function countPendingChunks(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const req = db.transaction(STORES.chunks, 'readonly').objectStore(STORES.chunks).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      const value = cursor.value as ChunkRecord;
      if (value.vec.length === 0) count++;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Queue items that gave up after repeated failures (sources view). */
export function getFailedQueueItems(db: IDBDatabase): Promise<CrawlQueueItem[]> {
  return asPromise(db.transaction(STORES.queue, 'readonly').objectStore(STORES.queue).index('status').getAll('failed'));
}

/**
 * Reset `done` items back to `queued` for an incremental refresh run
 * (state machine `ready -> crawling`). Unlike `enqueueItems`, which never
 * overwrites `done` items, this makes already-indexed pages fetchable again
 * so ETag/content-hash checks can skip unchanged pages (docs/03).
 */
export async function requeueDoneForRefresh(db: IDBDatabase): Promise<number> {
  const urls = await new Promise<string[]>((resolve, reject) => {
    const out: string[] = [];
    const req = db.transaction(STORES.queue, 'readonly').objectStore(STORES.queue).index('status').openKeyCursor('done');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(cursor.primaryKey as string);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  const tx = db.transaction(STORES.queue, 'readwrite');
  const store = tx.objectStore(STORES.queue);
  for (const url of urls) {
    const item = await asPromise(store.get(url));
    if (item && item.status === 'done') store.put({ ...item, status: 'queued' });
  }
  await txDone(tx);
  return urls.length;
}

/** Remove a page record and its chunks (refresh path). */
export async function deletePageContent(db: IDBDatabase, urlHash: string): Promise<void> {
  const tx = db.transaction([STORES.pages, STORES.chunks], 'readwrite');
  const pages = tx.objectStore(STORES.pages);
  const chunks = tx.objectStore(STORES.chunks);
  pages.delete(urlHash);
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const out: IDBValidKey[] = [];
    const req = chunks.index('urlHash').openKeyCursor(urlHash);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(cursor.primaryKey);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  for (const key of keys) chunks.delete(key);
  await txDone(tx);
}

/* Crawl queue */

/**
 * Add items to the queue. Never overwrites `done` items; resets `failed`
 * items so a re-run can retry them (03 state machine); lowers the depth of
 * an existing `queued` item. Returns the number of newly enqueued items.
 */
export async function enqueueItems(
  db: IDBDatabase,
  items: { url: string; depth: number }[],
): Promise<number> {
  const tx = db.transaction(STORES.queue, 'readwrite');
  const store = tx.objectStore(STORES.queue);
  let added = 0;
  for (const { url, depth } of items) {
    const existing = await asPromise(store.get(url));
    if (!existing) {
      store.put({ url, depth, status: 'queued', attempts: 0 } satisfies CrawlQueueItem);
      added++;
    } else if (existing.status === 'failed') {
      store.put({ url, depth, status: 'queued', attempts: 0 } satisfies CrawlQueueItem);
      added++;
    } else if (existing.status === 'queued' && depth < existing.depth) {
      store.put({ ...existing, depth });
    }
  }
  await txDone(tx);
  return added;
}

export function dequeueNext(db: IDBDatabase): Promise<CrawlQueueItem | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORES.queue, 'readonly').objectStore(STORES.queue).index('status').openCursor('queued');
    req.onsuccess = () => {
      const cursor = req.result;
      resolve(cursor ? (cursor.value as CrawlQueueItem) : undefined);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateQueueItem(db: IDBDatabase, item: CrawlQueueItem): Promise<void> {
  const tx = db.transaction(STORES.queue, 'readwrite');
  tx.objectStore(STORES.queue).put(item);
  await txDone(tx);
}

export function countQueue(db: IDBDatabase, status: CrawlQueueItem['status']): Promise<number> {
  return asPromise(db.transaction(STORES.queue, 'readonly').objectStore(STORES.queue).index('status').count(status));
}

/** Reset interrupted `fetching` items back to `queued` (resume, docs/03). */
export async function requeueInterrupted(db: IDBDatabase): Promise<number> {
  const urls = await new Promise<string[]>((resolve, reject) => {
    const out: string[] = [];
    const req = db.transaction(STORES.queue, 'readonly').objectStore(STORES.queue).index('status').openKeyCursor('fetching');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(cursor.primaryKey as string);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  const tx = db.transaction(STORES.queue, 'readwrite');
  const store = tx.objectStore(STORES.queue);
  for (const url of urls) {
    const item = await asPromise(store.get(url));
    if (item && item.status === 'fetching') store.put({ ...item, status: 'queued' });
  }
  await txDone(tx);
  return urls.length;
}

/* Meta */

export function getMeta(db: IDBDatabase, origin: string): Promise<SiteMeta | undefined> {
  return asPromise(db.transaction(STORES.meta, 'readonly').objectStore(STORES.meta).get(origin));
}

export async function putMeta(db: IDBDatabase, meta: SiteMeta): Promise<void> {
  const tx = db.transaction(STORES.meta, 'readwrite');
  tx.objectStore(STORES.meta).put(meta);
  await txDone(tx);
}
