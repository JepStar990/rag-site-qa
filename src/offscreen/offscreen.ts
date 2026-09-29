/**
 * Runtime host on Chromium (ADR-0001): a headless offscreen document that
 * runs embedding inference, merges vectors into the site database, and
 * streams DeepSeek answers. Batches arrive over the `siteqa-host` port from
 * the service worker; each is embedded, written, and acknowledged — the
 * write commit is the checkpoint the crawler waits for (docs/03).
 *
 * QA streams run through {@link StreamLifecycle} (ADR-0010): if the SW
 * port dies mid-stream, the stream finishes here and the terminal
 * transcript is written from this document, so a completed answer is never
 * lost to a re-ask.
 *
 * The API key arrives inside one `start-stream` frame and lives only in
 * that listener's fetch headers; it is never stored here (docs/04).
 */

import { browserApi } from '../shared/browser-api';
import {
  isEmbedBatchFrame,
  isEmbedQueryFrame,
  isStartStreamFrame,
  isStreamStatusFrame,
  isTrustedPort,
  PORT,
  type HostPortEvent,
} from '../shared/msg-protocol';
import { createEmbedder, runEmbedBatch } from '../lib/embed/embedder';
import { adaptFetch, streamChat } from '../lib/llm/stream-client';
import { parseCitations } from '../lib/qa/citations';
import { addSpend, getStoredSettings } from '../background/storage/settings-store';
import { StreamLifecycle } from './stream-takeover';

/** In-flight QA streams keyed by requestId; consulted by stream-status queries. */
const streams = new Map<string, StreamLifecycle>();

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

    if (isStreamStatusFrame(value)) {
      // Fresh-port status query from the SW (get-qa-stream). Replies active
      // while the lifecycle may still produce a terminal state — including
      // a takeover write in flight (ADR-0010).
      port.postMessage({
        type: 'stream-status-reply',
        requestId: value.requestId,
        active: streams.has(value.requestId),
      } satisfies HostPortEvent);
      return;
    }

    if (isStartStreamFrame(value)) {
      const lifecycle = new StreamLifecycle(
        {
          requestId: value.requestId,
          origin: value.origin,
          question: value.question,
          askedAt: value.askedAt,
          messages: value.messages,
          apiKey: value.apiKey,
          modelPrefs: value.modelPrefs,
          citationDocs: value.citationDocs,
          post: (frame) => port.postMessage(frame),
        },
        {
          streamChat: (req, deps, onDelta, onRetry) => streamChat(req, deps, onDelta, onRetry),
          streamDeps: () => ({
            fetch: adaptFetch(fetch),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          }),
          parseCitations,
          addSpend,
          readBudgetSpentUsd: async () => (await getStoredSettings()).budget.spentThisMonthUsd,
          setSession: (key, session) => browserApi.storage.session.set({ [key]: session }),
        },
      );
      streams.set(value.requestId, lifecycle);
      port.onDisconnect.addListener(() => lifecycle.disconnect());
      // Remove the entry synchronously with terminal settle: a normal
      // host.dispose() disconnect must never look like a takeover (ADR-0010).
      void lifecycle.run().finally(() => {
        if (streams.get(value.requestId) === lifecycle) streams.delete(value.requestId);
      });
    }
  });
});
