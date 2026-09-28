import { describe, expect, it } from 'vitest';
import {
  isEmbedBatchFrame,
  isEmbedQueryFrame,
  isEmbedQueryResultFrame,
  isHostFrame,
  isStartStreamFrame,
  isStreamFrame,
  isValidOrigin,
  parseMessage,
  parsePortEvent,
  MSG,
} from '../src/shared/msg-protocol.js';

describe('isValidOrigin', () => {
  it('accepts bare https origins', () => {
    expect(isValidOrigin('https://example.com')).toBe(true);
  });

  it('rejects paths, ports, non-http schemes, and non-strings', () => {
    expect(isValidOrigin('https://example.com/path')).toBe(false);
    expect(isValidOrigin('https://example.com:8443')).toBe(false);
    expect(isValidOrigin('file:///etc/passwd')).toBe(false);
    expect(isValidOrigin('https://')).toBe(false);
    expect(isValidOrigin(null)).toBe(false);
    expect(isValidOrigin(42)).toBe(false);
  });
});

describe('parseMessage', () => {
  it('parses get-settings', () => {
    expect(parseMessage({ type: MSG.getSettings })).toEqual({ type: MSG.getSettings });
  });

  it('parses save-settings with an object payload', () => {
    const msg = parseMessage({ type: MSG.saveSettings, settings: { caps: { maxPages: 10 } } });
    expect(msg).toEqual({ type: MSG.saveSettings, settings: { caps: { maxPages: 10 } } });
  });

  it('rejects save-settings without an object payload', () => {
    expect(parseMessage({ type: MSG.saveSettings })).toBeNull();
    expect(parseMessage({ type: MSG.saveSettings, settings: 'x' })).toBeNull();
  });

  it('parses get-site-status with a valid origin', () => {
    expect(parseMessage({ type: MSG.getSiteStatus, origin: 'https://example.com' })).toEqual({
      type: MSG.getSiteStatus,
      origin: 'https://example.com',
    });
  });

  it('rejects get-site-status with a path, scheme, or missing origin', () => {
    expect(parseMessage({ type: MSG.getSiteStatus, origin: 'https://example.com/x' })).toBeNull();
    expect(parseMessage({ type: MSG.getSiteStatus, origin: 'javascript:alert(1)' })).toBeNull();
    expect(parseMessage({ type: MSG.getSiteStatus })).toBeNull();
  });

  it('parses list-sources with a valid origin', () => {
    expect(parseMessage({ type: MSG.listSources, origin: 'https://example.com' })).toEqual({
      type: MSG.listSources,
      origin: 'https://example.com',
    });
  });

  it('rejects list-sources with an invalid origin', () => {
    expect(parseMessage({ type: MSG.listSources, origin: 'https://example.com:8080' })).toBeNull();
    expect(parseMessage({ type: MSG.listSources })).toBeNull();
  });

  it('rejects unknown message types and malformed shapes', () => {
    expect(parseMessage({ type: 'steal-the-key' })).toBeNull();
    expect(parseMessage({})).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('get-settings')).toBeNull();
  });

  it('parses index-site with a normalized same-origin entry URL', () => {
    const msg = parseMessage({ type: MSG.indexSite, origin: 'https://example.com', url: 'https://example.com/path/' });
    expect(msg).toEqual({ type: MSG.indexSite, origin: 'https://example.com', url: 'https://example.com/path' });
  });

  it('rejects index-site when the entry URL escapes the granted origin', () => {
    expect(parseMessage({ type: MSG.indexSite, origin: 'https://example.com', url: 'https://other.com/x' })).toBeNull();
    expect(parseMessage({ type: MSG.indexSite, origin: 'https://example.com', url: 'https://example.com:8443/x' })).toBeNull();
    expect(parseMessage({ type: MSG.indexSite, origin: 'https://example.com', url: 'javascript:alert(1)' })).toBeNull();
    expect(parseMessage({ type: MSG.indexSite, origin: 'https://example.com', url: '' })).toBeNull();
    expect(parseMessage({ type: MSG.indexSite, origin: 'https://example.com', url: 'x'.repeat(4097) })).toBeNull();
    expect(parseMessage({ type: MSG.indexSite, origin: 'https://example.com' })).toBeNull();
    expect(parseMessage({ type: MSG.indexSite, origin: 'https://example.com/path', url: 'https://example.com' })).toBeNull();
  });
});

