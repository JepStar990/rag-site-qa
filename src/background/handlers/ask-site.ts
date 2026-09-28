/**
 * `ask-site` handler (docs/03 QA flow): retrieves, assembles the guarded
 * prompt, streams the answer from the runtime host, validates citations,
 * accounts spend, and persists a transcript. Answers broadcast over the
 * popup progress port; the popup may close mid-stream and the answer
 * completes anyway (docs/06).
 */

import { browserApi } from '../../shared/browser-api';
import type { ProgressPortEvent, StreamError } from '../../shared/msg-protocol';
import type { ChatMessage, QaCitation, QaUsage } from '../../shared/types';
import { getAllChunks, getMeta, listPages, openSiteDb } from '../../lib/db/site-db';
import { assembleMessages } from '../../lib/qa/prompt';
import { parseCitations } from '../../lib/qa/citations';
import { retrieveChunks, type RetrievedDoc } from '../../lib/qa/retrieve';
import { toStreamError } from '../../lib/llm/stream-client';
import { addSpend, getStoredSettings } from '../storage/settings-store';
import { createRuntimeHost } from '../runtime-host';
import type { ProgressHub } from '../progress-hub';

const HEARTBEAT_INTERVAL_MS = 10_000;

export type AskStartResult = 'started' | 'permission-denied' | 'not-indexed' | 'no-key' | 'spend-cap' | 'busy';

/** The transcript persisted to chrome.storage.session (docs/05): deltas are
 * buffered while streaming, and the finished answer survives popup close. */
interface QaSession {
  requestId: string;
  question: string;
  askedAt: number;
  status: 'streaming' | 'done' | 'error';
  answer: string;
  citations: QaCitation[];
  usage: QaUsage | null;
  costUsd: number | null;
  spentThisMonthUsd: number | null;
  reason: StreamError['reason'] | null;
  message: string | null;
}

const sessionKey = (origin: string): string => `qa:${origin}`;

/**
 * One QA request in flight at a time (docs/06). The slot is module scope
 * and is lost if the SW is torn down mid-answer; that is acceptable — the
 * stream itself lives in the runtime host (ADR-0008) and finishes there.
 */
let inflight: { origin: string } | null = null;

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

  inflight = { origin };
  void runAsk(origin, question, requestId, settings.apiKey, hub)
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return 'started';
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
  await browserApi.storage.session.set({ [sessionKey(origin)]: session });

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
    const { usage } = await host.streamChat(
      { requestId, messages, apiKey, modelPrefs: settings.modelPrefs },
      (delta) => {
        session.answer += delta;
        void browserApi.storage.session.set({ [sessionKey(origin)]: session });
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

    // 5. Account spend from reported usage; no usage, no charge (honest zero).
    if (usage) {
      const spent = await addSpend(usage.promptTokens, usage.completionTokens);
      session.costUsd = spent.costUsd;
      session.spentThisMonthUsd = spent.spentThisMonthUsd;
    }

    session.status = 'done';
    await browserApi.storage.session.set({ [sessionKey(origin)]: session });
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
    await browserApi.storage.session.set({ [sessionKey(origin)]: session }).catch(() => {});
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
