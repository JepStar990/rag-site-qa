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
  "permissions": ["storage", "unlimitedStorage", "offscreen"],
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
  "background": { "scripts": ["background.js"], "type": "module" },
  "permissions": ["storage", "unlimitedStorage"],
  "browser_specific_settings": {
    "gecko": {
      "id": "siteqa@example.invalid",
      "strict_min_version": "121.0",
      "background": { "persistent": true }
    }
  }
}
```

Firefox has no `chrome.offscreen` API; the `offscreen` permission is stripped by the Firefox build target. Instead, `browser_specific_settings.gecko.background.persistent` opts the background script out of event-page unload, which is exactly the guarantee the offscreen document provides on Chromium (ADR-0001). Unknown permissions are never shipped to a platform.

## Permission justification

| Permission | Why | Review note |
|---|---|---|
| `storage` | Settings and BYOK key in `chrome.storage.local` | No `storage.sync` usage; key is never synced |
| `unlimitedStorage` | Per-site vector indexes in IndexedDB exceed the default extension quota | Silent permission, no prompt |
| `offscreen` (Chromium only) | Host for local embedding inference and LLM streaming; the MV3 service worker cannot hold a live stream | Stripped from the Firefox build |
| `optional_host_permissions: http(s)://*/*` | Per-site crawl access, granted by the user per site via an optional-permission prompt when they activate SiteQA on a site | The extension works with zero host permissions granted; every grant is user-mediated and revocable |
| `host_permissions: https://api.deepseek.com/*` | Direct API calls to DeepSeek | Narrow to one host; CORS for the offscreen/runtime host context |

## Deliberately absent

| Capability | Why not |
|---|---|
| `content_scripts` in the manifest | Content scripts can read `chrome.storage`; a persistent injected script would be a key-exfiltration surface (04). A minimal script is injected on demand via `scripting` instead — and only on granted origins |
| `externally_connectable` | Would let web pages message the extension; not needed, strictly increases attack surface |
| `activeTab` | Gives access to the current tab's origin implicitly; SiteQA wants explicit per-site grants so the user controls what is indexed |
| `tabs` | Tab URLs are obtained via the `page-info` message from the injected script; no global tab access needed |
| `scripting` as a named permission | Injected on demand under `activeTab`-style optional grants via the `scripting` API with `optional_host_permissions`; listed implicitly, but the injected script has zero storage access |
| `<all_urls>` | Broader than `http(s)://*/*`; file and chrome schemes are never crawlable |
| Cookies, history, bookmarks, downloads | None are touched |

## CSP (both platforms)

Identical to 04: `script-src 'self'; object-src 'none'; connect-src https://api.deepseek.com; base-uri 'none'; frame-ancestors 'none';`. Firefox enforces `extension_pages` CSP with the same semantics. No remote code, no eval, no analytics domains.

## Build and package

- One Vite pipeline, two manifest targets (ADR-0009): the Firefox target strips `offscreen`, sets `background.scripts`, and adds `browser_specific_settings`.
- `web-ext` builds the Firefox package and runs the AMO linter in CI.
- The bundled embedding model (~34MB) ships in both packages; both stores allow it (ADR-0002).
- Web Store review aid: every permission above maps to a user-visible feature; the listing discloses that site content is sent to DeepSeek in prompts (06 privacy note).
