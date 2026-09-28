import { defineManifest } from '@crxjs/vite-plugin';

/** Chromium-family manifest (Chrome, Edge, Brave, Opera). See docs/07-manifest-permissions.md. */
export const chromiumManifest = defineManifest({
  manifest_version: 3,
  name: 'SiteQA',
  version: '0.1.0',
  description: 'Ask questions about any website. SiteQA indexes the whole site locally and answers with citations.',
  action: { default_popup: 'src/popup/popup.html' },
  options_page: 'src/options/options.html',
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  permissions: ['storage', 'unlimitedStorage', 'offscreen', 'activeTab'],
  optional_host_permissions: ['https://*/*', 'http://*/*'],
  host_permissions: ['https://api.deepseek.com/*'],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' https://api.deepseek.com; base-uri 'none'; frame-ancestors 'none';",
  },
});
