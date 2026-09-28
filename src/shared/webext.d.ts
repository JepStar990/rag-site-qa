export {};

declare global {
  /** Firefox's promise-based `browser` namespace; absent on Chromium. */
  var browser: typeof chrome | undefined;
}
