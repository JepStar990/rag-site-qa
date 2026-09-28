/**
 * Message protocol between extension contexts (docs/03-component-design.md).
 *
 * Security rules (docs/04-security-threat-model.md):
 * - no `externally_connectable`; every sender must pass `isTrustedSender`
 * - every payload passes `parseMessage` before dispatch; malformed messages
 *   are dropped silently
 * - the API key never travels over the bus: `get-settings` responses null it,
 *   and key writes happen only from the options page directly to storage
 */

import type { Settings, SiteIndexStatus, SourceInfo } from './types';

export const MSG = {
  getSettings: 'get-settings',
  saveSettings: 'save-settings',
  getSiteStatus: 'get-site-status',
  listSources: 'list-sources',
} as const;

export type Message =
  | { type: typeof MSG.getSettings }
  | { type: typeof MSG.saveSettings; settings: unknown }
  | { type: typeof MSG.getSiteStatus; origin: string }
  | { type: typeof MSG.listSources; origin: string };

/** Discriminated on `kind` because both success variants share `ok: true`. */
export type MessageResponse =
  | { ok: true; kind: 'settings'; settings: Settings }
  | { ok: true; kind: 'status'; status: SiteIndexStatus | 'inactive' }
  | { ok: true; kind: 'sources'; sources: SourceInfo[] }
  | { ok: false; error: 'unhandled' };

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
    default:
      return null;
  }
}

/** Sender check applied to every message before dispatch (04). */
export function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}
