/**
 * StreamLifecycle (ADR-0010): the offscreen host relays a stream to the SW
 * port while it is connected, and takes over the terminal transcript write
 * when the port dies mid-stream. Chrome-free seams: no browser stubs.
 */

import { describe, expect, it, vi } from 'vitest';
import { StreamLifecycle, type StartStreamContext, type StreamTakeoverDeps } from '../src/offscreen/stream-takeover.js';
import { qaSessionKey, type QaSession } from '../src/shared/qa-session.js';
import type { HostPortEvent } from '../src/shared/msg-protocol.js';
import type { QaCitation, QaUsage } from '../src/shared/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const USAGE: QaUsage = { promptTokens: 10, completionTokens: 5 };
const CITATIONS: QaCitation[] = [{ index: 1, url: 'https://example.com/a', title: 'Title', headingPath: 'Head' }];

interface Harness {
  posts: HostPortEvent[];
  addSpend: ReturnType<typeof vi.fn>;
  readBudget: ReturnType<typeof vi.fn>;
  setSession: ReturnType<typeof vi.fn>;
  streamChat: ReturnType<typeof vi.fn>;
  lifecycle: StreamLifecycle;
  resolveStream: (usage: QaUsage | null) => void;
  rejectStream: (err: unknown) => void;
  runPromise: Promise<void>;
}

/** Wires a lifecycle whose stream emits "Hello " before resolving, "world" after. */
function makeHarness(opts?: { throwOnPost?: boolean; setSessionOverride?: StreamTakeoverDeps['setSession'] }): Harness {
  const posts: HostPortEvent[] = [];
  const streamCtl = deferred<QaUsage | null>();
  const addSpend = vi.fn(async () => ({ costUsd: 0.5, spentThisMonthUsd: 1.25 }));
  const readBudget = vi.fn(async () => 0.75);
  const setSession: ReturnType<typeof vi.fn> = opts?.setSessionOverride
    ? vi.fn(opts.setSessionOverride)
    : vi.fn(async (_key: string, _session: QaSession) => {
        // no-op persistence: assertions read the call args
      });
  const streamChat = vi.fn(async (_req: unknown, _deps: unknown, onDelta: (d: string) => void) => {
    onDelta('Hello ');
    const usage = await streamCtl.promise;
    onDelta('world');
    return { usage };
  });
  const post = vi.fn((frame: HostPortEvent) => {
    if (opts?.throwOnPost) throw new Error('Attempting to use a disconnected port object');
    posts.push(frame);
  });
  const ctx: StartStreamContext = {
    requestId: 'q1',
    origin: 'https://example.com',
    question: 'What is this?',
    askedAt: 1720000000000,
    messages: [
      { role: 'system', content: 'locked' },
      { role: 'user', content: 'question' },
    ],
    apiKey: 'sk-test',
    modelPrefs: { modelId: 'deepseek-v4-flash', thinking: false, temperature: null, maxOutputTokens: 100 },
    citationDocs: [{ index: 1, url: 'https://example.com/a', title: 'Title', headingPath: 'Head' }],
    post,
  };
  const lifecycle = new StreamLifecycle(ctx, {
    streamChat,
    streamDeps: () => ({
      fetch: async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }),
      sleep: async () => {},
    }),
    parseCitations: vi.fn(() => CITATIONS),
    addSpend,
    readBudgetSpentUsd: readBudget,
    setSession,
  });
  const runPromise = lifecycle.run();
  return { posts, addSpend, readBudget, setSession, streamChat, lifecycle, resolveStream: streamCtl.resolve, rejectStream: streamCtl.reject, runPromise };
}

