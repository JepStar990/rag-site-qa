// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  crawlSite,
  type CrawlDeps,
  type EmbedBatchRequest,
  type FetchResult,
} from '../src/lib/crawl/crawl.js';
import type { Tokenizer } from '../src/lib/ingest/tokenizer.js';
import {
  countChunks,
  countPendingChunks,
  countQueue,
  getChunksByUrlHash,
  getFailedQueueItems,
  getMeta,
  listPages,
  openSiteDb,
  openSiteDbNamed,
  putChunkVecs,
} from '../src/lib/db/site-db.js';
import type { CrawlCaps } from '../src/shared/types.js';
import { EMBED_DIM } from '../src/shared/types.js';
import { estimateSiteSize } from '../src/shared/utils.js';

/** Each test uses its own origin so databases never share state. */
const originOf = (tag: string) => `https://${tag}.test`;

/** 19 words: one chunk under default caps, multiple windows under small ones. */
const BODY =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua';

function pageHtml(title: string, body: string, links: string[] = []): string {
  // Anchors live in a nav (role="navigation" is in Readability's
  // UNLIKELY_ROLES, so the crawler discovers them but the article text
  // stays clean).
  const anchors = links.map((l) => `<a href="${l}">link</a>`).join('\n');
  return `<!doctype html><html><head><title>${title}</title></head><body><nav role="navigation">${anchors}</nav><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

interface PageSpec {
  ok?: boolean;
  status?: number;
  html?: string;
  etag?: string | null;
  /** Final post-redirect URL; different origin simulates a redirect away. */
  redirectTo?: string;
}

/** fetch fake keyed on exact URL, recording every call. */
class FakeFetcher {
  readonly calls: string[] = [];

  constructor(private readonly pages: Map<string, PageSpec>) {}

  fetch = async (url: string): Promise<FetchResult> => {
    this.calls.push(url);
    const spec = this.pages.get(url);
    if (!spec) {
      return { ok: false, status: 404, url, headers: { get: () => null }, text: async () => '' };
    }
    const finalUrl = spec.redirectTo ?? url;
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      url: finalUrl,
      headers: { get: (name) => (name === 'etag' ? (spec.etag ?? null) : null) },
      text: async () => spec.html ?? '',
    };
  };
}

class WordTokenizer implements Tokenizer {
  private ids = new Map<string, number>();
  private words: string[] = [];

  constructor(private readonly crashOn: (text: string) => boolean = () => false) {}

  encode(text: string): number[] {
    if (this.crashOn(text)) throw new Error('tokenizer crash');
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => {
        let id = this.ids.get(w);
        if (id === undefined) {
          id = this.words.length;
          this.ids.set(w, id);
          this.words.push(w);
        }
        return id;
      });
  }

  decode(ids: number[]): string {
    return ids.map((id) => this.words[id]).join(' ');
  }
}

interface Setup {
  origin: string;
  /** Normalized crawl form of the root URL (normalizeUrl keeps the slash). */
  entry: string;
  deps: CrawlDeps;
  fetcher: FakeFetcher;
  sleepCalls: number[];
  /** Batch sizes as the orchestrator sent them, in order. */
  embedLog: { batchId: number; chunks: number }[];
}

/**
 * Builds a full dep set against one per-tag origin database. The embedBatch
 * fake replicates the runtime host: vectors are written into the site DB via
 * putChunkVecs, and the batch is acknowledged only after the commit.
 */
function setup(
  tag: string,
  options: {
    pages?: Record<string, PageSpec>;
    caps?: Partial<CrawlCaps>;
    tokenizer?: Tokenizer;
    failEmbedOn?: (batchId: number) => boolean;
  },
): Setup {
  const origin = originOf(tag);
  const entry = `${origin}/`;
  const fetcher = new FakeFetcher(new Map(Object.entries(options.pages ?? {})));
  const sleepCalls: number[] = [];
  const embedLog: { batchId: number; chunks: number }[] = [];
  const caps: CrawlCaps = {
    maxPages: 100,
    maxDepth: 6,
    maxChunksPerSite: 10_000,
    politenessMs: 250,
    chunkTokens: 1000,
    chunkOverlapTokens: 0,
    ...options.caps,
  };

  const deps: CrawlDeps = {
    fetch: fetcher.fetch,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    now: () => Date.now(),
    tokenizer: options.tokenizer ?? new WordTokenizer(),
    caps,
    openDb: () => openSiteDb(origin),
    embedBatch: async (req: EmbedBatchRequest) => {
      embedLog.push({ batchId: req.batchId, chunks: req.chunks.length });
      if (options.failEmbedOn?.(req.batchId)) throw new Error('host died');
      const db = await openSiteDbNamed(req.dbName);
      try {
        await putChunkVecs(
          db,
          req.chunks.map((c) => ({ chunkId: c.chunkId, vec: new Float32Array(EMBED_DIM).fill(1) })),
        );
      } finally {
        db.close();
      }
    },
  };
  return { origin, entry, deps, fetcher, sleepCalls, embedLog };
}

async function withDb(origin: string, fn: (db: IDBDatabase) => Promise<void>): Promise<void> {
  const db = await openSiteDb(origin);
  try {
    await fn(db);
  } finally {
    db.close();
  }
}

describe('crawlSite', () => {
  it('indexes the entry page and discovered links end to end', async () => {
    const tag = 'happy';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps, fetcher, sleepCalls, embedLog } = setup(tag, {
      pages: {
        [entry]: { html: pageHtml('Home', BODY, ['/a', '/b']) },
        [`${origin}/a`]: { html: pageHtml('Page A', BODY) },
        [`${origin}/b`]: { html: pageHtml('Page B', BODY) },
      },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 3, chunkCount: 3, failedUrls: [] });
    expect(outcome.sizeEstimateBytes).toBe(estimateSiteSize(3));
    // robots.txt and sitemap.xml probes, then the three pages — in that order.
    expect(fetcher.calls).toEqual([
      `${origin}/robots.txt`,
      `${origin}/sitemap.xml`,
      entry,
      `${origin}/a`,
      `${origin}/b`,
    ]);
    // Politeness: every fetch after the first sleeps.
    expect(sleepCalls.length).toBe(4);
    expect(embedLog).toEqual([{ batchId: 1, chunks: 3 }]);

    await withDb(origin, async (db) => {
      expect((await getMeta(db, origin))?.status).toBe('ready');
      expect(await countChunks(db)).toBe(3);
      expect(await countPendingChunks(db)).toBe(0);
      const pages = await listPages(db);
      expect(pages.map((p) => p.url).sort()).toEqual([entry, `${origin}/a`, `${origin}/b`]);
      for (const page of pages) {
        const chunks = await getChunksByUrlHash(db, page.urlHash);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.vec).toHaveLength(EMBED_DIM);
      }
    });
  });

  it('stops at the page cap without fetching discovered links', async () => {
    const tag = 'pagecap';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps, fetcher } = setup(tag, {
      pages: {
        [entry]: { html: pageHtml('Home', BODY, ['/a', '/b']) },
        [`${origin}/a`]: { html: pageHtml('Page A', BODY) },
        [`${origin}/b`]: { html: pageHtml('Page B', BODY) },
      },
      caps: { maxPages: 1 },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 1, chunkCount: 1 });
    expect(fetcher.calls).not.toContain(`${origin}/a`);
    expect(fetcher.calls).not.toContain(`${origin}/b`);
  });

  it('honors robots.txt disallow rules', async () => {
    const tag = 'robots';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps, fetcher } = setup(tag, {
      pages: {
        [`${origin}/robots.txt`]: { html: 'User-agent: *\nDisallow: /a' },
        [entry]: { html: pageHtml('Home', BODY, ['/a', '/b']) },
        [`${origin}/a`]: { html: pageHtml('Page A', BODY) },
        [`${origin}/b`]: { html: pageHtml('Page B', BODY) },
      },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 2, chunkCount: 2 });
    expect(fetcher.calls).not.toContain(`${origin}/a`);
    await withDb(origin, async (db) => {
      expect((await listPages(db)).map((p) => p.url).sort()).toEqual([entry, `${origin}/b`]);
    });
  });

  it('records off-origin redirects as failed without ingesting them', async () => {
    const tag = 'redirect';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps } = setup(tag, {
      pages: {
        [entry]: { html: pageHtml('Home', BODY, ['/a']) },
        [`${origin}/a`]: { redirectTo: 'https://other.test/a' },
      },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 1, chunkCount: 1 });
    expect(outcome.failedUrls).toEqual([{ url: `${origin}/a`, attempts: 1 }]);
  });

  it('retries failing pages up to MAX_ATTEMPTS and reports the survivors', async () => {
    const tag = 'retry';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps } = setup(tag, {
      pages: {
        [entry]: { html: pageHtml('Home', BODY, ['/a']) },
        [`${origin}/a`]: { ok: false, status: 500 },
      },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 1, chunkCount: 1 });
    expect(outcome.failedUrls).toEqual([{ url: `${origin}/a`, attempts: 3 }]);
  });

  it('fails the run when every page fails', async () => {
    const tag = 'allfail';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps } = setup(tag, {
      pages: { [entry]: { ok: false, status: 500 } },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('Every page failed to crawl.');
    expect(outcome.failedUrls).toEqual([{ url: entry, attempts: 3 }]);
    await withDb(origin, async (db) => {
      expect((await getMeta(db, origin))?.status).toBe('failed');
    });
  });

  it('seeds the queue from the sitemap', async () => {
    const tag = 'sitemap';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps } = setup(tag, {
      pages: {
        [`${origin}/sitemap.xml`]: {
          html: [
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            `<url><loc>${origin}/s1</loc></url>`,
            `<url><loc>${origin}/s2</loc></url>`,
            '</urlset>',
          ].join(''),
        },
        [entry]: { html: pageHtml('Home', BODY) },
        [`${origin}/s1`]: { html: pageHtml('S1', BODY) },
        [`${origin}/s2`]: { html: pageHtml('S2', BODY) },
      },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 3, chunkCount: 3 });
    await withDb(origin, async (db) => {
      expect((await listPages(db)).map((p) => p.url).sort()).toEqual([
        entry,
        `${origin}/s1`,
        `${origin}/s2`,
      ]);
    });
  });

  it('resumes a crawl killed mid-run without losing pages or chunks', async () => {
    const tag = 'resume-crawl';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const pages = {
      [entry]: { html: pageHtml('Home', BODY, ['/a', '/b', '/c']) },
      [`${origin}/a`]: { html: pageHtml('Page A', BODY) },
      [`${origin}/b`]: { html: pageHtml('Page B', `${BODY} kill-token`) },
      [`${origin}/c`]: { html: pageHtml('Page C', BODY) },
    };

    // Run 1: the tokenizer crashes while ingesting /b, like a worker kill.
    const run1 = setup(tag, {
      pages,
      tokenizer: new WordTokenizer((text) => text.includes('kill-token')),
    });
    await expect(crawlSite(origin, entry, run1.deps)).rejects.toThrow('tokenizer crash');

    // On-disk state: the interrupted item is mid-fetch; entry and /a committed.
    await withDb(origin, async (db) => {
      expect((await getMeta(db, origin))?.status).toBe('crawling');
      expect(await countQueue(db, 'done')).toBe(2);
      expect(await countQueue(db, 'fetching')).toBe(1);
      expect(await countQueue(db, 'queued')).toBe(1);
    });

    // Run 2: resume. Done pages are not re-fetched; the rest complete.
    const run2 = setup(tag, { pages });
    const outcome = await crawlSite(origin, entry, run2.deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 4, chunkCount: 4, failedUrls: [] });
    expect(run2.fetcher.calls.sort()).toEqual([
      `${origin}/b`,
      `${origin}/c`,
      `${origin}/robots.txt`,
      `${origin}/sitemap.xml`,
    ]);
    expect(run2.embedLog).toEqual([{ batchId: 1, chunks: 4 }]);
    await withDb(origin, async (db) => {
      expect(await countChunks(db)).toBe(4);
      expect(await countPendingChunks(db)).toBe(0);
    });
  });

  it('resumes a mid-embedding kill and embeds only the pending chunks', async () => {
    const tag = 'resume-embed';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const pages = {
      [entry]: { html: pageHtml('Home', BODY, ['/a']) },
      [`${origin}/a`]: { html: pageHtml('Page A', BODY) },
    };
    const caps = { chunkTokens: 5, chunkOverlapTokens: 2 };

    // Run 1: the runtime host dies on the first batch; nothing is committed.
    const run1 = setup(tag, { pages, caps, failEmbedOn: () => true });
    const killed = await crawlSite(origin, entry, run1.deps);
    expect(killed).toMatchObject({ status: 'failed', chunkCount: 0 });
    expect(killed.reason).toBe('host died');
    await withDb(origin, async (db) => {
      expect((await getMeta(db, origin))?.status).toBe('embedding');
      expect(await countPendingChunks(db)).toBe(12);
    });

    // Run 2: resume goes straight to the embed phase.
    const run2 = setup(tag, { pages, caps });
    const outcome = await crawlSite(origin, entry, run2.deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 2, chunkCount: 12 });
    expect(run2.embedLog).toEqual([{ batchId: 1, chunks: 12 }]);
    await withDb(origin, async (db) => {
      expect(await countPendingChunks(db)).toBe(0);
    });
  });

  it('checkpoints per batch: a kill costs at most one un-checkpointed batch', async () => {
    const tag = 'checkpoint';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const pages: Record<string, PageSpec> = {
      [entry]: { html: pageHtml('Home', BODY, Array.from({ length: 9 }, (_, i) => `/p${i}`)) },
    };
    for (let i = 0; i < 9; i++) {
      pages[`${origin}/p${i}`] = { html: pageHtml(`P${i}`, BODY) };
    }
    // 10 pages x 6 chunks = 60 chunks -> batches of 32, 28.
    const caps = { chunkTokens: 5, chunkOverlapTokens: 2 };

    // Run 1: batch 1 commits (32 vectors), batch 2 kills the run.
    const run1 = setup(tag, { pages, caps, failEmbedOn: (batchId) => batchId === 2 });
    const killed = await crawlSite(origin, entry, run1.deps);
    expect(killed).toMatchObject({ status: 'failed', chunkCount: 32 });
    expect(run1.embedLog).toEqual([
      { batchId: 1, chunks: 32 },
      { batchId: 2, chunks: 28 },
    ]);

    // Run 2: only the 28 pending chunks are re-embedded; counts include the
    // committed batch so the site total is reported correctly.
    const run2 = setup(tag, { pages, caps });
    const outcome = await crawlSite(origin, entry, run2.deps);
    expect(outcome).toMatchObject({ status: 'ready', pages: 10, chunkCount: 60 });
    expect(outcome.sizeEstimateBytes).toBe(estimateSiteSize(60));
    expect(run2.embedLog).toEqual([{ batchId: 1, chunks: 28 }]);
    await withDb(origin, async (db) => {
      expect((await getMeta(db, origin))?.chunkCount).toBe(60);
      expect(await countPendingChunks(db)).toBe(0);
    });
  });

  it('skips re-embedding when content is unchanged on refresh', async () => {
    const tag = 'refresh';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const pages = { [entry]: { html: pageHtml('Home', BODY) } };

    const run1 = setup(tag, { pages });
    const first = await crawlSite(origin, entry, run1.deps);
    expect(first).toMatchObject({ status: 'ready', chunkCount: 1 });

    const run2 = setup(tag, { pages });
    const second = await crawlSite(origin, entry, run2.deps);

    expect(second).toMatchObject({ status: 'ready', chunkCount: 1 });
    expect(run2.embedLog).toEqual([]);
    await withDb(origin, async (db) => {
      expect(await countChunks(db)).toBe(1);
      expect(await countPendingChunks(db)).toBe(0);
    });
  });

  it('short-circuits unchanged pages via ETag 304', async () => {
    const tag = 'etag';
    const origin = originOf(tag);
    const entry = `${origin}/`;

    const run1 = setup(tag, { pages: { [entry]: { html: pageHtml('Home', BODY), etag: '"v1"' } } });
    const first = await crawlSite(origin, entry, run1.deps);
    expect(first).toMatchObject({ status: 'ready', chunkCount: 1 });

    const run2 = setup(tag, { pages: { [entry]: { ok: false, status: 304, etag: '"v1"' } } });
    const second = await crawlSite(origin, entry, run2.deps);

    expect(second).toMatchObject({ status: 'ready', chunkCount: 1 });
    expect(run2.embedLog).toEqual([]);
    await withDb(origin, async (db) => {
      const [page] = await listPages(db);
      expect(page?.etag).toBe('"v1"');
      expect(await countChunks(db)).toBe(1);
    });
  });

  it('records non-article pages with zero chunks', async () => {
    const tag = 'empty';
    const origin = originOf(tag);
    const entry = `${origin}/`;
    const { deps } = setup(tag, {
      pages: { [entry]: { html: '<!doctype html><html><body></body></html>' } },
    });

    const outcome = await crawlSite(origin, entry, deps);

    expect(outcome).toMatchObject({ status: 'ready', pages: 1, chunkCount: 0 });
    await withDb(origin, async (db) => {
      const [page] = await listPages(db);
      expect(page?.contentHash).toBe('');
      expect(await countChunks(db)).toBe(0);
      expect(await getFailedQueueItems(db)).toEqual([]);
    });
  });
});
