/**
 * Runtime host switch (ADR-0001, ADR-0009): the only code path that knows
 * which platform it runs on.
 *
 * Chromium: an offscreen document hosts embedding inference, reached over
 * the `siteqa-host` port. The document is created on demand (only one may
 * exist) and reused while it lives; batches are correlated on `batchId`.
 * Firefox: the background event page itself is the host, so batches run
 * in-process and the per-batch IDB commit keeps the event page alive
 * (parent API calls reset the idle timer, Bug 1844041).
 */

import { browserApi } from '../shared/browser-api';
import { isHostFrame, PORT, type HostPortEvent } from '../shared/msg-protocol';
import { runEmbedBatch } from '../lib/embed/embedder';
import type { EmbedBatchRequest } from '../lib/crawl/crawl';

export interface RuntimeHost {
  /** Resolves only after the host committed the batch's vectors (the checkpoint). */
  embedBatch(req: EmbedBatchRequest): Promise<void>;
  dispose(): Promise<void>;
}

const EMBED_TIMEOUT_MS = 120_000;
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

export function createRuntimeHost(opts: { modelPath: string }): Promise<RuntimeHost> {
  // The Chromium host never sees the model path: the offscreen document
  // derives it from its own runtime (ADR-0001).
  return 'offscreen' in browserApi ? createChromiumHost() : createFirefoxHost(opts);
}

/** Firefox: the event page embeds in-process via the shared batch runner. */
function createFirefoxHost(opts: { modelPath: string }): Promise<RuntimeHost> {
  return Promise.resolve({
    embedBatch: (req) => runEmbedBatch(req, opts),
    dispose: async () => {},
  });
}

async function createChromiumHost(): Promise<RuntimeHost> {
  let port: chrome.runtime.Port | null = null;

  async function ensurePort(): Promise<chrome.runtime.Port> {
    if (port) return port;
    if (!(await browserApi.offscreen.hasDocument())) {
      await browserApi.offscreen.createDocument({
        url: browserApi.runtime.getURL(OFFSCREEN_PATH),
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Local embedding inference during site indexing (ADR-0001)',
      });
    }
    const p = browserApi.runtime.connect({ name: PORT.host });
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
    });
    port = p;
    return p;
  }

  async function embedBatch(req: EmbedBatchRequest): Promise<void> {
    const p = await ensurePort();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => fail(new Error('Embedding batch timed out.')), EMBED_TIMEOUT_MS);
      const onMessage = (value: unknown) => {
        if (!isHostFrame(value) || value.batchId !== req.batchId) return;
        if (value.type === 'embed-done') {
          settled = true;
          cleanup();
          resolve();
        } else if (value.type === 'embed-error') {
          fail(new Error(value.error));
        }
      };
      const onDisconnect = () => fail(new Error('Runtime host disconnected during embedding.'));
      const cleanup = () => {
        clearTimeout(timer);
        p.onMessage.removeListener(onMessage);
        p.onDisconnect.removeListener(onDisconnect);
      };

      p.onMessage.addListener(onMessage);
      p.onDisconnect.addListener(onDisconnect);
      p.postMessage({
        type: 'embed-batch',
        dbName: req.dbName,
        batchId: req.batchId,
        chunks: req.chunks,
      } satisfies HostPortEvent);
    });
  }

  return {
    embedBatch,
    dispose: async () => {
      port?.disconnect();
      port = null;
      if (await browserApi.offscreen.hasDocument()) await browserApi.offscreen.closeDocument();
    },
  };
}
