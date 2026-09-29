/**
 * `ask-site` handler (docs/03 QA flow): retrieves, assembles the guarded
 * prompt, streams the answer from the runtime host, validates citations,
 * accounts spend, and persists a transcript. Answers broadcast over the
 * popup progress port; the popup may close mid-stream and the answer
 * completes anyway (docs/06).
 *
 * The terminal `done` transcript is written before spend accounting so a
 * SW death between the stream end and the budget update loses at most one
 * storage write, not the answer (ADR-0010).
 */

import { browserApi } from '../../shared/browser-api';
import type { ProgressPortEvent } from '../../shared/msg-protocol';
import type { ChatMessage } from '../../shared/types';
import { isQaSession, qaSessionKey, type QaSession } from '../../shared/qa-session';
import { getAllChunks, getMeta, listPages, openSiteDb } from '../../lib/db/site-db';
import { assembleMessages } from '../../lib/qa/prompt';
import { parseCitations } from '../../lib/qa/citations';
import { retrieveChunks, type RetrievedDoc } from '../../lib/qa/retrieve';
import { toStreamError } from '../../lib/llm/stream-client';
import { addSpend, getStoredSettings } from '../storage/settings-store';
import { createRuntimeHost, queryStreamStatus } from '../runtime-host';
import type { ProgressHub } from '../progress-hub';

const HEARTBEAT_INTERVAL_MS = 10_000;

export type AskStartResult = 'started' | 'permission-denied' | 'not-indexed' | 'no-key' | 'spend-cap' | 'busy';

/**
 * One QA request in flight at a time (docs/06). The slot is module scope
 * and is lost if the SW is torn down mid-answer; the stream itself lives
 * in the runtime host (ADR-0008) and finishes there (ADR-0010 takeover).
 */
let inflight: { origin: string; requestId: string } | null = null;

export async function askSite(
  origin: string,
  question: string,
  requestId: string,
  hub: ProgressHub,
): Promise<AskStartResult> {
  if (inflight) return 'busy';
  if (!(await browserApi.permissions.contains({ origins: [`${origin}/*`] }))) return 'permission-denied';

  const settings = await getStoredSettings();
  if (!settings.apiKey) return 'no-key';
  if (settings.budget.monthlyLimitUsd > 0 && settings.budget.spentThisMonthUsd >= settings.budget.monthlyLimitUsd) {
    return 'spend-cap';
  }

  const db = await openSiteDb(origin);
  let indexed = false;
  try {
    const meta = await getMeta(db, origin);
    indexed = meta?.status === 'ready' && meta.chunkCount > 0;
  } finally {
    db.close();
  }
  if (!indexed) return 'not-indexed';

  // A previous SW incarnation may have died mid-answer while its stream
  // still runs in the runtime host. A fresh ask would double-bill that
  // answer; report busy until the old stream reaches a terminal state
  // (ADR-0010).
  const stored = (await browserApi.storage.session.get(qaSessionKey(origin)))[qaSessionKey(origin)];
  if (
    isQaSession(stored) &&
    stored.status === 'streaming' &&
    stored.requestId !== requestId &&
    (await queryStreamStatus(stored.requestId))
  ) {
    return 'busy';
  }

  inflight = { origin, requestId };
  void runAsk(origin, question, requestId, settings.apiKey, hub)
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return 'started';
}

/** True when this SW holds the stream: the popup will receive live port events. */
export function computeHeldBySw(
  current: { origin: string; requestId: string } | null,
  origin: string,
  requestId: string,
): boolean {
  return current !== null && current.origin === origin && current.requestId === requestId;
}

/**
 * Answers `get-qa-stream` (ADR-0010): whether a terminal state for this
 * request can still arrive. Held by this SW means live events flow; when
 * not held, only the runtime host's takeover can produce one.
 */
export async function getQaStreamStatus(
  origin: string,
  requestId: string,
): Promise<{ active: boolean; heldBySw: boolean }> {
  const heldBySw = computeHeldBySw(inflight, origin, requestId);
  if (heldBySw) return { active: true, heldBySw: true };
  return { active: await queryStreamStatus(requestId).catch(() => false), heldBySw: false };
}

