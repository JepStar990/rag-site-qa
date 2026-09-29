import { browserApi } from '../../shared/browser-api';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { sanitizeSettings } from '../../shared/settings';
import type { Settings } from '../../shared/types';
import { getStoredKey } from '../../shared/key-store';
import { answerCostUsd, currentMonthKey } from '../../lib/qa/spend';

const SETTINGS_KEYS: string[] = ['modelPrefs', 'budget', 'caps', 'retrieval'];

/** Read settings from storage, merged with defaults and sanitized. */
export async function getStoredSettings(): Promise<Settings> {
  const stored = await browserApi.storage.local.get(SETTINGS_KEYS);
  const settings = sanitizeSettings(stored, DEFAULT_SETTINGS);
  // `spentThisMonthUsd` and `spendMonth` are written only by the spend
  // writers (the SW and the runtime host takeover path, ADR-0010). sanitizeSettings
  // takes them from its `current` argument (bus saves must never touch
  // them), which is the defaults here — so re-attach the persisted values
  // after sanitizing the rest, or the spend counter would reset on every
  // read and the monthly cap could never trigger.
  const budget = stored.budget;
  if (budget && typeof budget === 'object') {
    const persisted = budget as { spentThisMonthUsd?: unknown; spendMonth?: unknown };
    if (typeof persisted.spentThisMonthUsd === 'number' && Number.isFinite(persisted.spentThisMonthUsd)) {
      settings.budget.spentThisMonthUsd = persisted.spentThisMonthUsd;
    }
    if (typeof persisted.spendMonth === 'string' && /^\d{4}-\d{2}$/.test(persisted.spendMonth)) {
      settings.budget.spendMonth = persisted.spendMonth;
    }
  }
  return { ...settings, apiKey: await getStoredKey() };
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

/**
 * Adds one answer's cost to the month-to-date counter (docs/06 token
 * accounting). The counter resets when the local calendar month changes;
 * this write and the runtime host's takeover write (ADR-0010) are the only
 * places `spentThisMonthUsd` can change.
 */
export async function addSpend(
  promptTokens: number,
  completionTokens: number,
): Promise<{ costUsd: number; spentThisMonthUsd: number }> {
  return withSpendLock(async () => {
    const settings = await getStoredSettings();
    const month = currentMonthKey();
    const base = settings.budget.spendMonth === month ? settings.budget.spentThisMonthUsd : 0;
    const costUsd = answerCostUsd(promptTokens, completionTokens, settings.budget.pricePerMTokens);
    const spentThisMonthUsd = base + costUsd;
    await browserApi.storage.local.set({
      budget: { ...settings.budget, spentThisMonthUsd, spendMonth: month },
    });
    return { costUsd, spentThisMonthUsd };
  });
}

/**
 * Serializes the spend read-modify-write across contexts. Two writers now
 * exist — the SW and the takeover host (ADR-0010) — and an interleaved
 * get-compute-set from both would silently drop one increment. Web Locks
 * is available in the SW and the offscreen document; fall back to the
 * unguarded path where it is not (docs/06 frames spend as an estimate).
 */
async function withSpendLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return fn();
  return locks.request('siteqa:spend', fn);
}
