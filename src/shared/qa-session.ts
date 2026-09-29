/**
 * The QA transcript persisted to chrome.storage.session (docs/05). One
 * writer per phase: the service worker during a normal answer, the runtime
 * host when it takes over a stream whose service worker died (ADR-0010),
 * and the popup when it marks a dead stream `interrupted`. Readers shape-
 * check with `isQaSession` before trusting stored values.
 */

import type { QaCitation, QaErrorReason, QaUsage } from './types';

export interface QaSession {
  requestId: string;
  question: string;
  askedAt: number;
  status: 'streaming' | 'done' | 'error';
  answer: string;
  citations: QaCitation[];
  usage: QaUsage | null;
  costUsd: number | null;
  spentThisMonthUsd: number | null;
  reason: QaErrorReason | null;
  message: string | null;
}

/** storage.session key of the per-origin QA transcript (docs/05). */
export const qaSessionKey = (origin: string): string => `qa:${origin}`;

/** Loose shape check for stored transcripts: enough to restore, never trusted deeply. */
export const isQaSession = (v: unknown): v is QaSession =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as QaSession).requestId === 'string' &&
  typeof (v as QaSession).status === 'string';
