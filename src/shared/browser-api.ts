/**
 * Cross-browser API handle (ADR-0009).
 *
 * Firefox exposes the promise-based `browser` namespace; Chromium exposes
 * `chrome` (also promise-based for the APIs SiteQA uses). No polyfill needed.
 */
export const browserApi: typeof chrome = globalThis.browser ?? chrome;
