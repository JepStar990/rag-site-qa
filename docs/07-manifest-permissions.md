# 07 — Manifest and Permissions

SiteQA ships two build targets from one codebase (ADR-0009): Chromium (Chrome, Edge, Brave, Opera) and Firefox. The manifests differ in exactly the places the platforms differ; everything else is shared.

## Manifest sketch (Chromium)

```json
{
  "manifest_version": 3,
  "name": "SiteQA",
  "version": "0.1.0",
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html",
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["storage", "unlimitedStorage", "offscreen", "activeTab"],
  "optional_host_permissions": ["https://*/*", "http://*/*"],
  "host_permissions": ["https://api.deepseek.com/*"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'none'; connect-src https://api.deepseek.com; base-uri 'none'; frame-ancestors 'none';"
  }
}
```

## Manifest sketch (Firefox delta)

```json
{
  "options_ui": { "page": "options.html", "open_in_tab": true },
  "background": { "scripts": ["background.js"] },
  "permissions": ["storage", "unlimitedStorage", "activeTab"],
  "browser_specific_settings": {
    "gecko": {
      "id": "siteqa@rag-site-qa.dev",
      "strict_min_version": "128.0"
    }
  }
}
```

Firefox has no `chrome.offscreen` API; the `offscreen` permission is stripped by the Firefox build target. Firefox MV3 backgrounds are always event pages (no persistence manifest key exists), so the background event page itself acts as the runtime host: long jobs keep it alive through the extension-API calls they make anyway (chunk relays and `chrome.storage.session` progress writes reset Firefox's idle timer — Bug 1844041). See ADR-0001. Unknown permissions are never shipped to a platform.

The Firefox target uses `options_ui` with `open_in_tab` (`options_page` only landed in Firefox 126) and sets `strict_min_version: 128.0` because `optional_host_permissions` arrived in Firefox 128. Both keys are verified by `web-ext lint` in CI.

Known `web-ext lint` warnings (8) and one notice, all accepted and non-blocking (AMO treats them as warnings):

- `UNSAFE_VAR_ASSIGNMENT` on bundled vendor code: Preact core and hooks (Preact ships an `innerHTML` assignment behind its `dangerouslySetInnerHTML` API), transformers.js (in-process in the Firefox background bundle), and DOMPurify. SiteQA code never assigns `innerHTML` or uses that API, and model output is rendered sanitized via marked + DOMPurify with a tag allowlist (04) — vendor-code false positives.
- `DANGEROUS_EVAL` on transformers.js: the bundled library uses the `Function` constructor for its WASM loader. Not called from SiteQA code; unavoidable while in-process inference is a hard requirement (ADR-0001).
- `UNSUPPORTED_API` in the Firefox background bundle: a reference to `chrome.offscreen` that is runtime-guarded by the `'offscreen' in browserApi` switch (ADR-0001) and never executed on Firefox.
- Notice `MISSING_DATA_COLLECTION_PERMISSIONS`: Firefox will require `data_collection_permissions` in the future. SiteQA collects no data (no analytics, no telemetry); the item will be set when the listing is created. M4's "linters pass" gate covers reviewing these before submission.

## Permission justification

| Permission | Why | Review note |
|---|---|---|
| `storage` | Settings and BYOK key in `chrome.storage.local` | No `storage.sync` usage; key is never synced |
| `unlimitedStorage` | Per-site vector indexes in IndexedDB exceed the default extension quota | Silent permission, no prompt |
| `offscreen` (Chromium only) | Host for local embedding inference and LLM streaming; the MV3 service worker cannot hold a live stream | Stripped from the Firefox build; Firefox uses the background event page as the host (ADR-0001) |
| `activeTab` | Read-only access to the active tab on a user click: lets the popup identify the current site (`tab.url`) without persistent tab access | No `tabs` permission; crawl access still requires a separate, explicit `optional_host_permissions` grant per site |
| `optional_host_permissions: http(s)://*/*` | Per-site crawl access, granted by the user per site via an optional-permission prompt when they activate SiteQA on a site | The extension works with zero host permissions granted; every grant is user-mediated and revocable |
| `host_permissions: https://api.deepseek.com/*` | Direct API calls to DeepSeek | Narrow to one host; CORS for the offscreen/runtime host context |

## Deliberately absent

| Capability | Why not |
|---|---|
| `content_scripts` in the manifest | Content scripts can read `chrome.storage`; a persistent injected script would be a key-exfiltration surface (04). A minimal script is injected on demand via `scripting` instead — and only on granted origins |
| `externally_connectable` | Would let web pages message the extension; not needed, strictly increases attack surface |
| `tabs` | The popup reads only the active tab's URL, which `activeTab` provides on a user click; no global tab access needed |
| `scripting` / injected scripts | No content scripts exist in v1: `activeTab` covers the popup's URL read. If a future feature needs page injection, the injected script will have zero storage access and one message type (04) |
| `<all_urls>` | Broader than `http(s)://*/*`; file and chrome schemes are never crawlable |
| Cookies, history, bookmarks, downloads | None are touched |

## CSP (both platforms)

Chromium: `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' https://api.deepseek.com; base-uri 'none'; frame-ancestors 'none';`. The `'wasm-unsafe-eval'` keyword is required for WASM compilation (onnxruntime-web in the embedder) and allows nothing but WASM; `connect-src 'self'` lets the service worker fetch the bundled tokenizer and model from the extension package (ADR-0002). Firefox: the same without `'wasm-unsafe-eval'` — Firefox does not implement the keyword (web-ext flags it) and does not require it for WASM. No remote code, no eval, no analytics domains.

## Build and package

- One Vite pipeline, two manifest targets (ADR-0009): the Firefox target strips `offscreen`, sets `background.scripts`, and adds `browser_specific_settings`.
- `web-ext` builds the Firefox package and runs the AMO linter in CI.
- The bundled embedding model (~34MB) ships in both packages; both stores allow it (ADR-0002).
- Web Store review aid: every permission above maps to a user-visible feature; the listing discloses that site content is sent to DeepSeek in prompts (06 privacy note).
