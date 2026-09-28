/**
 * Runtime host on Chromium (ADR-0001): a headless offscreen document that
 * runs embedding inference and merges vectors into the site database.
 * Batches arrive over the `siteqa-host` port from the service worker; each
 * is embedded, written, and acknowledged — the write commit is the
 * checkpoint the crawler waits for (docs/03).
 */

import { browserApi } from '../shared/browser-api';
import { isEmbedBatchFrame, isTrustedPort, PORT, type HostPortEvent } from '../shared/msg-protocol';
import { runEmbedBatch } from '../lib/embed/embedder';

browserApi.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT.host || !isTrustedPort(port)) {
    port.disconnect();
    return;
  }

  port.onMessage.addListener((value: unknown) => {
    if (!isEmbedBatchFrame(value)) return;
    const modelPath = browserApi.runtime.getURL('models/');
    void runEmbedBatch({ dbName: value.dbName, chunks: value.chunks }, { modelPath, device: 'auto' })
      .then(() => {
        port.postMessage({
          type: 'embed-done',
          dbName: value.dbName,
          batchId: value.batchId,
          embedded: value.chunks.length,
        } satisfies HostPortEvent);
      })
      .catch((err: unknown) => {
        port.postMessage({
          type: 'embed-error',
          dbName: value.dbName,
          batchId: value.batchId,
          error: err instanceof Error ? err.message : 'embedding failed',
        } satisfies HostPortEvent);
      });
  });
});
