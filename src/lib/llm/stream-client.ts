/**
 * DeepSeek streaming client (docs/06) — runs in the runtime host.
 *
 * SSE deltas are relayed to the caller as they arrive; retries follow the
 * docs/06 policy: exponential backoff with jitter (1s, 2s, 4s), maximum 3
 * attempts, only while nothing has streamed — a partially streamed answer is
 * never re-sent (duplicate billing). Thinking-mode `reasoning_content`
 * deltas are ignored: SiteQA renders the answer, not the chain of thought.
 */

import type { StreamError } from '../../shared/msg-protocol';
import type { ChatMessage, ModelPrefs, QaErrorReason, QaUsage } from '../../shared/types';

export interface StreamChatRequest {
  messages: ChatMessage[];
  apiKey: string;
  modelPrefs: ModelPrefs;
}

/** The subset of the fetch Response the reader needs; real fetch satisfies it. */
export interface StreamResponse {
  ok: boolean;
  status: number;
  body: { getReader(): StreamReader };
}

export interface StreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/** Injectable seams so the client is testable without a network. */
export interface StreamDeps {
  fetch(url: string, init: RequestInit): Promise<StreamResponse>;
  sleep(ms: number): Promise<void>;
}

export type StreamClientError = { reason: 'invalid_key' | 'no_balance' | 'rate_limited' | 'provider' | 'network' | 'bad_request' | 'too_large'; message: string };

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000, 4_000];
/** Abort a request that never produces a first byte (docs/06: network timeout). */
const CONNECT_TIMEOUT_MS = 30_000;

const STREAM_ERROR_REASONS: readonly QaErrorReason[] = [
  'invalid_key',
  'no_balance',
  'rate_limited',
  'provider',
  'network',
  'bad_request',
  'too_large',
];

/** Maps any thrown value to a wire-safe stream error (docs/06 matrix). */
export function toStreamError(err: unknown): StreamError {
  if (err && typeof err === 'object' && 'reason' in err && 'message' in err) {
    const { reason, message } = err as { reason: unknown; message: unknown };
    if (typeof reason === 'string' && STREAM_ERROR_REASONS.includes(reason as QaErrorReason) && typeof message === 'string') {
      return { reason: reason as QaErrorReason, message };
    }
  }
  return { reason: 'network', message: 'Something went wrong. Try again.' };
}

/**
 * Adapts the platform fetch to the client's minimal StreamResponse seam. A
 * stream response without a body is treated as an empty stream — the client
 * converts that into a retryable network failure.
 */
export function adaptFetch(fetchFn: typeof fetch): (url: string, init: RequestInit) => Promise<StreamResponse> {
  return async (url, init) => {
    const res = await fetchFn(url, init);
    return {
      ok: res.ok,
      status: res.status,
      body: res.body ?? {
        getReader: () => ({ read: () => Promise.resolve({ done: true }) }),
      },
    };
  };
}

/** Maps an HTTP status to the docs/06 error matrix entry. */
function errorForStatus(status: number): StreamClientError {
  if (status === 401) return { reason: 'invalid_key', message: 'API key rejected. Verify it in settings.' };
  if (status === 402) return { reason: 'no_balance', message: 'DeepSeek account has no balance. Top up or wait.' };
  if (status === 422) return { reason: 'too_large', message: 'Request too large. Try a shorter question or smaller context budget.' };
  if (status === 429) return { reason: 'rate_limited', message: 'Rate limited by DeepSeek. Try again in a moment.' };
  if (status >= 500 && status <= 599) return { reason: 'provider', message: 'DeepSeek is having trouble. Try again in a moment.' };
  return { reason: 'bad_request', message: 'Request rejected by DeepSeek. Check the model ID in settings.' };
}

const isRetryable = (err: StreamClientError): boolean =>
  err.reason === 'rate_limited' || err.reason === 'provider' || err.reason === 'network';

const networkError = (): StreamClientError => ({
  reason: 'network',
  message: 'Could not reach DeepSeek. Check your connection.',
});

function buildBody(req: StreamChatRequest): string {
  const { modelPrefs } = req;
  const body: Record<string, unknown> = {
    model: modelPrefs.modelId,
    messages: req.messages,
    stream: true,
    max_tokens: modelPrefs.maxOutputTokens,
    // Explicit on every request so behavior never depends on provider defaults (06).
    extra_body: { thinking: { type: modelPrefs.thinking ? 'enabled' : 'disabled' } },
  };
  if (!modelPrefs.thinking && modelPrefs.temperature !== null) body.temperature = modelPrefs.temperature;
  return JSON.stringify(body);
}

