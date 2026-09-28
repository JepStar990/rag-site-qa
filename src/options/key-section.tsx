import { useEffect, useState } from 'preact/hooks';
import { browserApi } from '../shared/browser-api';
import { clearStoredKey, getStoredKey, saveStoredKey } from '../shared/key-store';
import { MSG } from '../shared/msg-protocol';
import { testDeepSeekKey, type TestKeyResult } from '../lib/llm/test-key';

type KeyStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'saved' }
  | { kind: 'deleted' }
  | { kind: 'result'; result: TestKeyResult };

function resultMessage(result: TestKeyResult): string {
  if (result.ok) return 'Key works with the selected model.';
  switch (result.reason) {
    case 'invalid_key':
      return 'Key rejected (401). Verify it in the DeepSeek dashboard.';
    case 'no_balance':
      return 'Account has no balance (402). Top up in the DeepSeek dashboard.';
    case 'rate_limited':
      return 'Rate limited (429). Try again in a moment.';
    case 'bad_request':
      return 'Request rejected. Check the model ID under Model settings.';
    case 'network_error':
      return 'Could not reach DeepSeek. Check your connection.';
  }
}

export function KeySection() {
  const [storedKey, setStoredKey] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [modelId, setModelId] = useState('deepseek-v4-flash');
  const [status, setStatus] = useState<KeyStatus>({ kind: 'idle' });

  useEffect(() => {
    void (async () => {
      setStoredKey(await getStoredKey());
      const res = (await browserApi.runtime.sendMessage({ type: MSG.getSettings })) as
        | { ok: true; kind: 'settings'; settings: { modelPrefs: { modelId: string } } }
        | undefined;
      if (res?.ok) setModelId(res.settings.modelPrefs.modelId);
    })();
  }, []);

  async function save(): Promise<void> {
    const key = input.trim();
    if (!key) return;
    await saveStoredKey(key);
    setStoredKey(key);
    setInput('');
    setStatus({ kind: 'saved' });
  }

  async function test(): Promise<void> {
    const key = input.trim() || storedKey;
    if (!key) return;
    setStatus({ kind: 'testing' });
    setStatus({ kind: 'result', result: await testDeepSeekKey(key, modelId) });
  }

  async function remove(): Promise<void> {
    await clearStoredKey();
    setStoredKey(null);
    setStatus({ kind: 'deleted' });
  }

  return (
    <div class="key-section">
      <p>
        {storedKey ? (
          <>Key stored: ending in <code>{storedKey.slice(-4)}</code>.</>
        ) : (
          <>No key stored yet. SiteQA indexes sites without one; a key is needed to ask questions.</>
        )}
      </p>

      <label class="field">
        <span>New key</span>
        <input
          type="password"
          value={input}
          placeholder="sk-..."
          onInput={(e) => setInput(e.currentTarget.value)}
        />
      </label>

      <div class="row">
        <button class="primary" onClick={() => void save()} disabled={!input.trim()}>
          Save key
        </button>
        <button onClick={() => void test()} disabled={status.kind === 'testing'}>
          {status.kind === 'testing' ? 'Testing...' : 'Test key'}
        </button>
        {storedKey && (
          <button onClick={() => void remove()} disabled={status.kind === 'testing'}>
            Delete
          </button>
        )}
      </div>

      {status.kind === 'saved' && <p class="status-ok">Key saved.</p>}
      {status.kind === 'deleted' && <p>Key deleted.</p>}
      {status.kind === 'result' && (
        <p class={status.result.ok ? 'status-ok' : 'status-err'}>{resultMessage(status.result)}</p>
      )}
      <p class="muted">
        The key is stored only in this browser's local extension storage and is never synced.
      </p>
    </div>
  );
}