describe('parsePortEvent', () => {
  it('accepts a subscribe event with a valid origin', () => {
    expect(parsePortEvent({ type: 'subscribe', origin: 'https://example.com' })).toEqual({
      type: 'subscribe',
      origin: 'https://example.com',
    });
  });

  it('rejects malformed payloads', () => {
    expect(parsePortEvent({ type: 'other', origin: 'https://example.com' })).toBeNull();
    expect(parsePortEvent({ type: 'subscribe', origin: 'https://example.com:8080' })).toBeNull();
    expect(parsePortEvent({ type: 'subscribe' })).toBeNull();
    expect(parsePortEvent(null)).toBeNull();
  });
});

describe('isEmbedBatchFrame', () => {
  const frame = {
    type: 'embed-batch',
    dbName: 'site-abc',
    batchId: 1,
    chunks: [{ chunkId: 'a:0', text: 'text' }],
  };

  it('accepts a well-formed batch', () => {
    expect(isEmbedBatchFrame(frame)).toBe(true);
  });

  it('rejects oversized, empty, or malformed batches', () => {
    expect(isEmbedBatchFrame({ ...frame, chunks: [] })).toBe(false);
    expect(isEmbedBatchFrame({ ...frame, chunks: Array.from({ length: 65 }, () => ({ chunkId: 'c', text: 't' })) })).toBe(false);
    expect(isEmbedBatchFrame({ ...frame, chunks: [{ chunkId: 'a:0', text: '' }] })).toBe(false);
    expect(isEmbedBatchFrame({ ...frame, chunks: [{ chunkId: 'a:0' }] })).toBe(false);
    expect(isEmbedBatchFrame({ ...frame, batchId: '1' })).toBe(false);
    expect(isEmbedBatchFrame({ type: 'embed-done', dbName: 'site-abc', batchId: 1, embedded: 1 })).toBe(false);
    expect(isEmbedBatchFrame(null)).toBe(false);
  });
});

describe('isHostFrame', () => {
  it('accepts embed-done and embed-error acknowledgements', () => {
    expect(isHostFrame({ type: 'embed-done', dbName: 'site-abc', batchId: 1, embedded: 32 })).toBe(true);
    expect(isHostFrame({ type: 'embed-error', dbName: 'site-abc', batchId: 1, error: 'boom' })).toBe(true);
  });

  it('rejects request frames and malformed shapes', () => {
    expect(
      isHostFrame({ type: 'embed-batch', dbName: 'site-abc', batchId: 1, chunks: [] }),
    ).toBe(false);
    expect(isHostFrame({ type: 'embed-done', dbName: 'site-abc', batchId: 1 })).toBe(false);
    expect(isHostFrame({ type: 'embed-error', dbName: 'site-abc', batchId: 1, error: 5 })).toBe(false);
    expect(isHostFrame({ type: 'embed-done', dbName: 'site-abc' })).toBe(false);
  });
});

