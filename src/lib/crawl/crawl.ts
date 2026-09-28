/**
 * Crawl + embed orchestrator (docs/03-component-design.md).
 *
 * Pure over injected dependencies: fetch, sleep, now, tokenizer, caps, an
 * IndexedDB opener, and an embedBatch transport. The service-worker handler
 * supplies real implementations; tests supply fakes (no real timers, no
 * network). Kill-safe by construction: the crawl queue and meta persist to
 * IndexedDB before work is acknowledged, pages and chunks commit in one
 * transaction, and embedding checkpoints per batch (a kill costs at most one
 * un-checkpointed batch).
 */

import type { FailedUrl, ProgressPortEvent } from '../../shared/msg-protocol';
import {
  EMBED_BATCH_SIZE,
  type ChunkRecord,
  type CrawlCaps,
  type CrawlQueueItem,
  type PageRecord,
  type SiteMeta,
} from '../../shared/types';
import { clampPoliteness, estimateSiteSize, sha256Hex, siteDbName } from '../../shared/utils';
import { isSameOrigin, normalizeUrl } from '../../shared/url';
import {
  countChunks,
  countPendingChunks,
  countQueue,
  deletePageContent,
  dequeueNext,
  enqueueItems,
  getFailedQueueItems,
  getMeta,
  getPage,
  getPendingChunks,
  listPages,
  putMeta,
  putPage,
  putPageAndChunks,
  requeueDoneForRefresh,
  requeueInterrupted,
  updateQueueItem,
} from '../db/site-db';
import { isAllowedByRobots, parseRobotsTxt, type RobotsPolicy } from './robots';
import { parseSitemap } from './sitemap';
import { extractArticle } from '../ingest/extract';
import { chunkSections } from '../ingest/chunker';
import type { Tokenizer } from '../ingest/tokenizer';

/** Attempts before a queue item is marked `failed` and reported (docs/03). */
export const MAX_ATTEMPTS = 3;

/** Upper bound on sitemap fetches per run (index + sub-sitemaps, docs/03). */
export const MAX_SITEMAP_FETCHES = 10;

const DEFAULT_ROBOTS_POLICY: RobotsPolicy = { rules: [], crawlDelayMs: null };

/** Minimal view of a fetch response for the orchestrator. */
export interface FetchResult {
  ok: boolean;
  status: number;
  /** Final post-redirect URL. */
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** One embedding batch sent to the runtime host (docs/03 message table). */
export interface EmbedBatchRequest {
  dbName: string;
  batchId: number;
  chunks: { chunkId: string; text: string }[];
}

/** Injected dependencies; every side effect is replaceable in tests. */
export interface CrawlDeps {
  fetch(url: string, headers?: Record<string, string>): Promise<FetchResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
  tokenizer: Tokenizer;
  caps: CrawlCaps;
  openDb(): Promise<IDBDatabase>;
  /** Resolves only after the host's embedding write committed (the checkpoint). */
  embedBatch(req: EmbedBatchRequest): Promise<void>;
  onProgress?(event: ProgressPortEvent): void;
}

export interface CrawlOutcome {
  status: 'ready' | 'failed';
  pages: number;
  chunkCount: number;
  sizeEstimateBytes: number;
  failedUrls: FailedUrl[];
  reason?: string;
}

export async function crawlSite(origin: string, entryUrl: string, deps: CrawlDeps): Promise<CrawlOutcome> {
  const db = await deps.openDb();
  try {
    return await runCrawl(origin, entryUrl, deps, db);
  } finally {
    db.close();
  }
}

async function runCrawl(origin: string, entryUrl: string, deps: CrawlDeps, db: IDBDatabase): Promise<CrawlOutcome> {
  const state = { pages: 0, chunkCount: 0, firstFetch: true };
  state.pages = (await listPages(db)).length;
  state.chunkCount = await countChunks(db);

  const robotsPath = (url: string): string => {
    const u = new URL(url);
    return u.pathname + u.search;
  };

  const readFailedUrls = async (): Promise<FailedUrl[]> =>
    (await getFailedQueueItems(db)).map(({ url, attempts }) => ({ url, attempts }));

  let politenessMs = clampPoliteness(deps.caps.politenessMs);

  const fetchWithPoliteness = async (url: string, headers?: Record<string, string>): Promise<FetchResult | null> => {
    if (state.firstFetch) {
      state.firstFetch = false;
    } else {
      await deps.sleep(politenessMs);
    }
    try {
      return await deps.fetch(url, headers);
    } catch {
      return null;
    }
  };

  const handleFailedAttempt = async (item: CrawlQueueItem): Promise<void> => {
    const attempts = item.attempts + 1;
    await updateQueueItem(db, attempts >= MAX_ATTEMPTS ? { ...item, status: 'failed', attempts } : { ...item, status: 'queued', attempts });
  };

  const discoverLinks = async (html: string, pageUrl: string, depth: number): Promise<void> => {
    if (depth + 1 > deps.caps.maxDepth) return;
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch {
      return;
    }
    const candidates = new Set<string>();
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href');
      if (!href) continue;
      try {
        const normalized = normalizeUrl(new URL(href, pageUrl).href);
        if (normalized !== null && isSameOrigin(normalized, origin)) candidates.add(normalized);
      } catch {
        // unparseable href — skip
      }
    }
    await enqueueItems(db, [...candidates].map((url) => ({ url, depth: depth + 1 })));
  };

