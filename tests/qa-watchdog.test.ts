/**
 * Popup QA watchdog (ADR-0010): resolves a stuck `asking` phase by polling
 * the transcript, re-checking stream liveness on silence, and marking dead
 * streams interrupted. Chrome-free seams with fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startQaWatchdog } from '../src/popup/qa-watchdog.js';
import type { QaSession } from '../src/shared/qa-session.js';

const session = (over: Partial<QaSession> = {}): QaSession => ({
  requestId: 'q1',
  question: 'q?',
  askedAt: 0,
  status: 'streaming',
  answer: '',
  citations: [],
  usage: null,
  costUsd: null,
  spentThisMonthUsd: null,
  reason: null,
  message: null,
  ...over,
});

interface Harness {
  setSession(next: QaSession | null): void;
  setQuery(next: { active: boolean } | 'throw'): void;
  onTerminal: ReturnType<typeof vi.fn>;
  onInterrupted: ReturnType<typeof vi.fn>;
  watchdog: { stop(): void };
}

function makeHarness(): Harness {
  let current: QaSession | null = session();
  let query: { active: boolean } | 'throw' = { active: true };
  const onTerminal = vi.fn();
  const onInterrupted = vi.fn();
  const watchdog = startQaWatchdog({
    requestId: 'q1',
    askedAt: 0,
    readSession: async () => current,
    queryActive: async () => {
      if (query === 'throw') throw new Error('SW unreachable');
      return { active: query.active, heldBySw: false };
    },
    onTerminal,
    onInterrupted,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    now: () => Date.now(),
  });
  return {
    setSession: (next) => {
      current = next;
    },
    setQuery: (next) => {
      query = next;
    },
    onTerminal,
    onInterrupted,
    watchdog,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startQaWatchdog', () => {
  it('applies a terminal transcript that lands in storage.session', async () => {
    const h = makeHarness();
    h.setSession(session({ status: 'done', answer: 'the answer' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.onTerminal).toHaveBeenCalledTimes(1);
    expect(h.onTerminal.mock.calls[0]?.[0]).toMatchObject({ status: 'done', answer: 'the answer' });
    // The watchdog stopped: later ticks do nothing.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.onTerminal).toHaveBeenCalledTimes(1);
    expect(h.onInterrupted).not.toHaveBeenCalled();
  });

  it('stops without callbacks when a different requestId owns the transcript', async () => {
    const h = makeHarness();
    h.setSession(session({ requestId: 'q2' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.onTerminal).not.toHaveBeenCalled();
    expect(h.onInterrupted).not.toHaveBeenCalled();
  });

  it('tolerates a missing transcript while a fresh ask has not written it yet', async () => {
    const h = makeHarness();
    h.setSession(null);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.onInterrupted).not.toHaveBeenCalled();
    h.setSession(session({ status: 'done' }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.onTerminal).toHaveBeenCalledTimes(1);
  });

  it('extends the silence window while a live-but-silent stream reports active, then interrupts once it is gone', async () => {
    const h = makeHarness();
    // 60s of silence triggers the first liveness check: still active.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onInterrupted).not.toHaveBeenCalled();
    // The stream dies; the next silence window ends in an interrupt.
    h.setQuery({ active: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onInterrupted).toHaveBeenCalledTimes(1);
    expect(h.onInterrupted.mock.calls[0]?.[0]).toMatchObject({ answer: '' });
  });

  it('passes the streaming session through on interrupt', async () => {
    const h = makeHarness();
    h.setSession(session({ answer: 'half an answer', askedAt: 1720000000000 }));
    h.setQuery({ active: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onInterrupted.mock.calls[0]?.[0]).toMatchObject({
      answer: 'half an answer',
      askedAt: 1720000000000,
    });
  });

  it('keeps polling while the status query fails, interrupting only past the absolute cap', async () => {
    const h = makeHarness();
    h.setQuery('throw');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.onInterrupted).not.toHaveBeenCalled();
    // 10-minute failsafe (ABSOLUTE_CAP_MS) from askedAt=0.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.onInterrupted).toHaveBeenCalledTimes(1);
  });

  it('stop() halts all further ticks', async () => {
    const h = makeHarness();
    h.watchdog.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.onTerminal).not.toHaveBeenCalled();
    expect(h.onInterrupted).not.toHaveBeenCalled();
  });
});
