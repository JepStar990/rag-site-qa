/**
 * BYOK key storage (ADR-0006).
 *
 * The key lives only in chrome.storage.local. The options page writes it
 * directly (the only context allowed to write the key); the service worker
 * reads it. It never travels over the message bus, never appears in logs,
 * and is never synced.
 */

import { browserApi } from './browser-api';

export async function getStoredKey(): Promise<string | null> {
  const { apiKey } = await browserApi.storage.local.get('apiKey');
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : null;
}

export async function saveStoredKey(apiKey: string): Promise<void> {
  await browserApi.storage.local.set({ apiKey });
}

export async function clearStoredKey(): Promise<void> {
  await browserApi.storage.local.remove('apiKey');
}