  const ingestPage = async (
    url: string,
    html: string,
    res: FetchResult,
    depth: number,
  ): Promise<void> => {
    const urlHash = await sha256Hex(url);
    const etag = res.headers.get('etag');
    const article = extractArticle(html);

    if (article) {
      const contentHash = await sha256Hex(article.text);
      const existing = await getPage(db, urlHash);
      if (existing && existing.contentHash === contentHash) {
        // Content unchanged: keep the existing chunks and vectors, refresh metadata only.
        await putPage(db, { ...existing, crawledAt: deps.now(), etag });
      } else {
        await deletePageContent(db, urlHash);
        let seeds = chunkSections(article.sections, deps.tokenizer, deps.caps.chunkTokens, deps.caps.chunkOverlapTokens);
        const room = deps.caps.maxChunksPerSite - state.chunkCount;
        if (seeds.length > room) seeds = seeds.slice(0, Math.max(0, room));
        const chunks: ChunkRecord[] = seeds.map((seed) => ({
          chunkId: `${urlHash}:${seed.order}`,
          urlHash,
          text: seed.text,
          tokens: deps.tokenizer.encode(seed.text).length,
          headingPath: seed.headingPath,
          order: seed.order,
          vec: new Float32Array(0), // pending marker until the embed phase
        }));
        await putPageAndChunks(
          db,
          { urlHash, url, title: article.title, etag, contentHash, headings: article.headings, crawledAt: deps.now() } satisfies PageRecord,
          chunks,
        );
        state.chunkCount += chunks.length;
      }
    } else {
      // Non-article page: recorded in the sources view with zero chunks.
      const existing = await getPage(db, urlHash);
      if (existing && existing.contentHash === '') {
        await putPage(db, { ...existing, crawledAt: deps.now(), etag });
      } else {
        await deletePageContent(db, urlHash);
        await putPageAndChunks(
          db,
          { urlHash, url, title: 'Untitled', etag, contentHash: '', headings: [], crawledAt: deps.now() } satisfies PageRecord,
          [],
        );
      }
    }

    await discoverLinks(html, url, depth);
  };

  /* Phase A — resume state from persisted meta and queue (docs/03). */

  const prev = await getMeta(db, origin);
  const baseMeta: SiteMeta = prev ?? { origin, status: 'idle', lastCrawledAt: null, chunkCount: 0, sizeEstimateBytes: 0 };
  const resumingEmbed = prev?.status === 'embedding';
  const resumingCrawl = prev?.status === 'crawling';

