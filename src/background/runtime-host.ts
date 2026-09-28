/**
 * Runtime host switch (ADR-0001, ADR-0009): the only code path that knows
 * which platform it runs on.
 *
 * Chromium: an offscreen document hosts embedding inference and the DeepSeek
 * stream, reached over the `siteqa-host` port. The document is created on
 * demand (only one may exist) and reused while it lives; batches are
 * correlated on `batchId`, QA streams on `requestId`.
 * Firefox: the background event page itself is the host, so everything runs
 * in-process and each parent extension-API call resets the idle timer
 * (Bug 1844041).
 */

import { browserApi } from '../shared/browser-api';
import {
  isEmbedQueryResultFrame,
  isHostFrame,
  isStreamFrame,
  PORT,
  type HostPortEvent,
  type StreamError,
} from '../shared/msg-protocol';
import type { ChatMessage, ModelPrefs, QaUsage } from '../shared/types';
import { runEmbedBatch } from '../lib/embed/embedder';
import { createEmbedder } from '../lib/embed/embedder';
import { adaptFetch, streamChat, type StreamDeps } from '../lib/llm/stream-client';
import type { EmbedBatchRequest } from '../lib/crawl/crawl';

export interface StreamChatRequest {
  requestId: string;
  messages: ChatMessage[];
  apiKey: string;
  modelPrefs: ModelPrefs;
}

export interface RuntimeHost {
  /** Resolves only after the host committed the batch's vectors (the checkpoint). */
  embedBatch(req: EmbedBatchRequest): Promise<void>;
  /** One embedding pass for a query (no database write). */
  embedQuery(texts: string[]): Promise<Float32Array[]>;
  /** Runs the DeepSeek stream; deltas and retries surface as they happen. */
  streamChat(
    req: StreamChatRequest,
    onDelta: (delta: string) => void,
    onRetry: () => void,
  ): Promise<{ usage: QaUsage | null }>;
  dispose(): Promise<void>;
}

const EMBED_TIMEOUT_MS = 120_000;
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

export function createRuntimeHost(opts: { modelPath: string }): Promise<RuntimeHost> {
  // The Chromium host never sees the model path: the offscreen document
  // derives it from its own runtime (ADR-0001).
  return 'offscreen' in browserApi ? createChromiumHost() : createFirefoxHost(opts);
}

/** Firefox: the event page embeds and streams in-process via the shared runners. */
function createFirefoxHost(opts: { modelPath: string }): Promise<RuntimeHost> {
  return Promise.resolve({
    embedBatch: (req) => runEmbedBatch(req, opts),
    embedQuery: async (texts) => {
      const embedder = await createEmbedder(opts);
      return embedder.embed(texts);
    },
    streamChat: (req, onDelta, onRetry) =>
      streamChat(
        { messages: req.messages, apiKey: req.apiKey, modelPrefs: req.modelPrefs },
        realStreamDeps(),
        onDelta,
        onRetry,
      ),
    dispose: async () => {},
  });
}

/** Real seams for the in-process (Firefox) client: browser fetch and timers. */
function realStreamDeps(): StreamDeps {
  return {
    fetch: adaptFetch(fetch),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function createChromiumHost(): Promise<RuntimeHost> {
  let port: chrome.runtime.Port | null = null;
  let nextBatchId = 1;

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

  async function embedQuery(texts: string[]): Promise<Float32Array[]> {
    const p = await ensurePort();
    const batchId = nextBatchId++;
    return new Promise<Float32Array[]>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => fail(new Error('Query embedding timed out.')), EMBED_TIMEOUT_MS);
      const onMessage = (value: unknown) => {
        if (!isEmbedQueryResultFrame(value) || value.batchId !== batchId) return;
        if (value.type === 'embed-query-done') {
          settled = true;
          cleanup();
          resolve(value.vecs);
        } else if (value.type === 'embed-query-error') {
          fail(new Error(value.error));
        }
      };
      const onDisconnect = () => fail(new Error('Runtime host disconnected during query embedding.'));
      const cleanup = () => {
        clearTimeout(timer);
        p.onMessage.removeListener(onMessage);
        p.onDisconnect.removeListener(onDisconnect);
      };

      p.onMessage.addListener(onMessage);
      p.onDisconnect.addListener(onDisconnect);
      p.postMessage({ type: 'embed-query', batchId, texts } satisfies HostPortEvent);
    });
  }

  async function streamChat(
    req: StreamChatRequest,
    onDelta: (delta: string) => void,
    onRetry: () => void,
  ): Promise<{ usage: QaUsage | null }> {
    const p = await ensurePort();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: StreamError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onMessage = (value: unknown) => {
        if (!isStreamFrame(value) || value.requestId !== req.requestId) return;
        if (value.type === 'stream-chunk') {
          onDelta(value.delta);
        } else if (value.type === 'stream-retry') {
          onRetry();
        } else if (value.type === 'stream-done') {
          settled = true;
          cleanup();
          resolve({ usage: value.usage });
        } else if (value.type === 'stream-error') {
          fail(value.error);
        }
      };
      const onDisconnect = () =>
        fail({ reason: 'network', message: 'Could not reach DeepSeek. Check your connection.' });
      const cleanup = () => {
        p.onMessage.removeListener(onMessage);
        p.onDisconnect.removeListener(onDisconnect);
      };

      p.onMessage.addListener(onMessage);
      p.onDisconnect.addListener(onDisconnect);
      p.postMessage({
        type: 'start-stream',
        requestId: req.requestId,
        messages: req.messages,
        apiKey: req.apiKey,
        modelPrefs: req.modelPrefs,
      } satisfies HostPortEvent);
    });
  }

  return {
    embedBatch,
    embedQuery,
    streamChat,
    dispose: async () => {
      port?.disconnect();
      port = null;
      if (await browserApi.offscreen.hasDocument()) await browserApi.offscreen.closeDocument();
    },
  };
}
