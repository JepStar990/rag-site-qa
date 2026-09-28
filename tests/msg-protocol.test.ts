import { describe, expect, it } from 'vitest';
import {
  isEmbedBatchFrame,
  isHostFrame,
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