  if (!resumingEmbed) {
    if (!resumingCrawl) {
      if (prev?.status === 'ready') await requeueDoneForRefresh(db);
      await putMeta(db, { ...baseMeta, status: 'crawling' });
    }
    await requeueInterrupted(db);

    /* Phase B — seed: robots.txt, sitemaps, entry page. */

    let policy = DEFAULT_ROBOTS_POLICY;
    try {
      // Goes through the politeness gate like every other fetch to the site.
      const robotsRes = await fetchWithPoliteness(`${origin}/robots.txt`);
      if (robotsRes && robotsRes.ok && isSameOrigin(robotsRes.url, origin)) {
        policy = parseRobotsTxt(await robotsRes.text());
      }
    } catch {
      // default policy — robots.txt unreachable is not an index failure
    }
    politenessMs = Math.max(policy.crawlDelayMs ?? 0, clampPoliteness(deps.caps.politenessMs));

    let sitemapFetches = 0;
    const collectSitemapUrls = async (path: string): Promise<string[]> => {
      const urls: string[] = [];
      if (sitemapFetches >= MAX_SITEMAP_FETCHES) return urls;
      const res = await fetchWithPoliteness(`${origin}${path}`);
      sitemapFetches++;
      if (res === null || !res.ok || !isSameOrigin(res.url, origin)) return urls;
      const parsed = parseSitemap(await res.text());
      if (!parsed) return urls;
      for (const sub of parsed.subSitemaps) {
        if (!sub.startsWith('/')) continue;
        if (!isAllowedByRobots(sub, policy)) continue;
        urls.push(...(await collectSitemapUrls(sub)));
      }
      urls.push(...parsed.urls);
      return urls;
    };

    if (isAllowedByRobots('/sitemap.xml', policy)) {
      const sitemapUrls = await collectSitemapUrls('/sitemap.xml');
      const entries = sitemapUrls
        .map((u) => normalizeUrl(u))
        .filter((u): u is string => u !== null && isSameOrigin(u, origin) && isAllowedByRobots(robotsPath(u), policy))
        .slice(0, deps.caps.maxPages);
      await enqueueItems(db, entries.map((url) => ({ url, depth: 0 })));
    }
    await enqueueItems(db, [{ url: entryUrl, depth: 0 }]);

    /* Phase C — crawl loop. */

    while (true) {
      if (state.pages >= deps.caps.maxPages || state.chunkCount >= deps.caps.maxChunksPerSite) break;
      const item = await dequeueNext(db);
      if (!item) break;

      const normalized = normalizeUrl(item.url);
      if (normalized === null || !isSameOrigin(normalized, origin)) {
        await updateQueueItem(db, { ...item, status: 'done' });
        continue;
      }
      if (!isAllowedByRobots(robotsPath(normalized), policy)) {
        await updateQueueItem(db, { ...item, status: 'done' });
        continue;
      }

      await updateQueueItem(db, { ...item, status: 'fetching' });
      const existingPage = await getPage(db, await sha256Hex(normalized));
      const res = await fetchWithPoliteness(normalized, existingPage?.etag ? { 'If-None-Match': existingPage.etag } : undefined);
      if (res === null) {
        await handleFailedAttempt(item);
        continue;
      }
      if (!isSameOrigin(res.url, origin)) {
        await updateQueueItem(db, { ...item, status: 'failed', attempts: item.attempts + 1 });
        continue;
      }
      if (res.status === 304) {
        // ETag short-circuit: content unchanged, keep existing page and chunks.
        await updateQueueItem(db, { ...item, status: 'done' });
        continue;
      }
      if (!res.ok) {
        await handleFailedAttempt(item);
        continue;
      }

      await ingestPage(normalized, await res.text(), res, item.depth);
      await updateQueueItem(db, { ...item, status: 'done' });
      state.pages++;
      deps.onProgress?.({
        type: 'index-progress',
        origin,
        phase: 'crawling',
        pages: state.pages,
        chunks: state.chunkCount,
        totalChunks: state.chunkCount,
      });
    }

    /* Phase D — transition. */

    const queuedLeft = (await countQueue(db, 'queued')) + (await countQueue(db, 'fetching'));
    if (state.pages === 0 && (await countQueue(db, 'failed')) > 0 && queuedLeft === 0) {
      await putMeta(db, { ...baseMeta, status: 'failed' });
      return {
        status: 'failed',
        pages: 0,
        chunkCount: 0,
        sizeEstimateBytes: 0,
        failedUrls: await readFailedUrls(),
        reason: 'Every page failed to crawl.',
      };
    }
    await putMeta(db, { ...baseMeta, status: 'embedding' });
  }

  /* Phase E — embed pending chunks in batches; each commit is a checkpoint. */

  const pendingTotal = await countPendingChunks(db);
  deps.onProgress?.({
    type: 'index-progress',
    origin,
    phase: 'embedding',
    pages: state.pages,
    chunks: 0,
    totalChunks: pendingTotal,
  });

  // A resume from a mid-embedding kill: earlier batches are already
  // committed, so the run's counts must include them (docs/03 checkpoints).
  let embedded = state.chunkCount - pendingTotal;
  let batchId = 0;
  while (true) {
    const batch = await getPendingChunks(db, EMBED_BATCH_SIZE);
    if (batch.length === 0) break;
    try {
      await deps.embedBatch({
        dbName: await siteDbName(origin),
        batchId: ++batchId,
        chunks: batch.map((c) => ({ chunkId: c.chunkId, text: c.text })),
      });
    } catch (err) {
      // Meta stays `embedding`: a resume re-scans pending chunks, and already
      // committed batches are skipped (docs/03 state machine).
      return {
        status: 'failed',
        pages: state.pages,
        chunkCount: embedded,
        sizeEstimateBytes: 0,
        failedUrls: await readFailedUrls(),
        reason: err instanceof Error ? err.message : 'Embedding failed.',
      };
    }
    embedded += batch.length;
    deps.onProgress?.({
      type: 'index-progress',
      origin,
      phase: 'embedding',
      pages: state.pages,
      chunks: embedded,
      totalChunks: pendingTotal,
    });
  }

  const sizeEstimateBytes = estimateSiteSize(embedded);
  await putMeta(db, { origin, status: 'ready', lastCrawledAt: deps.now(), chunkCount: embedded, sizeEstimateBytes });
  return {
    status: 'ready',
    pages: state.pages,
    chunkCount: embedded,
    sizeEstimateBytes,
    failedUrls: await readFailedUrls(),
  };
}
