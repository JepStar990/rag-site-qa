import { describe, expect, it } from 'vitest';
import { isValidOrigin, parseMessage, MSG } from '../src/shared/msg-protocol.js';

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

  it('rejects unknown message types and malformed shapes', () => {
    expect(parseMessage({ type: 'steal-the-key' })).toBeNull();
    expect(parseMessage({})).toBeNull();
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('get-settings')).toBeNull();
  });
});
