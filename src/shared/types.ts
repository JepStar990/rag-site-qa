/**
 * Core domain types for SiteQA.
 *
 * These mirror docs/05-data-model.md and are the single source of truth for
 * record shapes shared across the background worker, offscreen document,
 * popup, and options contexts.
 */

/** Per-user configuration stored in chrome.storage.local (ADR-0006). */
export interface Settings {
  apiKey: string | null;
  modelPrefs: ModelPrefs;
  budget: BudgetConfig;
  caps: CrawlCaps;
  retrieval: RetrievalConfig;
}

export interface ModelPrefs {
  /** DeepSeek model ID: 'deepseek-v4-flash' (default) | 'deepseek-v4-pro' | custom. */
  modelId: string;
  /** V4 models default to thinking ON; sent explicitly on every request. */
  thinking: boolean;
  /** Ignored by DeepSeek while thinking is on. Null = omit the field. */
  temperature: number | null;
  maxOutputTokens: number;
}

export interface BudgetConfig {
  /** Monthly spend limit in USD. Estimator only: DeepSeek has no server-side cap for BYOK. */
  monthlyLimitUsd: number;
  /** Approximate spend this month, tracked locally from usage fields in responses. */
  spentThisMonthUsd: number;
  /** USD per 1M tokens, user-editable (prices change; see docs/06-llm-integration.md). */
  pricePerMTokens: { input: number; output: number };
}

export interface CrawlCaps {
  maxPages: number;
  /** Link-discovery depth below the entry page. Sitemap pages are not depth-limited. */
  maxDepth: number;
  maxChunksPerSite: number;
  /** Delay between fetches, clamped to 250-1000ms (politeness band). */
  politenessMs: number;
  chunkTokens: number;
  chunkOverlapTokens: number;
}

export interface RetrievalConfig {
  topK: number;
  /** Token budget for the assembled <documents> context block. */
  contextTokenBudget: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: null,
  modelPrefs: {
    modelId: 'deepseek-v4-flash',
    thinking: false,
    temperature: 0.3,
    maxOutputTokens: 2048,
  },
  budget: {
    monthlyLimitUsd: 5,
    spentThisMonthUsd: 0,
    pricePerMTokens: { input: 0.07, output: 0.28 },
  },
  caps: {
    maxPages: 1000,
    maxDepth: 6,
    maxChunksPerSite: 50000,
    politenessMs: 500,
    chunkTokens: 512,
    chunkOverlapTokens: 64,
  },
  retrieval: {
    topK: 8,
    contextTokenBudget: 8000,
  },
};

/** Both supported embedding models are 384-dim, so vectors are interchangeable. */
export const EMBED_DIM = 384;

/* IndexedDB records. One database per origin, named site-<hash16> (ADR-0005). */

export interface PageRecord {
  /** sha256(url) hex. */
  urlHash: string;
  url: string;
  title: string;
  etag: string | null;
  /** sha256 of extracted article text; skip re-embedding when unchanged. */
  contentHash: string;
  /** Heading outline, used as chunk metadata for citations. */
  headings: string[];
  crawledAt: number;
}

export interface ChunkRecord {
  /** `${urlHash}:${order}`. */
  chunkId: string;
  urlHash: string;
  text: string;
  tokens: number;
  /** Nearest heading path, e.g. "Installation > Requirements". */
  headingPath: string;
  order: number;
  /** 384-dim normalized embedding (EMBED_DIM). */
  vec: Float32Array;
}

export type CrawlQueueStatus = 'queued' | 'fetching' | 'done' | 'failed';

export interface CrawlQueueItem {
  url: string;
  depth: number;
  status: CrawlQueueStatus;
  attempts: number;
}

export type SiteIndexStatus = 'idle' | 'crawling' | 'embedding' | 'ready' | 'failed';

export interface SiteMeta {
  origin: string;
  status: SiteIndexStatus;
  lastCrawledAt: number | null;
  chunkCount: number;
  sizeEstimateBytes: number;
}

/** One row of the popup sources view (docs/03): page, chunk count, crawl time. */
export interface SourceInfo {
  url: string;
  title: string;
  chunkCount: number;
  crawledAt: number;
}
