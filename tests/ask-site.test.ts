/**
 * ask-site handler seams (ADR-0010): the held-by-SW computation and the
 * get-qa-stream status assembly. The chrome stub must exist before the
 * imports evaluate — browser-api.ts captures `chrome` at module load.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chromeStub } = vi.hoisted(() => {
  const chromeStub = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
    },
    runtime: { getURL: (path: string) => path, sendMessage: async () => ({}) },
    permissions: { contains: async () => true },
  };
  (globalThis as Record<string, unknown>).chrome = chromeStub;
  return { chromeStub };
});

import { computeHeldBySw, getQaStreamStatus } from '../src/background/handlers/ask-site.js';

beforeEach(() => {
  delete (chromeStub as Record<string, unknown>).offscreen;
});

describe('computeHeldBySw', () => {
  const slot = { origin: 'https://example.com', requestId: 'q1' };

  it('is true only for the exact in-flight slot', () => {
    expect(computeHeldBySw(slot, 'https://example.com', 'q1')).toBe(true);
    expect(computeHeldBySw(slot, 'https://example.com', 'q2')).toBe(false);
    expect(computeHeldBySw(slot, 'https://other.com', 'q1')).toBe(false);
    expect(computeHeldBySw(null, 'https://example.com', 'q1')).toBe(false);
  });
});

describe('getQaStreamStatus', () => {
  it('reports inactive on Firefox, where the in-process stream dies with the event page', async () => {
    // No `offscreen` member on browserApi: the Firefox host path.
    const status = await getQaStreamStatus('https://example.com', 'q1');
    expect(status).toEqual({ active: false, heldBySw: false });
  });

  it('reports inactive on Chromium when no offscreen document exists', async () => {
    (chromeStub as Record<string, unknown>).offscreen = {
      hasDocument: async () => false,
    };
    const status = await getQaStreamStatus('https://example.com', 'q1');
    expect(status).toEqual({ active: false, heldBySw: false });
  });

  it('reports the host reply on Chromium when the offscreen document answers', async () => {
    (chromeStub as Record<string, unknown>).offscreen = {
      hasDocument: async () => true,
    };
    (chromeStub as Record<string, unknown>).runtime = {
      getURL: (path: string) => path,
      connect: () => ({
        name: 'siteqa-host',
        onMessage: { addListener: (listener: (v: unknown) => void) => {
          setTimeout(() => listener({ type: 'stream-status-reply', requestId: 'q1', active: true }), 0);
        } },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
    };
    const status = await getQaStreamStatus('https://example.com', 'q1');
    expect(status).toEqual({ active: true, heldBySw: false });
  });
});
