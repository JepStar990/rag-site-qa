/**
 * Stream lifecycle in the Chromium runtime host, with takeover on service
 * worker death (ADR-0010): when the port to the SW dies mid-stream, the
 * host finishes the answer and writes the terminal transcript itself, so a
 * completed answer is never lost and never billed twice by a re-ask.
 *
 * This module is chrome-free on purpose — every seam is injected, so the
 * tests run in plain node without browser stubs.
 */

import type { QaSession } from '../shared/qa-session';
import { qaSessionKey } from '../shared/qa-session';
import type { HostPortEvent, StreamError } from '../shared/msg-protocol';
import type { ChatMessage, CitationDoc, ModelPrefs, QaCitation, QaUsage } from '../shared/types';
import { toStreamError, type StreamDeps } from '../lib/llm/stream-client';

/** The subset of a start-stream frame the lifecycle needs to run a stream. */
export interface StartStreamContext {
  requestId: string;
  origin: string;
  question: string;
  askedAt: number;
  messages: ChatMessage[];
  apiKey: string;
  modelPrefs: ModelPrefs;
  citationDocs: CitationDoc[];
  /** Posts one frame to the SW port. May throw once the port is dead. */
  post(frame: HostPortEvent): void;
}

/** Injected seams; wired to real implementations in offscreen.ts. */
export interface StreamTakeoverDeps {
  streamChat(
    req: { messages: ChatMessage[]; apiKey: string; modelPrefs: ModelPrefs },
    deps: StreamDeps,
    onDelta: (delta: string) => void,
    onRetry: () => void,
  ): Promise<{ usage: QaUsage | null }>;
  streamDeps(): StreamDeps;
  parseCitations(answer: string, docs: CitationDoc[]): QaCitation[];
  addSpend(promptTokens: number, completionTokens: number): Promise<{ costUsd: number; spentThisMonthUsd: number }>;
  readBudgetSpentUsd(): Promise<number>;
  setSession(key: string, session: QaSession): Promise<void>;
}

export class StreamLifecycle {
  private connected = true;
  private answer = '';
  private activeUntilRunEnds = true;

  constructor(
    private readonly ctx: StartStreamContext,
    private readonly deps: StreamTakeoverDeps,
  ) {}

  /**
   * True while this stream may still produce a terminal state — either a
   * frame to a live SW or a takeover transcript write. Status queries
   * (stream-status) must report active until that settles, or a popup
   * could interrupt while the takeover write is mid-flight and a re-ask
   * could clobber the transcript key.
   */
  get active(): boolean {
    return this.activeUntilRunEnds;
  }

  /** Called from the port's onDisconnect: the SW is gone. */
  disconnect(): void {
    this.connected = false;
  }

  /** Runs the stream to its terminal state; never rejects. */
  async run(): Promise<void> {
    try {
      await this.runInner();
    } catch {
      // Terminal persistence failed; the popup watchdog still resolves the
      // session from its side (ADR-0010).
    } finally {
      this.activeUntilRunEnds = false;
    }
  }

  private async runInner(): Promise<void> {
    const { ctx, deps } = this;
    try {
      const { usage } = await deps.streamChat(
        { messages: ctx.messages, apiKey: ctx.apiKey, modelPrefs: ctx.modelPrefs },
        deps.streamDeps(),
        (delta) => {
          // Buffer every delta locally regardless of port state: the
          // buffered answer is what the takeover transcript preserves.
          this.answer += delta;
          this.safePost({ type: 'stream-chunk', requestId: ctx.requestId, delta } satisfies HostPortEvent);
        },
        () => {
          this.safePost({ type: 'stream-retry', requestId: ctx.requestId } satisfies HostPortEvent);
        },
      );
      if (!this.connected) {
        await this.writeDone(usage);
        return;
      }
      this.safePost({ type: 'stream-done', requestId: ctx.requestId, usage } satisfies HostPortEvent);
      if (!this.connected) {
        // The done post itself hit a dead port: the SW never got the frame.
        await this.writeDone(usage);
      }
    } catch (err) {
      const mapped = toStreamError(err);
      if (!this.connected) {
        await this.writeError(mapped);
        return;
      }
      this.safePost({ type: 'stream-error', requestId: ctx.requestId, error: mapped } satisfies HostPortEvent);
      if (!this.connected) {
        await this.writeError(mapped);
      }
    }
  }

  /**
   * Every post goes through here: posting to a dead port throws, and a
   * throw inside streamChat's delta relay aborts the stream (the client
   * rethrows once content has streamed). Dropping and self-healing the
   * connected flag keeps the fetch alive after SW death.
   */
  private safePost(frame: HostPortEvent): void {
    if (!this.connected) return;
    try {
      this.ctx.post(frame);
    } catch {
      this.connected = false;
    }
  }

  /** Takeover terminal write: the full answer survives the SW's death (ADR-0010). */
  private async writeDone(usage: QaUsage | null): Promise<void> {
    const { ctx, deps } = this;
    const citations = deps.parseCitations(this.answer, ctx.citationDocs);
    let costUsd: number | null = null;
    let spentThisMonthUsd: number | null;
    if (usage) {
      const spent = await deps.addSpend(usage.promptTokens, usage.completionTokens);
      costUsd = spent.costUsd;
      spentThisMonthUsd = spent.spentThisMonthUsd;
    } else {
      // No usage reported: spend stays honest at zero (docs/06); carry the
      // month total so the popup footer still renders.
      spentThisMonthUsd = await deps.readBudgetSpentUsd();
    }
    await deps.setSession(qaSessionKey(ctx.origin), {
      requestId: ctx.requestId,
      question: ctx.question,
      askedAt: ctx.askedAt,
      status: 'done',
      answer: this.answer,
      citations,
      usage,
      costUsd,
      spentThisMonthUsd,
      reason: null,
      message: null,
    });
  }

  /** Takeover error write: preserves the partial answer for the popup banner. */
  private async writeError(mapped: StreamError): Promise<void> {
    const { ctx, deps } = this;
    await deps.setSession(qaSessionKey(ctx.origin), {
      requestId: ctx.requestId,
      question: ctx.question,
      askedAt: ctx.askedAt,
      status: 'error',
      answer: this.answer,
      citations: [],
      usage: null,
      costUsd: null,
      spentThisMonthUsd: null,
      reason: mapped.reason,
      message: mapped.message,
    });
  }
}
