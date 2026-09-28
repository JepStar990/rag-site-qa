# ADR-0009: One codebase, two build targets, namespace shim

Status: Accepted

## Context

The product must run on Chromium-family browsers (Chrome, Edge, Brave, Opera) and Firefox. The platforms differ in: offscreen support (Chromium only), background registration (service worker vs scripts + `gecko.background.persistent`), the `browser.*` promise namespace (Firefox's native) vs `chrome.*` (Chromium's native, Firefox's compatible), and packaging (CRX/ZIP for Web Store, XPI via web-ext for AMO).

## Decision

- **One TypeScript codebase**, no runtime forks beyond the runtime-host switch (ADR-0001).
- **Two manifest targets** from one Vite/crxjs pipeline: the Firefox target strips the `offscreen` permission, registers the background script with `browser_specific_settings.gecko.background.persistent`, and adds a stable extension ID (07).
- **A minimal namespace shim** (`const browser = globalThis.browser ?? chrome`) instead of the webextension-polyfill dependency: the APIs used (storage, runtime ports, offscreen on Chromium, scripting injection) are promise-based on both platforms' `chrome.*`, so a dependency buys nothing.
- **CI runs both targets**: Chromium lint plus `web-ext lint` and a Firefox smoke test from M1 (08).

## Consequences

- Platform deltas are visible in exactly two places: the manifest targets and the runtime-host switch; feature code stays platform-agnostic.
- Safari is out of scope for v1 by explicit decision: its MV3 gaps around persistent execution and optional host permissions are tracked as an M5 assessment (08).
- Unknown permissions are never shipped to a platform, keeping AMO and Web Store linters quiet.
- Choosing the shim over webextension-polyfill trades the polyfill's broader compat surface for zero dependency weight; acceptable because the API subset is deliberately small and both targets exercise it in CI.