async function runAsk(
  origin: string,
  question: string,
  requestId: string,
  apiKey: string,
  hub: ProgressHub,
): Promise<void> {
  const settings = await getStoredSettings();
  const modelPath = browserApi.runtime.getURL('models/');
  const host = await createRuntimeHost({ modelPath });
  const heartbeat = setInterval(() => {
    void browserApi.storage.local.set({ heartbeat: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);

  const session: QaSession = {
    requestId,
    question,
    askedAt: Date.now(),
    status: 'streaming',
    answer: '',
    citations: [],
    usage: null,
    costUsd: null,
    spentThisMonthUsd: null,
    reason: null,
    message: null,
  };
  await browserApi.storage.session.set({ [qaSessionKey(origin)]: session });

  try {
    // 1. Embed the question with the same model that built the index.
    const vecs = await host.embedQuery([question]);
    const queryVec = vecs[0];
    if (!queryVec) throw new Error('embedder returned no query vector');

    // 2. Retrieve and assemble (budgets enforced inside).
    const db = await openSiteDb(origin);
    let messages: ChatMessage[];
    let docsForCitations: RetrievedDoc[];
    try {
      const [chunks, pages] = await Promise.all([getAllChunks(db), listPages(db)]);
      const pagesByHash = new Map(pages.map((page) => [page.urlHash, page]));
      const docs = retrieveChunks(chunks, pagesByHash, queryVec, {
        topK: settings.retrieval.topK,
        contextTokenBudget: settings.retrieval.contextTokenBudget,
      });
      messages = assembleMessages(question, docs);
      // Keep the docs for citation validation on the finished answer.
      docsForCitations = docs;
    } finally {
      db.close();
    }

    // 3. Stream, buffering every delta so a reopened popup can catch up.
    // The citation docs ride along so the host can validate citations on
    // its takeover transcript if this SW dies mid-answer (ADR-0010).
    const { usage } = await host.streamChat(
      {
        requestId,
        origin,
        question,
        askedAt: session.askedAt,
        citationDocs: docsForCitations.map((doc) => ({
          index: doc.index,
          url: doc.url,
          title: doc.title,
          headingPath: doc.headingPath,
        })),
        messages,
        apiKey,
        modelPrefs: settings.modelPrefs,
      },
      (delta) => {
        session.answer += delta;
        void browserApi.storage.session.set({ [qaSessionKey(origin)]: session });
        hub.broadcast(origin, {
          type: 'answer-token',
          requestId,
          origin,
          delta,
        } satisfies ProgressPortEvent);
      },
      () => {
        hub.broadcast(origin, { type: 'answer-retry', requestId, origin } satisfies ProgressPortEvent);
      },
    );

    // 4. Validate citations client-side: only real context indices survive (04).
    session.citations = parseCitations(session.answer, docsForCitations);
    session.usage = usage;

    // 5. Persist the terminal answer first (ADR-0010): from here a SW death
    // no longer loses the answer, only the spend accounting below.
    session.status = 'done';
    await browserApi.storage.session.set({ [qaSessionKey(origin)]: session });

    // 6. Account spend from reported usage; no usage, no charge (honest zero).
    if (usage) {
      const spent = await addSpend(usage.promptTokens, usage.completionTokens);
      session.costUsd = spent.costUsd;
      session.spentThisMonthUsd = spent.spentThisMonthUsd;
      await browserApi.storage.session.set({ [qaSessionKey(origin)]: session });
    }

    hub.broadcast(origin, {
      type: 'answer-done',
      requestId,
      origin,
      answer: session.answer,
      citations: session.citations,
      usage: session.usage,
      costUsd: session.costUsd,
      spentThisMonthUsd: session.spentThisMonthUsd ?? settings.budget.spentThisMonthUsd,
    } satisfies ProgressPortEvent);
  } catch (err) {
    const mapped = toStreamError(err);
    session.status = 'error';
    session.reason = mapped.reason;
    session.message = mapped.message;
    await browserApi.storage.session.set({ [qaSessionKey(origin)]: session }).catch(() => {});
    hub.broadcast(origin, {
      type: 'answer-error',
      requestId,
      origin,
      reason: mapped.reason,
      message: mapped.message,
    } satisfies ProgressPortEvent);
  } finally {
    clearInterval(heartbeat);
    await host.dispose();
  }
}
