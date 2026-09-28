import { describe, expect, it } from 'vitest';
import { streamChat, type StreamDeps, type StreamResponse } from '../src/lib/llm/stream-client.js';
import type { ChatMessage, ModelPrefs } from '../src/shared/types.js';

const encoder = new TextEncoder();

/** Builds an ok streaming response whose body carries the given SSE chunks. */
function sseResponse(...parts: string[]): StreamResponse {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: { getReader: () => stream.getReader() } };
}

const errorResponse = (status: number): StreamResponse => ({
  ok: false,
  status,
  body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
});

function harness(fetchImpl: StreamDeps['fetch']) {
  const sleeps: number[] = [];
  const retries: number[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const deps: StreamDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const deltas: string[] = [];
  const req = {
    messages: [
      { role: 'system', content: 'locked' },
      { role: 'user', content: 'question' },
    ] as ChatMessage[],
    apiKey: 'sk-test',
    modelPrefs: { modelId: 'deepseek-v4-flash', thinking: false, temperature: 0.3, maxOutputTokens: 2048 } as ModelPrefs,
  };
  const run = () => streamChat(req, deps, (d) => deltas.push(d), () => retries.push(retries.length + 1));
  return { sleeps, retries, calls, deltas, deps, run };
}

const deltaEvent = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

describe('streamChat', () => {
  it('relays deltas and resolves the reported usage', async () => {
    const usageEvent = JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40 } });
    const h = harness(async () => sseResponse(deltaEvent('Hel'), deltaEvent('lo'), `data: ${usageEvent}\n\n`, 'data: [DONE]\n\n'));
    const { usage } = await h.run();
    expect(h.deltas.join('')).toBe('Hello');
    expect(usage).toEqual({ promptTokens: 100, completionTokens: 40 });
    expect(h.sleeps).toHaveLength(0);
  });

  it('tolerates split chunks, keep-alive comments, and missing usage', async () => {
    const h = harness(async () =>
      sseResponse('data: {"choices":[{"delta":{"content":"a', 'b"}}]}\n', '\n: keep-alive\n\ndata: [DONE]\n\n'),
    );
    const { usage } = await h.run();
    expect(h.deltas.join('')).toBe('ab');
    expect(usage).toBeNull();
  });

  it('ignores reasoning_content deltas (SiteQA shows the answer only)', async () => {
    const reasoning = JSON.stringify({ choices: [{ delta: { reasoning_content: 'secret chain of thought' } }] });
    const h = harness(async () => sseResponse(`data: ${reasoning}\n\n`, deltaEvent('answer'), 'data: [DONE]\n\n'));
    await h.run();
    expect(h.deltas.join('')).toBe('answer');
  });

  it('sends the docs/06 envelope: stream, budgets, and explicit thinking toggle', async () => {
    const h = harness(async () => sseResponse(deltaEvent('x'), 'data: [DONE]\n\n'));
    await h.run();
    const body = JSON.parse(String(h.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.3);
    expect(body.extra_body).toEqual({ thinking: { type: 'disabled' } });
    expect((h.calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(h.calls[0]?.url).toBe('https://api.deepseek.com/chat/completions');
  });

  it('omits temperature while thinking is on and toggles the explicit thinking switch', async () => {
    const h = harness(async () => sseResponse(deltaEvent('x'), 'data: [DONE]\n\n'));
    const req = {
      messages: [{ role: 'user', content: 'q' }] as ChatMessage[],
      apiKey: 'k',
      modelPrefs: { modelId: 'deepseek-v4-pro', thinking: true, temperature: null, maxOutputTokens: 512 } as ModelPrefs,
    };
    await streamChat(req, h.deps, () => {}, () => {});
    const body = JSON.parse(String(h.calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.extra_body).toEqual({ thinking: { type: 'enabled' } });
    expect('temperature' in body).toBe(false);
  });

  it('maps 401/402/422/400 to their matrix errors without retrying', async () => {
    for (const [status, reason] of [
      [401, 'invalid_key'],
      [402, 'no_balance'],
      [422, 'too_large'],
      [400, 'bad_request'],
    ] as const) {
      const h = harness(async () => errorResponse(status));
      await expect(h.run()).rejects.toMatchObject({ reason });
      expect(h.calls).toHaveLength(1);
    }
  });

  it('retries 429 with backoff before anything streams, then succeeds', async () => {
    let attempt = 0;
    const h = harness(async () => {
      attempt++;
      if (attempt <= 2) return errorResponse(429);
      return sseResponse(deltaEvent('finally'), 'data: [DONE]\n\n');
    });
    const { usage } = await h.run();
    expect(h.calls).toHaveLength(3);
    expect(h.deltas.join('')).toBe('finally');
    expect(usage).toBeNull();
    expect(h.retries).toHaveLength(2);
    // Backoff band: 1s and 2s base, jitter 0.8-1.2.
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(800);
    expect(h.sleeps[0]).toBeLessThanOrEqual(1200);
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(1600);
    expect(h.sleeps[1]).toBeLessThanOrEqual(2400);
  });

  it('exhausts retries on persistent 5xx and throws the mapped provider error', async () => {
    const h = harness(async () => errorResponse(503));
    await expect(h.run()).rejects.toMatchObject({ reason: 'provider' });
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it('never re-sends after content started streaming', async () => {
    let attempt = 0;
    const h = harness(async () => {
      attempt++;
      if (attempt === 1) return errorResponse(429);
      // Second attempt streams a little, then the connection dies on the next pull.
      // (A pull source, unlike enqueue+error, actually delivers the chunk first.)
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(encoder.encode(deltaEvent('partial')));
          } else {
            controller.error(new Error('connection reset'));
          }
        },
      });
      return { ok: true, status: 200, body: { getReader: () => stream.getReader() } };
    });
    await expect(h.run()).rejects.toMatchObject({ reason: 'network' });
    expect(h.calls).toHaveLength(2);
    expect(h.deltas.join('')).toBe('partial');
  });

  it('retries a fetch that throws and an empty-but-ok stream', async () => {
    let attempt = 0;
    const h = harness(async () => {
      attempt++;
      if (attempt === 1) throw new Error('offline');
      if (attempt === 2) return sseResponse('');
      return sseResponse(deltaEvent('ok'), 'data: [DONE]\n\n');
    });
    const { usage } = await h.run();
    expect(h.calls).toHaveLength(3);
    expect(usage).toBeNull();
    expect(h.retries).toHaveLength(2);
  });
});
