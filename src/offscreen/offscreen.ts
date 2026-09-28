/**
 * Runtime host on Chromium (ADR-0001): a headless offscreen document that
 * runs embedding inference, merges vectors into the site database, and
 * streams DeepSeek answers. Batches arrive over the `siteqa-host` port from
 * the service worker; each is embedded, written, and acknowledged — the
 * write commit is the checkpoint the crawler waits for (docs/03).
 *
 * The API key arrives inside one `start-stream` frame and lives only in
 * that listener's fetch headers; it is never stored here (docs/04).
 */

import { browserApi } from '../shared/browser-api';
import {
  isEmbedBatchFrame,
  isEmbedQueryFrame,
  isStartStreamFrame,
  isTrustedPort,
  PORT,
  type HostPortEvent,
} from '../shared/msg-protocol';
import { createEmbedder, runEmbedBatch } from '../lib/embed/embedder';
import { adaptFetch, streamChat, toStreamError } from '../lib/llm/stream-client';

browserApi.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT.host || !isTrustedPort(port)) {
    port.disconnect();
    return;
  }

  port.onMessage.addListener((value: unknown) => {
    if (isEmbedBatchFrame(value)) {
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
      return;
    }

    if (isEmbedQueryFrame(value)) {
      const modelPath = browserApi.runtime.getURL('models/');
      void createEmbedder({ modelPath, device: 'auto' })
        .then((embedder) => embedder.embed(value.texts))
        .then((vecs) => {
          port.postMessage({
            type: 'embed-query-done',
            batchId: value.batchId,
            vecs,
          } satisfies HostPortEvent);
        })
        .catch((err: unknown) => {
          port.postMessage({
            type: 'embed-query-error',
            batchId: value.batchId,
            error: err instanceof Error ? err.message : 'embedding failed',
          } satisfies HostPortEvent);
        });
      return;
    }

    if (isStartStreamFrame(value)) {
      void streamChat(
        {
          messages: value.messages,
          apiKey: value.apiKey,
          modelPrefs: value.modelPrefs,
        },
        {
          fetch: adaptFetch(fetch),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
        (delta) => {
          port.postMessage({
            type: 'stream-chunk',
            requestId: value.requestId,
            delta,
          } satisfies HostPortEvent);
        },
        () => {
          port.postMessage({
            type: 'stream-retry',
            requestId: value.requestId,
          } satisfies HostPortEvent);
        },
      )
        .then(({ usage }) => {
          port.postMessage({
            type: 'stream-done',
            requestId: value.requestId,
            usage,
          } satisfies HostPortEvent);
        })
        .catch((err: unknown) => {
          port.postMessage({
            type: 'stream-error',
            requestId: value.requestId,
            error: toStreamError(err),
          } satisfies HostPortEvent);
        });
    }
  });
});
