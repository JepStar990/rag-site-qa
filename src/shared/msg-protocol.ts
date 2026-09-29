/**
 * Message protocol between extension contexts (docs/03-component-design.md).
 *
 * Security rules (docs/04-security-threat-model.md):
 * - no `externally_connectable`; every sender must pass `isTrustedSender`
 * - every payload passes `parseMessage` before dispatch; malformed messages
 *   are dropped silently
 * - the API key never travels over the bus: `get-settings` responses null it,
 *   and key writes happen only from the options page directly to storage
 * - ports are gated by `isTrustedPort` on connect; port payloads are
 *   shape-validated before use
 */

import type {
  ChatMessage,
  CitationDoc,
  ModelPrefs,
  QaCitation,
  QaErrorReason,
  QaUsage,
  Settings,
  SiteIndexStatus,
  SourceInfo,
} from './types';
import { EMBED_DIM } from './types';
import { isSameOrigin, normalizeUrl } from './url';

export const MSG = {
  getSettings: 'get-settings',
  saveSettings: 'save-settings',
  getSiteStatus: 'get-site-status',
  listSources: 'list-sources',
  indexSite: 'index-site',
  ask: 'ask-site',
  getQaStream: 'get-qa-stream',
} as const;

export type Message =
  | { type: typeof MSG.getSettings }
  | { type: typeof MSG.saveSettings; settings: unknown }
  | { type: typeof MSG.getSiteStatus; origin: string }
  | { type: typeof MSG.listSources; origin: string }
  | { type: typeof MSG.indexSite; origin: string; url: string }
  | { type: typeof MSG.ask; origin: string; question: string; requestId: string }
  | { type: typeof MSG.getQaStream; origin: string; requestId: string };

/** The only failure a one-shot request can hit before the stream starts (docs/03). */
export type AskRejectReason = 'permission' | 'not-indexed' | 'no-key' | 'spend-cap' | 'busy';

/** Popup-facing site summary for the status and storage readouts (docs/03). */
export interface SiteStatusMeta {
  chunkCount: number;
  sizeEstimateBytes: number;
  lastCrawledAt: number | null;
}

/** A queue item that gave up after repeated failures (sources view). */
export interface FailedUrl {
  url: string;
  attempts: number;
}

/** Discriminated on `kind` because both success variants share `ok: true`. */
export type MessageResponse =
  | { ok: true; kind: 'settings'; settings: Settings }
  | { ok: true; kind: 'status'; status: SiteIndexStatus | 'inactive'; meta: SiteStatusMeta | null }
  | { ok: true; kind: 'sources'; sources: SourceInfo[]; failed: FailedUrl[] }
  | { ok: true; kind: 'indexing'; origin: string }
  | { ok: true; kind: 'asking'; origin: string }
  | { ok: true; kind: 'qa-stream'; active: boolean; heldBySw: boolean }
  | { ok: false; error: AskRejectReason | 'unhandled' };

/** Port names (docs/03): popup progress events, and the SW -> runtime host channel. */
export const PORT = {
  progress: 'siteqa-progress',
  host: 'siteqa-host',
} as const;

/** Popup -> SW port payload: subscribe to progress for one origin. */
export type PopupPortEvent = { type: 'subscribe'; origin: string };

/** SW -> popup port events (docs/03 message table). */
export type ProgressPortEvent =
  | {
      type: 'index-progress';
      origin: string;
      phase: 'crawling' | 'embedding';
      pages: number;
      chunks: number;
      totalChunks: number;
    }
  | { type: 'index-ready'; origin: string; chunkCount: number; sizeEstimateBytes: number }
  | { type: 'index-failed'; origin: string; reason: string }
  | { type: 'answer-token'; requestId: string; origin: string; delta: string }
  | { type: 'answer-retry'; requestId: string; origin: string }
  | {
      type: 'answer-done';
      requestId: string;
      origin: string;
      answer: string;
      citations: QaCitation[];
      usage: QaUsage | null;
      costUsd: number | null;
      spentThisMonthUsd: number;
    }
  | { type: 'answer-error'; requestId: string; origin: string; reason: QaErrorReason; message: string };

/** A stream error that can surface over the host port (docs/06 matrix). */
export type StreamError = { reason: QaErrorReason; message: string };

/**
 * SW <-> runtime host frames over the `siteqa-host` port. Batches are
 * correlated on `batchId`; QA streams on `requestId` (docs/03).
 */