describe('StreamLifecycle', () => {
  it('relays deltas and posts stream-done while connected, without touching the transcript', async () => {
    const h = makeHarness();
    expect(h.posts[0]).toEqual({ type: 'stream-chunk', requestId: 'q1', delta: 'Hello ' });
    h.resolveStream(USAGE);
    await h.runPromise;
    expect(h.posts[1]).toEqual({ type: 'stream-chunk', requestId: 'q1', delta: 'world' });
    expect(h.posts[2]).toEqual({ type: 'stream-done', requestId: 'q1', usage: USAGE });
    expect(h.setSession).not.toHaveBeenCalled();
    expect(h.addSpend).not.toHaveBeenCalled();
    expect(h.lifecycle.active).toBe(false);
  });

  it('survives a throwing post before onDisconnect and writes the takeover transcript', async () => {
    // The dead-port window: postMessage throws before the disconnect event
    // arrives. The throw must not abort the stream (docs/06 relay path).
    const h = makeHarness({ throwOnPost: true });
    h.resolveStream(USAGE);
    await h.runPromise;
    expect(h.posts).toEqual([]);
    expect(h.setSession).toHaveBeenCalledTimes(1);
    const [key, session] = h.setSession.mock.calls[0] as [string, QaSession];
    expect(key).toBe(qaSessionKey('https://example.com'));
    expect(session.status).toBe('done');
    expect(session.answer).toBe('Hello world');
    expect(h.addSpend).toHaveBeenCalledWith(10, 5);
  });

  it('writes the done transcript on disconnect mid-stream, preserving citations, spend, and session context', async () => {
    const h = makeHarness();
    h.lifecycle.disconnect();
    expect(h.lifecycle.active).toBe(true); // still streaming after the port died
    h.resolveStream(USAGE);
    await h.runPromise;
    const [key, session] = h.setSession.mock.calls[0] as [string, QaSession];
    expect(key).toBe(qaSessionKey('https://example.com'));
    expect(session).toMatchObject({
      requestId: 'q1',
      question: 'What is this?',
      askedAt: 1720000000000,
      status: 'done',
      answer: 'Hello world',
      citations: CITATIONS,
      usage: USAGE,
      costUsd: 0.5,
      spentThisMonthUsd: 1.25,
    });
    expect(h.lifecycle.active).toBe(false);
  });

  it('writes the error transcript on disconnect mid-stream, keeping the partial answer', async () => {
    const h = makeHarness();
    h.lifecycle.disconnect();
    h.rejectStream({ reason: 'provider', message: 'DeepSeek is having trouble. Try again in a moment.' });
    await h.runPromise;
    const [, session] = h.setSession.mock.calls[0] as [string, QaSession];
    expect(session.status).toBe('error');
    expect(session.reason).toBe('provider');
    expect(session.message).toContain('DeepSeek');
    expect(session.answer).toBe('Hello ');
    expect(session.citations).toEqual([]);
  });

  it('accounts no spend without usage and carries the month total instead', async () => {
    const h = makeHarness();
    h.lifecycle.disconnect();
    h.resolveStream(null);
    await h.runPromise;
    expect(h.addSpend).not.toHaveBeenCalled();
    expect(h.readBudget).toHaveBeenCalledTimes(1);
    const [, session] = h.setSession.mock.calls[0] as [string, QaSession];
    expect(session.status).toBe('done');
    expect(session.costUsd).toBeNull();
    expect(session.spentThisMonthUsd).toBe(0.75);
  });

  it('stays active while the takeover write is pending, inactive once it settles', async () => {
    const writeCtl = deferred<void>();
    const h = makeHarness({
      setSessionOverride: vi.fn(async () => {
        await writeCtl.promise;
      }),
    });
    h.lifecycle.disconnect();
    h.resolveStream(USAGE);
    await flush();
    expect(h.setSession).toHaveBeenCalledTimes(1);
    expect(h.lifecycle.active).toBe(true);
    writeCtl.resolve();
    await h.runPromise;
    expect(h.lifecycle.active).toBe(false);
  });

  it('does not post retries after the port is gone', async () => {
    const streamCtl = deferred<QaUsage | null>();
    const posts: HostPortEvent[] = [];
    const setSession = vi.fn(async () => {});
    const streamChat = vi.fn(async (_req: unknown, _deps: unknown, _onDelta: (d: string) => void, onRetry: () => void) => {
      onRetry();
      await streamCtl.promise;
      return { usage: null };
    });
    const lifecycle = new StreamLifecycle(
      {
        requestId: 'q2',
        origin: 'https://example.com',
        question: 'q',
        askedAt: 1,
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
        ],
        apiKey: 'sk-test',
        modelPrefs: { modelId: 'm', thinking: false, temperature: null, maxOutputTokens: 100 },
        citationDocs: [],
        post: (frame) => posts.push(frame),
      },
      {
        streamChat,
        streamDeps: () => ({ fetch: async () => ({ ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }) }) } }), sleep: async () => {} }),
        parseCitations: () => [],
        addSpend: async () => ({ costUsd: 0, spentThisMonthUsd: 0 }),
        readBudgetSpentUsd: async () => 0,
        setSession,
      },
    );
    lifecycle.disconnect();
    const runPromise = lifecycle.run();
    streamCtl.resolve(null);
    await runPromise;
    expect(posts).toEqual([]);
    expect(setSession).toHaveBeenCalledTimes(1);
  });
});
