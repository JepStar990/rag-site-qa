import { browserApi } from '../../shared/browser-api';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { sanitizeSettings } from '../../shared/settings';
import type { Settings } from '../../shared/types';
import { getStoredKey } from '../../shared/key-store';

const SETTINGS_KEYS: string[] = ['modelPrefs', 'budget', 'caps', 'retrieval'];

/** Read settings from storage, merged with defaults and sanitized. */
export async function getStoredSettings(): Promise<Settings> {
  const stored = await browserApi.storage.local.get(SETTINGS_KEYS);
  return { ...sanitizeSettings(stored, DEFAULT_SETTINGS), apiKey: await getStoredKey() };
}

/**
 * Merge incoming user input over the stored settings and persist the
 * sanitized result. `apiKey` and `spentThisMonthUsd` are never accepted
 * from the bus (ADR-0006, docs/06).
 */
export async function saveStoredSettings(raw: unknown): Promise<Settings> {
  const next = sanitizeSettings(raw, await getStoredSettings());
  await browserApi.storage.local.set({
    modelPrefs: next.modelPrefs,
    budget: next.budget,
    caps: next.caps,
    retrieval: next.retrieval,
  });
  return next;
}
