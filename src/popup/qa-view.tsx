/**
 * QA chat UI (docs/03 popup section, docs/06 BYOK UX): question input,
 * streaming sanitized answer with citation chips, spend readout, and the
 * docs/06 error-matrix banners. State lives in module signals so the port
 * event handlers in app.tsx and this component share it without props.
 *
 * Every `asking` phase is backed by a watchdog (ADR-0010): if the stream's
 * owner died and no live stream can still produce a terminal state, the
 * popup shows "This answer was interrupted. Ask again." and re-enables the
 * input instead of dead-ending at "Answering...".
 */

import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { browserApi } from '../shared/browser-api';
import { MSG } from '../shared/msg-protocol';
import type { ProgressPortEvent, AskRejectReason } from '../shared/msg-protocol';
import type { QaCitation, QaErrorReason, QaUsage, Settings } from '../shared/types';
import { isQaSession, qaSessionKey, type QaSession } from '../shared/qa-session';
import { startQaWatchdog } from './qa-watchdog';
import { renderAnswerInto } from './qa-render';

type QaState =
  | { phase: 'idle' }
  | { phase: 'asking'; requestId: string; question: string; answer: string; retrying: boolean }
  | {
      phase: 'done';
      requestId: string;
      question: string;
      answer: string;
      citations: QaCitation[];
      usage: QaUsage | null;
      costUsd: number | null;
      spentThisMonthUsd: number;
    }
  | {
      phase: 'error';
      requestId: string;
      question: string;
      answer: string;
      reason: QaErrorReason;
      message: string;
    };

export const qaState = signal<QaState>({ phase: 'idle' });
export const askError = signal<AskRejectReason | null>(null);

/** The origin QA runs against, kept in sync with the active tab by app.tsx. */
const currentOrigin = signal<string | null>(null);
const settings = signal<Settings | null>(null);
const draft = signal('');

const INTERRUPTED_MESSAGE = 'This answer was interrupted. Ask again.';

/** The watchdog watching the current `asking` phase, if any (ADR-0010). */
let watchdog: { stop(): void } | null = null;

function stopQaWatchdog(): void {
  watchdog?.stop();
  watchdog = null;
}

export function setQaOrigin(origin: string | null): void {
  currentOrigin.value = origin;
}

/** Wipes QA state when the popup moves to a different site or status. */
export function resetQa(): void {
  stopQaWatchdog();
  qaState.value = { phase: 'idle' };
  askError.value = null;
  draft.value = '';
}

