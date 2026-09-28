import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { browserApi } from '../shared/browser-api';
import { MSG, PORT } from '../shared/msg-protocol';
import type { FailedUrl, Message, MessageResponse, ProgressPortEvent, SiteStatusMeta } from '../shared/msg-protocol';
import type { SiteIndexStatus, SourceInfo } from '../shared/types';
import { formatBytes } from '../shared/utils';
import './popup.css';

type SiteState = { origin: string; status: SiteIndexStatus | 'inactive' | 'unsupported' };

const site = signal<SiteState | null>(null);
const tabUrl = signal<string | null>(null);
const error = signal<string | null>(null);
const meta = signal<SiteStatusMeta | null>(null);
const sources = signal<SourceInfo[]>([]);
const failedUrls = signal<FailedUrl[]>([]);
const progress = signal<ProgressPortEvent | null>(null);
const indexing = signal(false);

async function sendMessage(message: Message): Promise<MessageResponse> {
  const res: unknown = await browserApi.runtime.sendMessage(message);
  if (typeof res !== 'object' || res === null || !('ok' in res)) {
    throw new Error('unexpected message response');
  }
  return res as MessageResponse;
}

async function loadSources(origin: string): Promise<void> {
  const res = await sendMessage({ type: MSG.listSources, origin });
  if (res.ok && res.kind === 'sources') {
    sources.value = res.sources;
    failedUrls.value = res.failed;
  }
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
  tabUrl.value = url;

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    site.value = { origin: parsed.origin, status: 'unsupported' };
    return;
  }

  const res = await sendMessage({ type: MSG.getSiteStatus, origin: parsed.origin });
  if (res.ok && res.kind === 'status') {
    site.value = { origin: parsed.origin, status: res.status };
    meta.value = res.meta;
    indexing.value = res.status === 'crawling' || res.status === 'embedding';
    if (res.status === 'ready') await loadSources(parsed.origin);
  } else {
    site.value = { origin: parsed.origin, status: 'inactive' };
  }
}

async function grantAccess(): Promise<void> {
  const origin = site.value?.origin;
  if (!origin) return;
  await browserApi.permissions.request({ origins: [`${origin}/*`] });
  await refresh();
}

async function startIndex(): Promise<void> {
  const origin = site.value?.origin;
  const url = tabUrl.value;
  if (!origin || !url) return;
  error.value = null;
  const res = await sendMessage({ type: MSG.indexSite, origin, url });
  if (res.ok && res.kind === 'indexing') {
    indexing.value = true;
    progress.value = null;
  } else if (!res.ok && res.error === 'permission') {
    error.value = 'Access to this site was revoked. Grant access again.';
    await refresh();
  }
}

function onProgressEvent(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('type' in value)) return;
  const event = value as ProgressPortEvent;
  if (event.origin !== site.value?.origin) return;
  if (event.type === 'index-progress') {
    progress.value = event;
    indexing.value = true;
  } else if (event.type === 'index-ready') {
    indexing.value = false;
    progress.value = null;
    void refresh();
  } else if (event.type === 'index-failed') {
    indexing.value = false;
    progress.value = null;
    error.value = event.reason;
    void refresh();
  }
}

/** Subscribes to progress events for the current origin; reconnects while mounted. */
function useProgressPort(origin: string | null): void {
  useEffect(() => {
    if (!origin) return;
    let port: chrome.runtime.Port | null = null;
    let disposed = false;

    const connect = () => {
      const p = browserApi.runtime.connect({ name: PORT.progress });
      port = p;
      p.onMessage.addListener(onProgressEvent);
      p.onDisconnect.addListener(() => {
        if (disposed) return;
        port = null;
        window.setTimeout(() => {
          if (!disposed) connect();
        }, 500);
      });
      p.postMessage({ type: 'subscribe', origin });
    };

    connect();
    return () => {
      disposed = true;
      port?.disconnect();
    };
  }, [origin]);
}

function IndexButton() {
  const current = site.value;
  if (!current || current.status === 'inactive' || current.status === 'unsupported') return null;
  const disabled = indexing.value || (current.status !== 'idle' && current.status !== 'ready' && current.status !== 'failed');
  return (
    <button class="primary" disabled={disabled} onClick={() => void startIndex()}>
      {current.status === 'ready' ? 'Re-index site' : 'Index this site'}
    </button>
  );
}

function ProgressView() {
  const current = progress.value;
  const crawling = current?.type === 'index-progress' && current.phase === 'crawling' ? current : null;
  const embedding = current?.type === 'index-progress' && current.phase === 'embedding' ? current : null;
  const percent =
    embedding && embedding.totalChunks > 0
      ? Math.min(100, Math.round((embedding.chunks / embedding.totalChunks) * 100))
      : null;
  return (
    <div class="index-card">
      {crawling && <p>Indexing pages: {crawling.pages} pages, {crawling.chunks} chunks</p>}
      {embedding && (
        <>
          <p>Embedding chunks: {embedding.chunks} / {embedding.totalChunks}</p>
          <div class="bar">
            <div class="bar-fill" style={{ width: `${percent ?? 0}%` }} />
          </div>
        </>
      )}
      {!current && <p class="muted">Indexing in progress...</p>}
    </div>
  );
}

function SourcesView() {
  const rows = sources.value;
  if (rows.length === 0 && failedUrls.value.length === 0) {
    return <p class="muted">No pages indexed yet.</p>;
  }
  return (
    <div class="sources">
      <div class="stat-row">
        <span class="muted">Indexed</span>
        <span>{meta.value ? `${meta.value.chunkCount} chunks` : ''}</span>
      </div>
      {meta.value && (
        <div class="stat-row">
          <span class="muted">Storage</span>
          <span>{formatBytes(meta.value.sizeEstimateBytes)}</span>
        </div>
      )}
      {meta.value?.lastCrawledAt && (
        <div class="stat-row">
          <span class="muted">Last indexed</span>
          <span>{new Date(meta.value.lastCrawledAt).toLocaleString()}</span>
        </div>
      )}
      {rows.length > 0 && <h2>Sources</h2>}
      {rows.map((row) => (
        <div class="source-row" key={row.url}>
          <span class="source-title">{row.title}</span>
          <span class="muted source-url">{row.url}</span>
          <span>
            {row.chunkCount} chunks &middot; {new Date(row.crawledAt).toLocaleDateString()}
          </span>
        </div>
      ))}
      {failedUrls.value.length > 0 && (
        <>
          <h2>Failed pages</h2>
          {failedUrls.value.map((failed) => (
            <div class="source-row" key={failed.url}>
              <span class="muted source-url">{failed.url}</span>
              <span>{failed.attempts} attempts</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function App() {
  useEffect(() => {
    void refresh();
  }, []);

  const current = site.value;
  useProgressPort(
    current && current.status !== 'unsupported' && current.status !== 'inactive' ? current.origin : null,
  );

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
          {current.status === 'idle' && (
            <>
              <p class="status-ok">Access granted. Ready to index.</p>
              <IndexButton />
            </>
          )}
          {indexing.value && <ProgressView />}
          {!indexing.value && current.status === 'ready' && (
            <>
              <p class="status-ok">Site indexed.</p>
              <SourcesView />
              <IndexButton />
            </>
          )}
          {!indexing.value && current.status === 'failed' && (
            <>
              <p class="status-err">Indexing failed.</p>
              <SourcesView />
              <IndexButton />
            </>
          )}
        </div>
      )}
    </div>
  );
}
