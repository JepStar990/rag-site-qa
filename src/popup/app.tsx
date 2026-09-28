import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { browserApi } from '../shared/browser-api';
import { MSG } from '../shared/msg-protocol';
import type { Message, MessageResponse } from '../shared/msg-protocol';
import type { SiteIndexStatus } from '../shared/types';
import './popup.css';

type SiteState = { origin: string; status: SiteIndexStatus | 'inactive' | 'unsupported' };

const site = signal<SiteState | null>(null);
const error = signal<string | null>(null);

async function sendMessage(message: Message): Promise<MessageResponse> {
  const res: unknown = await browserApi.runtime.sendMessage(message);
  if (typeof res !== 'object' || res === null || !('ok' in res)) {
    throw new Error('unexpected message response');
  }
  return res as MessageResponse;
}

async function refresh(): Promise<void> {
  error.value = null;
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;
  if (!url) {
    site.value = null;
    error.value = 'Could not read the current tab.';
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    site.value = { origin: '', status: 'unsupported' };
    return;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    site.value = { origin: parsed.origin, status: 'unsupported' };
    return;
  }

  const res = await sendMessage({ type: MSG.getSiteStatus, origin: parsed.origin });
  site.value =
    res.ok && res.kind === 'status'
      ? { origin: parsed.origin, status: res.status }
      : { origin: parsed.origin, status: 'inactive' };
}

async function grantAccess(): Promise<void> {
  const origin = site.value?.origin;
  if (!origin) return;
  await browserApi.permissions.request({ origins: [`${origin}/*`] });
  await refresh();
}

export function App() {
  useEffect(() => {
    void refresh();
  }, []);

  const current = site.value;

  return (
    <div class="popup">
      <header class="popup-header">
        <h1>SiteQA</h1>
        <a class="options-link" href="#" onClick={(e) => { e.preventDefault(); void browserApi.runtime.openOptionsPage(); }}>
          Settings
        </a>
      </header>

      {error.value && <div class="banner banner-error">{error.value}</div>}

      {current === null && !error.value && <p class="muted">Loading...</p>}

      {current?.status === 'unsupported' && (
        <p class="muted">SiteQA works on http and https sites. Open a regular website to use it.</p>
      )}

      {current && current.status !== 'unsupported' && (
        <div class="site-card">
          <div class="site-origin">{current.origin}</div>
          {current.status === 'inactive' && (
            <>
              <p>
                Grant SiteQA access to this site so it can crawl and index it locally.
                Access is per-site, only for pages you see, and revocable at any time.
              </p>
              <button class="primary" onClick={() => void grantAccess()}>
                Grant access to this site
              </button>
            </>
          )}
          {current.status === 'idle' && <p class="status-ok">Access granted. Ready to index.</p>}
          {(current.status === 'crawling' || current.status === 'embedding') && <p>Indexing in progress.</p>}
          {current.status === 'ready' && <p class="status-ok">Site indexed.</p>}
          {current.status === 'failed' && <p class="status-err">Indexing failed. See the sources view for details.</p>}
        </div>
      )}
    </div>
  );
}