/** Parses one complete SSE event block into a delta, usage, or done marker. */
function parseSseEvent(
  block: string,
): { kind: 'delta'; delta: string } | { kind: 'usage'; usage: QaUsage } | { kind: 'done' } | { kind: 'other' } {
  const lines = block.split(/\r?\n/);
  const payloads: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) payloads.push(line.slice(5).replace(/^ /, ''));
  }
  if (payloads.length === 0) return { kind: 'other' };
  const data = payloads.join('\n');
  if (data === '[DONE]') return { kind: 'done' };

  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    return { kind: 'other' }; // malformed line: ignore, the stream continues
  }
  if (typeof chunk !== 'object' || chunk === null) return { kind: 'other' };

  const usage = (chunk as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  if (
    usage &&
    typeof usage.prompt_tokens === 'number' &&
    typeof usage.completion_tokens === 'number'
  ) {
    return { kind: 'usage', usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } };
  }

  const choice = (chunk as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0];
  const delta = choice?.delta?.content;
  return typeof delta === 'string' && delta.length > 0 ? { kind: 'delta', delta } : { kind: 'other' };
}

/** True once the reader has produced bytes: the request is billed, never re-send. */
async function readStream(
  res: StreamResponse,
  onDelta: (delta: string) => void,
  firstByte: () => void,
): Promise<{ usage: QaUsage | null; sawContent: boolean }> {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: QaUsage | null = null;
  let sawContent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      sawContent = true;
      firstByte();
    }
    buffer += decoder.decode(value, { stream: true });
    // Split on the SSE blank-line boundary, keep the trailing partial event.
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const parsed = parseSseEvent(event);
      if (parsed.kind === 'delta') onDelta(parsed.delta);
      if (parsed.kind === 'usage') usage = parsed.usage;
    }
  }
  // Some providers close without a trailing blank line; parse the remainder.
  if (buffer.trim().length > 0) {
    const parsed = parseSseEvent(buffer.trim());
    if (parsed.kind === 'delta') onDelta(parsed.delta);
    if (parsed.kind === 'usage') usage = parsed.usage;
  }

  // The provider ends streams with [DONE], not by closing; a close without
  // any content means the stream never really started (caller may retry).
  return { usage, sawContent };
}

/**
 * Runs one QA request. Calls `onRetry` before each retry sleep and `onDelta`
 * for every content delta. Resolves with the reported usage (null when the
 * provider omitted it — spending stays honest at zero rather than estimated).
 * Throws a mapped {@link StreamClientError} once retries are exhausted or a
 * stream fails after content started flowing.
 */
export async function streamChat(
  req: StreamChatRequest,
  deps: StreamDeps,
  onDelta: (delta: string) => void,
  onRetry: () => void,
): Promise<{ usage: QaUsage | null }> {
  let anythingStreamed = false;
  const relay = (delta: string): void => {
    anythingStreamed = true;
    onDelta(delta);
  };

  for (let attempt = 1; ; attempt++) {
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let res: StreamResponse;
    try {
      const controller = new AbortController();
      connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      res = await deps.fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${req.apiKey}`,
        },
        body: buildBody(req),
        signal: controller.signal,
      });
      if (!res.ok) throw errorForStatus(res.status);

      let outcome: { usage: QaUsage | null; sawContent: boolean };
      try {
        outcome = await readStream(res, relay, () => {
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
        });
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
      }
      if (outcome.sawContent || outcome.usage !== null) return { usage: outcome.usage };
      // A clean-but-empty stream: treat like a connection failure and retry.
      throw networkError();
    } catch (err) {
      if (connectTimer) clearTimeout(connectTimer);
      const mapped: StreamClientError =
        err && typeof err === 'object' && 'reason' in err && typeof (err as StreamClientError).reason === 'string'
          ? (err as StreamClientError)
          : networkError();

      // Never re-send after anything streamed: the answer is already billed
      // and a retry would double it (docs/06). Mid-stream failures surface
      // immediately; retries only cover the pre-stream phase.
      if (!isRetryable(mapped) || attempt >= MAX_ATTEMPTS || anythingStreamed) throw mapped;
      const delay = (BACKOFF_MS[attempt - 1] ?? 4_000) * (0.8 + Math.random() * 0.4);
      onRetry();
      await deps.sleep(delay);
    }
  }
}
