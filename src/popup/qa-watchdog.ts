/**
 * Popup-side watchdog for an in-flight QA stream (ADR-0010). Started when
 * the popup asks or restores a `streaming` session; it resolves the UI
 * even when the stream's owner died silently:
 *
 * - the terminal transcript landing in storage.session (from the SW, or
 *   from the runtime host's takeover write) is applied as done/error;
 * - a stream that provably no longer exists anywhere transitions to the
 *   interrupted error ("This answer was interrupted. Ask again.") and the
 *   input comes back.
 *
 * Silence (no answer growth) is the trigger to re-check, never absolute
 * age on its own: a healthy thinking stretch emits no content deltas for
 * minutes. The absolute askedAt cap applies only when the status query
 * itself keeps failing (SW unreachable).
 *
 * Chrome-free on purpose: every seam is injected, so the tests run in
 * plain node with fake timers.
 */

import type { QaSession } from '../shared/qa-session';

const TICK_MS = 2_000;
/** Minutes of no answer growth before re-checking whether the stream is alive. */
const SILENCE_MS = 60_000;
/** Wait between status-query attempts while the SW is unreachable. */
const QUERY_RETRY_MS = 15_000;
/** Failsafe when the status query never succeeds: no answer takes this long. */
const ABSOLUTE_CAP_MS = 10 * 60_000;

export interface QaWatchdogDeps {
  requestId: string;
  /** When the question was asked (the restored transcript's askedAt). */
  askedAt: number;
  /** Reads the `qa:<origin>` transcript; null while a fresh ask has not written it yet. */
  readSession(): Promise<QaSession | null>;
  /** Asks the SW whether a live stream can still produce a terminal state. */
  queryActive(): Promise<{ active: boolean; heldBySw: boolean }>;
  /** A terminal transcript landed for our requestId. */
  onTerminal(session: QaSession): void;
  /** No live stream exists and none can: show the interrupted error. */
  onInterrupted(session: QaSession): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
}

export function startQaWatchdog(deps: QaWatchdogDeps): { stop(): void } {
  let disposed = false;
  let lastChange = deps.now();
  let lastQueryAt = 0;
  let lastAnswer = '';

  const tick = () => {
    void (async () => {
      if (disposed) return;
      const session = await deps.readSession();
      if (disposed) return;
      // Null: a fresh ask has not written its transcript yet; keep waiting.
      if (session === null) return;
      // A different requestId owns the key now: a newer ask took over.
      if (session.requestId !== deps.requestId) {
        stop();
        return;
      }
      if (session.status === 'done' || session.status === 'error') {
        deps.onTerminal(session);
        stop();
        return;
      }
      // Streaming. Answers only grow, so a longer answer means the stream
      // is producing content.
      if (session.answer.length > lastAnswer.length) {
        lastAnswer = session.answer;
        lastChange = deps.now();
        return;
      }
      const now = deps.now();
      if (now - lastChange < SILENCE_MS) return;
      if (now - lastQueryAt < QUERY_RETRY_MS) return;
      lastQueryAt = now;
      let status: { active: boolean; heldBySw: boolean };
      try {
        status = await deps.queryActive();
      } catch {
        // SW unreachable: keep waiting unless the absolute cap has passed.
        if (now - deps.askedAt >= ABSOLUTE_CAP_MS) {
          deps.onInterrupted(session);
          stop();
        }
        return;
      }
      if (disposed) return;
      if (status.active) {
        // Alive but silent (thinking, or the takeover host still working):
        // extend the silence window and keep polling.
        lastChange = deps.now();
        return;
      }
      deps.onInterrupted(session);
      stop();
    })();
  };

  const id = deps.setInterval(tick, TICK_MS);
  const stop = () => {
    disposed = true;
    deps.clearInterval(id);
  };
  return { stop };
}