export type HostPortEvent =
  | {
      type: 'embed-batch';
      dbName: string;
      batchId: number;
      chunks: { chunkId: string; text: string }[];
    }
  | { type: 'embed-done'; dbName: string; batchId: number; embedded: number }
  | { type: 'embed-error'; dbName: string; batchId: number; error: string }
  | { type: 'embed-query'; batchId: number; texts: string[] }
  | { type: 'embed-query-done'; batchId: number; vecs: Float32Array[] }
  | { type: 'embed-query-error'; batchId: number; error: string }
  | {
      type: 'start-stream';
      requestId: string;
      /** Session context for the takeover transcript the host writes if the SW dies (ADR-0010). */
      origin: string;
      question: string;
      askedAt: number;
      citationDocs: CitationDoc[];
      messages: ChatMessage[];
      apiKey: string;
      modelPrefs: ModelPrefs;
    }
  | { type: 'stream-chunk'; requestId: string; delta: string }
  | { type: 'stream-retry'; requestId: string }
  | { type: 'stream-done'; requestId: string; usage: QaUsage | null }
  | { type: 'stream-error'; requestId: string; error: StreamError }
  | { type: 'stream-status'; requestId: string }
  | { type: 'stream-status-reply'; requestId: string; active: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

/** Request IDs are popup-generated, e.g. `q<timestamp><random>` (docs/03). */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * True for a canonical http(s) origin string, e.g. "https://example.com".
 * The `u.origin === v` equality enforces canonical form (lowercase host, no
 * path or credentials); rejecting explicit ports is required because
 * permission match patterns cannot carry them.
 */
export function isValidOrigin(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === v && u.port === ''
    );
  } catch {
    return false;
  }
}

/**
 * Entry URLs arrive from the popup but are never trusted as crawl targets
 * (04): the SW re-derives them, requires same-origin with the granted
 * origin, and normalizes before dispatch. Returns the normalized URL.
 */
function normalizeEntryUrl(origin: string, url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return null;
  const normalized = normalizeUrl(url);
  return normalized !== null && isSameOrigin(normalized, origin) ? normalized : null;
}

/** Shape-validates an inbound message; returns null for anything malformed. */
export function parseMessage(value: unknown): Message | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case MSG.getSettings:
      return { type: MSG.getSettings };
    case MSG.saveSettings:
      return isRecord(value.settings) ? { type: MSG.saveSettings, settings: value.settings } : null;
    case MSG.getSiteStatus:
      return isValidOrigin(value.origin) ? { type: MSG.getSiteStatus, origin: value.origin } : null;
    case MSG.listSources:
      return isValidOrigin(value.origin) ? { type: MSG.listSources, origin: value.origin } : null;
    case MSG.indexSite: {
      if (!isValidOrigin(value.origin)) return null;
      const url = normalizeEntryUrl(value.origin, value.url);
      return url !== null ? { type: MSG.indexSite, origin: value.origin, url } : null;
    }
    case MSG.ask: {
      if (!isValidOrigin(value.origin)) return null;
      const question = typeof value.question === 'string' ? value.question.trim() : '';
      if (question.length === 0 || question.length > 4000) return null;
      const requestId = typeof value.requestId === 'string' ? value.requestId : '';
      if (!REQUEST_ID_RE.test(requestId)) return null;
      return { type: MSG.ask, origin: value.origin, question, requestId };
    }
    case MSG.getQaStream: {
      if (!isValidOrigin(value.origin)) return null;
      const requestId = typeof value.requestId === 'string' ? value.requestId : '';
      if (!REQUEST_ID_RE.test(requestId)) return null;
      return { type: MSG.getQaStream, origin: value.origin, requestId };
    }
    default:
      return null;
  }
}

/** Shape-validates an inbound popup port payload; returns null when malformed. */
export function parsePortEvent(value: unknown): PopupPortEvent | null {
  if (!isRecord(value) || value.type !== 'subscribe' || !isValidOrigin(value.origin)) return null;
  return { type: 'subscribe', origin: value.origin };
}

/** Shape-validates an inbound `embed-batch` frame on the host port. */
export function isEmbedBatchFrame(value: unknown): value is HostPortEvent & { type: 'embed-batch' } {
  if (!isRecord(value) || value.type !== 'embed-batch') return false;
  if (typeof value.dbName !== 'string' || typeof value.batchId !== 'number') return false;
  if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > 64) return false;
  return value.chunks.every(
    (c) =>
      isRecord(c) &&
      typeof c.chunkId === 'string' &&
      typeof c.text === 'string' &&
      c.text.length > 0,
  );
}

/** Shape-validates an inbound `embed-done` / `embed-error` frame on the host port. */
export function isHostFrame(value: unknown): value is HostPortEvent & {
  type: 'embed-done' | 'embed-error';
} {
  if (!isRecord(value) || typeof value.batchId !== 'number' || typeof value.dbName !== 'string') return false;
  if (value.type === 'embed-done') return typeof value.embedded === 'number';
  if (value.type === 'embed-error') return typeof value.error === 'string';
  return false;
}

/** Shape-validates an inbound `embed-query` frame on the host port. */
export function isEmbedQueryFrame(value: unknown): value is HostPortEvent & { type: 'embed-query' } {
  if (!isRecord(value) || value.type !== 'embed-query' || typeof value.batchId !== 'number') return false;
  if (!Array.isArray(value.texts) || value.texts.length === 0 || value.texts.length > 8) return false;
  return value.texts.every((t) => typeof t === 'string' && t.length > 0);
}

