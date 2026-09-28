/**
 * `index-site` handler (docs/03): wires the pure crawl orchestrator to real
 * browser services — fetch, IndexedDB, the runtime host, the transformers.js
 * tokenizer, and a heartbeat that resets MV3 idle timers on both platforms
 * (parent extension-API calls keep the worker alive, ADR-0001).
 */

import { browserApi } from '../../shared/browser-api';
import { crawlSite, type FetchResult } from '../../lib/crawl/crawl';
import { createTransformersTokenizer } from '../../lib/ingest/transformers-tokenizer';
import { openSiteDb } from '../../lib/db/site-db';
import { getStoredSettings } from '../storage/settings-store';
import type { ProgressHub } from '../progress-hub';
import { createRuntimeHost } from '../runtime-host';

const HEARTBEAT_INTERVAL_MS = 10_000;

/** Per-origin in-flight guard. Module scope is safe: a teardown just loses it. */
const inflight = new Map<string, Promise<void>>();

export type IndexStartResult = 'started' | 'permission-denied' | 'already-running';

export async function indexSite(origin: string, entryUrl: string, hub: ProgressHub): Promise<IndexStartResult> {
  const granted = await browserApi.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) return 'permission-denied';
  if (inflight.has(origin)) return 'already-running';

  const run = runIndex(origin, entryUrl, hub).finally(() => inflight.delete(origin));
  inflight.set(origin, run);
  return 'started';
}

async function runIndex(origin: string, entryUrl: string, hub: ProgressHub): Promise<void> {
  const settings = await getStoredSettings();
  const modelPath = browserApi.runtime.getURL('models/');
  const host = await createRuntimeHost({ modelPath });
  const heartbeat = setInterval(() => {
    void browserApi.storage.local.set({ heartbeat: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const outcome = await crawlSite(origin, entryUrl, {
      fetch: fetchPage,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      tokenizer: await createTransformersTokenizer(modelPath),
      caps: settings.caps,
      openDb: () => openSiteDb(origin),
      embedBatch: (req) => host.embedBatch(req),
      onProgress: (event) => hub.broadcast(origin, event),
    });

    if (outcome.status === 'ready') {
      hub.broadcast(origin, {
        type: 'index-ready',
        origin,
        chunkCount: outcome.chunkCount,
        sizeEstimateBytes: outcome.sizeEstimateBytes,
      });
    } else {
      hub.broadcast(origin, {
        type: 'index-failed',
        origin,
        reason: outcome.reason ?? 'Indexing failed.',
      });
    }
  } finally {
    clearInterval(heartbeat);
    await host.dispose();
  }
}

/**
 * Crawls never carry user credentials. The extension has no cookies for the
 * target site (04), and `credentials: 'omit'` keeps it that way even where
 * the browser could attach ambient credentials.
 */
async function fetchPage(url: string, headers?: Record<string, string>): Promise<FetchResult> {
  const res = await fetch(url, { credentials: 'omit', headers });
  return {
    ok: res.ok,
    status: res.status,
    url: res.url,
    headers: { get: (name) => res.headers.get(name) },
    text: () => res.text(),
  };
}