/** Generates the requestId the ask message carries (validated by the bus). */
function newRequestId(): string {
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Starts the watchdog for one `asking` phase. Shared by fresh asks and
 * restored streaming sessions; deps are wired to storage.session and the
 * `get-qa-stream` bus message here, the timing logic lives in qa-watchdog.ts.
 */
function startWatchdog(origin: string, requestId: string, askedAt: number): void {
  stopQaWatchdog();
  watchdog = startQaWatchdog({
    requestId,
    askedAt,
    readSession: async () => {
      const stored = (await browserApi.storage.session.get(qaSessionKey(origin)))[qaSessionKey(origin)];
      return isQaSession(stored) ? stored : null;
    },
    queryActive: async () => {
      const res: unknown = await browserApi.runtime.sendMessage({
        type: MSG.getQaStream,
        origin,
        requestId,
      });
      if (
        typeof res === 'object' &&
        res !== null &&
        'ok' in res &&
        (res as { ok: boolean }).ok &&
        (res as { kind?: unknown }).kind === 'qa-stream'
      ) {
        const typed = res as { active: boolean; heldBySw: boolean };
        return { active: typed.active, heldBySw: typed.heldBySw };
      }
      throw new Error('qa-stream query failed');
    },
    onTerminal: (session) => {
      if (session.status === 'done') {
        applyDone({
          requestId: session.requestId,
          question: session.question,
          answer: session.answer,
          citations: session.citations,
          usage: session.usage,
          costUsd: session.costUsd,
          spentThisMonthUsd: session.spentThisMonthUsd ?? 0,
        });
      } else {
        applyError({
          requestId: session.requestId,
          question: session.question,
          answer: session.answer,
          reason: session.reason ?? 'network',
          message: session.message ?? 'Something went wrong. Try again.',
        });
      }
    },
    onInterrupted: (partialAnswer) => handleInterrupted(origin, requestId, partialAnswer),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    now: () => Date.now(),
  });
}

async function ask(question: string): Promise<void> {
  const origin = currentOrigin.value;
  if (!origin) return;
  const requestId = newRequestId();
  const res: unknown = await browserApi.runtime.sendMessage({
    type: MSG.ask,
    origin,
    question,
    requestId,
  });
  if (typeof res === 'object' && res !== null && 'ok' in res) {
    const typed = res as { ok: boolean; error?: string };
    if (typed.ok) {
      askError.value = null;
      qaState.value = { phase: 'asking', requestId, question, answer: '', retrying: false };
      startWatchdog(origin, requestId, Date.now());
      return;
    }
    if (typed.error && typed.error !== 'unhandled') {
      askError.value = typed.error as AskRejectReason;
      // BYOK onboarding (docs/06): the first ask without a key opens options.
      if (typed.error === 'no-key') void browserApi.runtime.openOptionsPage();
      return;
    }
  }
  askError.value = null;
}

/** Restores the last transcript when the popup (re)opens on a ready site. */
export async function restoreQaSession(origin: string): Promise<void> {
  const stored = (await browserApi.storage.session.get(qaSessionKey(origin)))[qaSessionKey(origin)];
  if (!isQaSession(stored)) return;

  if (stored.status === 'streaming') {
    // A stream is in flight; live events will append from here, and the
    // watchdog resolves the session if the stream is actually dead.
    qaState.value = {
      phase: 'asking',
      requestId: stored.requestId,
      question: stored.question,
      answer: stored.answer,
      retrying: false,
    };
    startWatchdog(origin, stored.requestId, stored.askedAt);
  } else if (stored.status === 'done') {
    qaState.value = {
      phase: 'done',
      requestId: stored.requestId,
      question: stored.question,
      answer: stored.answer,
      citations: stored.citations,
      usage: stored.usage,
      costUsd: stored.costUsd,
      spentThisMonthUsd: stored.spentThisMonthUsd ?? 0,
    };
  } else if (stored.reason && stored.message) {
    qaState.value = {
      phase: 'error',
      requestId: stored.requestId,
      question: stored.question,
      answer: stored.answer,
      reason: stored.reason,
      message: stored.message,
    };
  }
}

/** Applies a terminal done state; shared by port events and the watchdog. */
function applyDone(args: {
  requestId: string;
  question: string;
  answer: string;
  citations: QaCitation[];
  usage: QaUsage | null;
  costUsd: number | null;
  spentThisMonthUsd: number;
}): void {
  const current = qaState.value;
  if (current.phase !== 'asking' || current.requestId !== args.requestId) return;
  stopQaWatchdog();
  qaState.value = {
    phase: 'done',
    requestId: args.requestId,
    question: args.question,
    answer: args.answer,
    citations: args.citations,
    usage: args.usage,
    costUsd: args.costUsd,
    spentThisMonthUsd: args.spentThisMonthUsd,
  };
}

/** Applies a terminal error state; shared by port events and the watchdog. */
function applyError(args: {
  requestId: string;
  question: string;
  answer: string;
  reason: QaErrorReason;
  message: string;
}): void {
  const current = qaState.value;
  if (current.phase !== 'asking' || current.requestId !== args.requestId) return;
  stopQaWatchdog();
  qaState.value = {
    phase: 'error',
    requestId: args.requestId,
    question: args.question,
    answer: args.answer,
    reason: args.reason,
    message: args.message,
  };
}

/**
 * Marks a dead stream interrupted (ADR-0010). The transcript write is
 * requestId-guarded: a stale watchdog must never clobber a newer ask's
 * streaming transcript.
 */
function handleInterrupted(origin: string, requestId: string, partialAnswer: string): void {
  const current = qaState.value;
  if (current.phase !== 'asking' || current.requestId !== requestId) return;
  stopQaWatchdog();
  const key = qaSessionKey(origin);
  void (async () => {
    const stored = (await browserApi.storage.session.get(key))[key];
    if (stored === undefined || (isQaSession(stored) && stored.requestId === requestId)) {
      await browserApi.storage.session.set({
        [key]: {
          requestId,
          question: current.question,
          askedAt: Date.now(),
          status: 'error',
          answer: partialAnswer,
          citations: [],
          usage: null,
          costUsd: null,
          spentThisMonthUsd: null,
          reason: 'interrupted',
          message: INTERRUPTED_MESSAGE,
        } satisfies QaSession,
      });
    }
    // Re-check after the awaits: a newer ask may have started meanwhile.
    const latest = qaState.value;
    if (latest.phase !== 'asking' || latest.requestId !== requestId) return;
    qaState.value = {
      phase: 'error',
      requestId,
      question: latest.question,
      answer: partialAnswer,
      reason: 'interrupted',
      message: INTERRUPTED_MESSAGE,
    };
  })();
}

/** Routes answer-* port events; called from app.tsx's progress listener. */
export function onQaPortEvent(event: ProgressPortEvent): void {
  const current = qaState.value;
  if (event.type === 'answer-token') {
    if (current.phase !== 'asking' || current.requestId !== event.requestId) return;
    qaState.value = { ...current, answer: current.answer + event.delta };
  } else if (event.type === 'answer-retry') {
    if (current.phase !== 'asking' || current.requestId !== event.requestId) return;
    qaState.value = { ...current, retrying: true };
  } else if (event.type === 'answer-done') {
    applyDone({
      requestId: event.requestId,
      question: current.phase === 'asking' ? current.question : '',
      answer: event.answer,
      citations: event.citations,
      usage: event.usage,
      costUsd: event.costUsd,
      spentThisMonthUsd: event.spentThisMonthUsd,
    });
  } else if (event.type === 'answer-error') {
    applyError({
      requestId: event.requestId,
      question: current.phase === 'asking' ? current.question : '',
      answer: current.phase === 'asking' ? current.answer : '',
      reason: event.reason,
      message: event.message,
    });
  }
}

const REJECT_MESSAGES: Record<Exclude<AskRejectReason, 'unhandled'>, string> = {
  permission: 'Access to this site was revoked. Grant access again.',
  'not-indexed': 'Index this site before asking questions.',
  'no-key': 'Add your DeepSeek API key in settings to ask questions.',
  'spend-cap': 'Monthly spend cap reached. New answers are blocked until next month.',
  busy: 'Another question is already being answered.',
};

function ErrorBanner() {
  const reject = askError.value;
  const state = qaState.value;
  const message = reject ? REJECT_MESSAGES[reject] : null;
  const showSettingsLink =
    reject === 'no-key' || (state.phase === 'error' && state.reason === 'invalid_key');
  return (
    <div class="banner banner-error">
      <span>{message ?? (state.phase === 'error' ? state.message : '')}</span>
      {showSettingsLink && (
        <button class="link-button" onClick={() => void browserApi.runtime.openOptionsPage()}>
          Open settings
        </button>
      )}
    </div>
  );
}

function SpendFooter() {
  const state = qaState.value;
  const budget = settings.value?.budget;
  if (state.phase !== 'done' || !budget) return null;
  const parts: string[] = [];
  if (state.usage) {
    parts.push(`${state.usage.promptTokens + state.usage.completionTokens} tokens`);
  }
  if (state.costUsd !== null) parts.push(`$${state.costUsd.toFixed(4)} this answer`);
  parts.push(`month $${state.spentThisMonthUsd.toFixed(2)} / $${budget.monthlyLimitUsd.toFixed(2)}`);
  return <p class="muted qa-spend">{parts.join(' · ')}</p>;
}

function AnswerView() {
  const state = qaState.value;
  const ref = useRef<HTMLDivElement>(null);

  const answer = state.phase === 'idle' ? '' : state.answer;
  const citations = state.phase === 'done' ? state.citations : [];
  useEffect(() => {
    if (ref.current) renderAnswerInto(ref.current, answer, citations);
  }, [answer, citations]);

  if (state.phase === 'idle') return null;
  const streaming = state.phase === 'asking';
  return (
    <div class="qa-answer">
      <p class="qa-question">{state.question}</p>
      {state.answer.length > 0 && <div class="qa-markdown" ref={ref} />}
      {streaming && state.answer.length === 0 && !state.retrying && <p class="muted">Thinking...</p>}
      {streaming && state.retrying && <p class="muted">Retrying automatically...</p>}
      {streaming && state.answer.length > 0 && <p class="muted qa-cursor">Answering...</p>}
      <SpendFooter />
    </div>
  );
}

export function QaView() {
  const state = qaState.value;
  const busy = state.phase === 'asking';

  useEffect(() => {
    void (async () => {
      const res: unknown = await browserApi.runtime.sendMessage({ type: MSG.getSettings });
      if (typeof res === 'object' && res !== null && 'ok' in res && (res as { ok: boolean }).ok) {
        const typed = res as { kind?: unknown; settings?: unknown };
        if (typed.kind === 'settings' && typeof typed.settings === 'object' && typed.settings !== null) {
          settings.value = typed.settings as Settings;
        }
      }
    })();
    return () => stopQaWatchdog();
  }, []);

  async function submit(): Promise<void> {
    const question = draft.value.trim();
    if (question.length === 0) return;
    draft.value = '';
    await ask(question);
  }

  return (
    <div class="qa">
      {!busy && (
        <div class="qa-input">
          <textarea
            placeholder="Ask a question about this site..."
            value={draft.value}
            onInput={(e) => {
              draft.value = e.currentTarget.value;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button class="primary" disabled={draft.value.trim().length === 0} onClick={() => void submit()}>
            Ask
          </button>
        </div>
      )}
      {(askError.value !== null || state.phase === 'error') && <ErrorBanner />}
      <AnswerView />
    </div>
  );
}