describe('parseMessage ask-site', () => {
  const ask = { type: MSG.ask, origin: 'https://example.com', question: 'what is this?', requestId: 'q123abc' };

  it('parses a well-formed ask', () => {
    expect(parseMessage(ask)).toEqual(ask);
  });

  it('trims the question and rejects empty or oversized ones', () => {
    expect(parseMessage({ ...ask, question: '  hi  ' })).toEqual({ ...ask, question: 'hi' });
    expect(parseMessage({ ...ask, question: '   ' })).toBeNull();
    expect(parseMessage({ ...ask, question: 'x'.repeat(4001) })).toBeNull();
    expect(parseMessage({ ...ask, question: 42 })).toBeNull();
  });

  it('rejects malformed requestIds and origins', () => {
    expect(parseMessage({ ...ask, requestId: 'has spaces' })).toBeNull();
    expect(parseMessage({ ...ask, requestId: '' })).toBeNull();
    expect(parseMessage({ ...ask, requestId: 'x'.repeat(65) })).toBeNull();
    expect(parseMessage({ ...ask, origin: 'https://example.com/path' })).toBeNull();
    expect(parseMessage({ ...ask, origin: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('isEmbedQueryFrame', () => {
  it('accepts a well-formed query embed request', () => {
    expect(isEmbedQueryFrame({ type: 'embed-query', batchId: 2, texts: ['a question'] })).toBe(true);
  });

  it('rejects empty, oversized, or malformed text lists', () => {
    expect(isEmbedQueryFrame({ type: 'embed-query', batchId: 2, texts: [] })).toBe(false);
    expect(isEmbedQueryFrame({ type: 'embed-query', batchId: 2, texts: [''] })).toBe(false);
    expect(isEmbedQueryFrame({ type: 'embed-query', batchId: 2, texts: Array.from({ length: 9 }, () => 't') })).toBe(false);
    expect(isEmbedQueryFrame({ type: 'embed-query', batchId: '2', texts: ['t'] })).toBe(false);
    expect(isEmbedQueryFrame({ type: 'embed-batch', batchId: 2, texts: ['t'] })).toBe(false);
  });
});

describe('isEmbedQueryResultFrame', () => {
  it('accepts embed-query-done with 384-dim vectors', () => {
    const vec = new Float32Array(384).fill(0.1);
    expect(isEmbedQueryResultFrame({ type: 'embed-query-done', batchId: 2, vecs: [vec] })).toBe(true);
  });

  it('rejects wrong-dimension vectors and error frames with bad shapes', () => {
    expect(isEmbedQueryResultFrame({ type: 'embed-query-done', batchId: 2, vecs: [new Float32Array(10)] })).toBe(false);
    expect(isEmbedQueryResultFrame({ type: 'embed-query-done', batchId: 2, vecs: [] })).toBe(false);
    expect(isEmbedQueryResultFrame({ type: 'embed-query-done', batchId: 2, vecs: [['x']] })).toBe(false);
    expect(isEmbedQueryResultFrame({ type: 'embed-query-error', batchId: 2, error: 5 })).toBe(false);
    expect(isEmbedQueryResultFrame({ type: 'embed-query-error', batchId: 2, error: 'boom' })).toBe(true);
  });
});

describe('isStartStreamFrame', () => {
  const frame = {
    type: 'start-stream',
    requestId: 'q1',
    apiKey: 'sk-key',
    messages: [
      { role: 'system', content: 'locked' },
      { role: 'user', content: 'question' },
    ],
    modelPrefs: { modelId: 'deepseek-v4-flash', thinking: false, temperature: 0.3, maxOutputTokens: 2048 },
  };

  it('accepts a well-formed start-stream frame', () => {
    expect(isStartStreamFrame(frame)).toBe(true);
  });

  it('rejects frames missing a key, messages, or prefs', () => {
    expect(isStartStreamFrame({ ...frame, apiKey: '' })).toBe(false);
    expect(isStartStreamFrame({ ...frame, messages: [{ role: 'user', content: 'x' }] })).toBe(false);
    expect(isStartStreamFrame({ ...frame, messages: [{ role: 'assistant', content: 'x' }, ...frame.messages.slice(1)] })).toBe(false);
    expect(isStartStreamFrame({ ...frame, modelPrefs: { modelId: '' } })).toBe(false);
    expect(isStartStreamFrame({ ...frame, requestId: '' })).toBe(false);
  });
});

describe('isStreamFrame', () => {
  it('accepts chunk, retry, done (with and without usage), and error frames', () => {
    expect(isStreamFrame({ type: 'stream-chunk', requestId: 'q1', delta: 'hi' })).toBe(true);
    expect(isStreamFrame({ type: 'stream-retry', requestId: 'q1' })).toBe(true);
    expect(isStreamFrame({ type: 'stream-done', requestId: 'q1', usage: null })).toBe(true);
    expect(isStreamFrame({ type: 'stream-done', requestId: 'q1', usage: { promptTokens: 5, completionTokens: 2 } })).toBe(true);
    expect(
      isStreamFrame({ type: 'stream-error', requestId: 'q1', error: { reason: 'invalid_key', message: 'x' } }),
    ).toBe(true);
  });

  it('rejects malformed usage, unknown error reasons, and foreign frames', () => {
    expect(isStreamFrame({ type: 'stream-done', requestId: 'q1', usage: { promptTokens: 'a' } })).toBe(false);
    expect(isStreamFrame({ type: 'stream-error', requestId: 'q1', error: { reason: 'haunted', message: 'x' } })).toBe(false);
    expect(isStreamFrame({ type: 'stream-chunk', requestId: 'q1', delta: 5 })).toBe(false);
    expect(isStreamFrame({ type: 'embed-batch', requestId: 'q1', delta: 'x' })).toBe(false);
  });
});
