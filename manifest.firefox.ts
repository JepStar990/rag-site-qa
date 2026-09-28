import { defineManifest } from '@crxjs/vite-plugin';

/**
 * Firefox manifest (ADR-0009). Deltas from Chromium:
 * - no `offscreen` permission (API does not exist; the background event page
 *   is the runtime host, kept alive by extension-API heartbeats per ADR-0001)
 * - `background.scripts` (event page) instead of `service_worker`; Firefox
 *   MV3 has no service workers and no background `type` field
 * - CSP keeps `script-src 'self'` without `'wasm-unsafe-eval'`: Firefox does
 *   not implement the keyword (web-ext flags it) and does not require it for
 *   WASM compilation (07)
 * - stable extension id and min version via browser_specific_settings
 */
export const firefoxManifest = defineManifest({
  manifest_version: 3,
  name: 'SiteQA',
  version: '0.1.0',
  description: 'Ask questions about any website. SiteQA indexes the whole site locally and answers with citations.',
  action: { default_popup: 'src/popup/popup.html' },
  // options_ui with open_in_tab is supported since Firefox 42; options_page
  // only landed in 126.
  options_ui: { page: 'src/options/options.html', open_in_tab: true },
  background: { scripts: ['src/background/index.ts'] },
  permissions: ['storage', 'unlimitedStorage', 'activeTab'],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  host_permissions: ['https://api.deepseek.com/*'],
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'none'; connect-src 'self' https://api.deepseek.com; base-uri 'none'; frame-ancestors 'none';",
  },
  browser_specific_settings: {
    gecko: {
      id: 'siteqa@rag-site-qa.dev',
      // 128: the first release supporting optional_host_permissions (07).
      strict_min_version: '128.0',
    },
  },
});
