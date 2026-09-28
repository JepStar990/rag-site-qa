import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { chromiumManifest } from './manifest.chromium';

export default defineConfig({
  plugins: [preact(), crx({ manifest: chromiumManifest, browser: 'chrome' })],
  build: {
    rollupOptions: {
      // The offscreen document is not referenced by the manifest; it is
      // opened at runtime via chrome.offscreen.createDocument (ADR-0001).
      // Chromium-only: the Firefox event page hosts inference in-process.
      input: { offscreen: 'src/offscreen/offscreen.html' },
    },
  },
});
