import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { firefoxManifest } from './manifest.firefox';

export default defineConfig({
  plugins: [preact(), crx({ manifest: firefoxManifest, browser: 'firefox' })],
});