const isVec = (v: unknown): v is Float32Array =>
  v instanceof Float32Array && v.length === EMBED_DIM;

/** Shape-validates an inbound `embed-query-done` / `embed-query-error` frame. */
export function isEmbedQueryResultFrame(value: unknown): value is HostPortEvent & {
  type: 'embed-query-done' | 'embed-query-error';
} {
  if (!isRecord(value) || typeof value.batchId !== 'number') return false;
  if (value.type === 'embed-query-done') {
    return Array.isArray(value.vecs) && value.vecs.length > 0 && value.vecs.every(isVec);
  }
  if (value.type === 'embed-query-error') return typeof value.error === 'string';
  return false;
}

const isChatMessage = (v: unknown): v is ChatMessage =>
  isRecord(v) && (v.role === 'system' || v.role === 'user') && typeof v.content === 'string';

// Keep in sync with stream-client.ts's list. `interrupted` must never be
// added: it is a popup-side synthetic reason, not something a host may send.
const STREAM_ERROR_REASONS: readonly string[] = [
  'invalid_key',
  'no_balance',
  'rate_limited',
  'provider',
  'network',
  'bad_request',
  'too_large',
];

const isStreamError = (v: unknown): v is StreamError =>
  isRecord(v) &&
  typeof v.reason === 'string' &&
  STREAM_ERROR_REASONS.includes(v.reason) &&
  typeof v.message === 'string';

const isCitationDoc = (v: unknown): v is CitationDoc => {
  if (!isRecord(v)) return false;
  if (typeof v.index !== 'number' || !Number.isInteger(v.index) || v.index < 1 || v.index > 999) return false;
  if (typeof v.url !== 'string' || v.url.length === 0 || v.url.length > 4096) return false;
  if (typeof v.title !== 'string' || v.title.length > 1024) return false;
  // Heading paths may be empty (chunks without a heading) but never absurd.
  if (typeof v.headingPath !== 'string' || v.headingPath.length > 1024) return false;
  return true;
};

/** Shape-validates an inbound `start-stream` frame on the host port. */
export function isStartStreamFrame(value: unknown): value is HostPortEvent & { type: 'start-stream' } {
  if (!isRecord(value) || value.type !== 'start-stream') return false;
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
  // Session context for the takeover transcript (ADR-0010); all fields
  // required — SW and host ship together, no compat window.
  if (!isValidOrigin(value.origin)) return false;
  if (typeof value.question !== 'string' || value.question.length === 0 || value.question.length > 4000) return false;
  if (typeof value.askedAt !== 'number' || !Number.isFinite(value.askedAt)) return false;
  if (!Array.isArray(value.citationDocs) || value.citationDocs.length > 64 || !value.citationDocs.every(isCitationDoc)) {
    return false;
  }
  if (typeof value.apiKey !== 'string' || value.apiKey.length === 0) return false;
  if (!Array.isArray(value.messages) || value.messages.length < 2 || !value.messages.every(isChatMessage)) return false;
  const prefs = value.modelPrefs;
  if (!isRecord(prefs) || typeof prefs.modelId !== 'string' || prefs.modelId.length === 0) return false;
  if (typeof prefs.thinking !== 'boolean' || typeof prefs.maxOutputTokens !== 'number') return false;
  if (prefs.temperature !== null && typeof prefs.temperature !== 'number') return false;
  return true;
}

/** Shape-validates an inbound `stream-status` query frame on the host port. */
export function isStreamStatusFrame(value: unknown): value is HostPortEvent & { type: 'stream-status' } {
  return (
    isRecord(value) &&
    value.type === 'stream-status' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 64
  );
}

/** Shape-validates an inbound `stream-status-reply` frame on the host port. */
export function isStreamStatusReplyFrame(value: unknown): value is HostPortEvent & { type: 'stream-status-reply' } {
  return (
    isRecord(value) &&
    value.type === 'stream-status-reply' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 64 &&
    typeof value.active === 'boolean'
  );
}

/** Shape-validates an inbound `stream-chunk` / `stream-retry` / `stream-done` / `stream-error` frame. */
export function isStreamFrame(value: unknown): value is HostPortEvent & {
  type: 'stream-chunk' | 'stream-retry' | 'stream-done' | 'stream-error';
} {
  if (!isRecord(value) || typeof value.requestId !== 'string' || value.requestId.length === 0) return false;
  if (value.type === 'stream-chunk') return typeof value.delta === 'string';
  if (value.type === 'stream-retry') return true;
  if (value.type === 'stream-done') {
    if (value.usage === null) return true;
    return (
      isRecord(value.usage) &&
      typeof value.usage.promptTokens === 'number' &&
      typeof value.usage.completionTokens === 'number'
    );
  }
  if (value.type === 'stream-error') return isStreamError(value.error);
  return false;
}

/** Sender check applied to every message before dispatch (04). */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

/** Same check for port connections (popup and runtime host, 04). */
export function isTrustedPort(port: chrome.runtime.Port): boolean {
  return port.sender?.id === chrome.runtime.id;
}
