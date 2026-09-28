/**
 * Settings sanitization (docs/05-data-model.md).
 *
 * Settings arrive from the options page over the message bus and are merged
 * with defaults and clamped to documented bounds before they touch storage.
 * `apiKey` and `spentThisMonthUsd` are never accepted from the bus: the key
 * is written only by the options page directly, and spend is maintained by
 * the service worker (ADR-0006, docs/06).
 */

import { DEFAULT_SETTINGS, type Settings } from './types';
import { clampPoliteness } from './utils';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const clampNum = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  Math.round(clampNum(v, min, max, fallback));

const clampBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

const clampString = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;

const clampMonth = (v: unknown, fallback: string | null): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : fallback;

/**
 * Merge partial user input with `current` (the stored settings) and clamp
 * everything to documented bounds. `current` defaults to DEFAULT_SETTINGS.
 */
export function sanitizeSettings(raw: unknown, current: Settings = DEFAULT_SETTINGS): Settings {
  const r = isRecord(raw) ? raw : {};
  const modelPrefs = isRecord(r.modelPrefs) ? r.modelPrefs : {};
  const budget = isRecord(r.budget) ? r.budget : {};
  const price = isRecord(budget.pricePerMTokens) ? budget.pricePerMTokens : {};
  const caps = isRecord(r.caps) ? r.caps : {};
  const retrieval = isRecord(r.retrieval) ? r.retrieval : {};

  const chunkTokens = clampInt(caps.chunkTokens, 64, 2048, current.caps.chunkTokens);
  const overlap = Math.min(
    clampInt(caps.chunkOverlapTokens, 0, chunkTokens, current.caps.chunkOverlapTokens),
    chunkTokens - 1,
  );

  return {
    apiKey: current.apiKey,
    modelPrefs: {
      modelId: clampString(modelPrefs.modelId, current.modelPrefs.modelId),
      thinking: clampBool(modelPrefs.thinking, current.modelPrefs.thinking),
      temperature:
        modelPrefs.temperature === null
          ? null
          : clampNum(modelPrefs.temperature, 0, 2, 0.3),
      maxOutputTokens: clampInt(modelPrefs.maxOutputTokens, 64, 8192, current.modelPrefs.maxOutputTokens),
    },
    budget: {
      monthlyLimitUsd: clampNum(budget.monthlyLimitUsd, 0, 1000, current.budget.monthlyLimitUsd),
      spentThisMonthUsd: current.budget.spentThisMonthUsd,
      spendMonth: clampMonth(budget.spendMonth, current.budget.spendMonth),
      pricePerMTokens: {
        input: clampNum(price.input, 0.0001, 1000, current.budget.pricePerMTokens.input),
        output: clampNum(price.output, 0.0001, 1000, current.budget.pricePerMTokens.output),
      },
    },
    caps: {
      maxPages: clampInt(caps.maxPages, 10, 10000, current.caps.maxPages),
      maxDepth: clampInt(caps.maxDepth, 1, 20, current.caps.maxDepth),
      maxChunksPerSite: clampInt(caps.maxChunksPerSite, 100, 100000, current.caps.maxChunksPerSite),
      politenessMs: clampPoliteness(
        clampInt(caps.politenessMs, 250, 1000, current.caps.politenessMs),
      ),
      chunkTokens,
      chunkOverlapTokens: overlap,
    },
    retrieval: {
      topK: clampInt(retrieval.topK, 1, 50, current.retrieval.topK),
      contextTokenBudget: clampInt(retrieval.contextTokenBudget, 512, 64000, current.retrieval.contextTokenBudget),
    },
  };
}

/** Settings shape returned over the bus: the key is always stripped (04). */
export function publicSettings(settings: Settings): Settings {
  return { ...settings, apiKey: null };
}
