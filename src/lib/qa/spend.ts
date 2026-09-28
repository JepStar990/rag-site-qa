/**
 * Spend accounting helpers (docs/06). Pure math here; the service worker's
 * settings store owns the persisted counter.
 */

export interface TokenPrices {
  input: number;
  output: number;
}

/** Cost in USD for one answer from its reported usage and per-1M-token prices. */
export function answerCostUsd(
  promptTokens: number,
  completionTokens: number,
  prices: TokenPrices,
): number {
  return (promptTokens / 1_000_000) * prices.input + (completionTokens / 1_000_000) * prices.output;
}

/** Local calendar month key ('YYYY-MM') for the spend counter reset (docs/06). */
export function currentMonthKey(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${month}`;
}
