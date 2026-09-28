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

import type { Settings, SiteIndexStatus, SourceInfo } from './types';
import { isSameOrigin, normalizeUrl } from './url';

export const MSG = {
  getSettings: 'get-settings',
  saveSettings: 'save-settings',
  getSiteStatus: 'get-site-status',
  listSources: 'list-sources',
  indexSite: 'index-site',
} as const;

export type Message =
  | { type: typeof MSG.getSettings }
  | { type: typeof MSG.saveSettings; settings: unknown }
  | { type: typeof MSG.getSiteStatus; origin: string }
  | { type: typeof MSG.listSources; origin: string }
  | { type: typeof MSG.indexSite; origin: string; url: string };

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
  | { ok: false; error: 'permission' | 'unhandled' };

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
  | { type: 'index-failed'; origin: string; reason: string };

/**
 * SW <-> runtime host frames over the `siteqa-host` port. Batches are
 * correlated on `batchId` (one in flight at a time, docs/03).
 */
export type HostPortEvent =
  | {
      type: 'embed-batch';
      dbName: string;
      batchId: number;
      chunks: { chunkId: string; text: string }[];
    }
  | { type: 'embed-done'; dbName: string; batchId: number; embedded: number }
  | { type: 'embed-error'; dbName: string; batchId: number; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

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
export function isHostFrame(value: unknown): value is HostPortEvent {
  if (!isRecord(value) || typeof value.batchId !== 'number' || typeof value.dbName !== 'string') return false;
  if (value.type === 'embed-done') return typeof value.embedded === 'number';
  if (value.type === 'embed-error') return typeof value.error === 'string';
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
