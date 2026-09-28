import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { chromiumManifest } from './manifest.chromium';

export default defineConfig({
  plugins: [preact(), crx({ manifest: chromiumManifest, browser: 'chrome' })],
});
