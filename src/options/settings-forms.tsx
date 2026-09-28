import { useEffect, useState } from 'preact/hooks';
import { browserApi } from '../shared/browser-api';
import { MSG } from '../shared/msg-protocol';
import type { Settings } from '../shared/types';

const MODEL_IDS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'custom'];

interface NumFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}

function NumField({ label, value, min, max, disabled, onChange }: NumFieldProps) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onInput={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

export function SettingsForms() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = (await browserApi.runtime.sendMessage({ type: MSG.getSettings })) as
        | { ok: true; kind: 'settings'; settings: Settings }
        | undefined;
      if (res?.ok) setSettings(res.settings);
    })();
  }, []);

  async function save(): Promise<void> {
    if (!settings) return;
    const res = (await browserApi.runtime.sendMessage({ type: MSG.saveSettings, settings })) as
      | { ok: true; kind: 'settings'; settings: Settings }
      | undefined;
    if (res?.ok) {
      setSettings(res.settings);
      setSaved(true);
    }
  }

  if (!settings) return <p class="muted">Loading...</p>;

  const { modelPrefs, budget, caps, retrieval } = settings;
  const patch = (next: Partial<Settings>) => setSettings({ ...settings, ...next });

  return (
    <div class="settings-forms">
      <fieldset>
        <legend>Model</legend>
        <label class="field">
          <span>Model</span>
          <select
            value={MODEL_IDS.includes(modelPrefs.modelId) ? modelPrefs.modelId : 'custom'}
            onChange={(e) => {
              const v = e.currentTarget.value;
              const modelId = v === 'custom' ? '' : v;
              patch({ modelPrefs: { ...modelPrefs, modelId } });
            }}
          >
            {MODEL_IDS.map((id) => (
              <option key={id} value={id}>
                {id === 'custom' ? 'Custom...' : id}
              </option>
            ))}
          </select>
        </label>
        {!MODEL_IDS.slice(0, -1).includes(modelPrefs.modelId) && (
          <label class="field">
            <span>Custom model ID</span>
            <input
              type="text"
              value={modelPrefs.modelId}
              onInput={(e) => patch({ modelPrefs: { ...modelPrefs, modelId: e.currentTarget.value } })}
            />
          </label>
        )}
        <label class="check">
          <input
            type="checkbox"
            checked={modelPrefs.thinking}
            onChange={(e) => patch({ modelPrefs: { ...modelPrefs, thinking: e.currentTarget.checked } })}
          />
          <span>Thinking mode (temperature is ignored while on)</span>
        </label>
        <NumField
          label="Temperature"
          value={modelPrefs.temperature ?? 0.3}
          min={0}
          max={2}
          disabled={modelPrefs.thinking}
          onChange={(temperature) => patch({ modelPrefs: { ...modelPrefs, temperature } })}
        />
        <NumField
          label="Max output tokens"
          value={modelPrefs.maxOutputTokens}
          min={64}
          max={8192}
          onChange={(maxOutputTokens) => patch({ modelPrefs: { ...modelPrefs, maxOutputTokens } })}
        />
      </fieldset>

      <fieldset>
        <legend>Budget</legend>
        <NumField
          label="Monthly limit (USD)"
          value={budget.monthlyLimitUsd}
          min={0}
          max={1000}
          onChange={(monthlyLimitUsd) => patch({ budget: { ...budget, monthlyLimitUsd } })}
        />
        <p class="muted">
          Estimated spend this month: ${budget.spentThisMonthUsd.toFixed(2)}. The limit is a local
          guardrail; DeepSeek has no server-side cap for personal keys.
        </p>
        <NumField
          label="Price per 1M input tokens (USD)"
          value={budget.pricePerMTokens.input}
          min={0.0001}
          max={1000}
          onChange={(input) => patch({ budget: { ...budget, pricePerMTokens: { ...budget.pricePerMTokens, input } } })}
        />
        <NumField
          label="Price per 1M output tokens (USD)"
          value={budget.pricePerMTokens.output}
          min={0.0001}
          max={1000}
          onChange={(output) => patch({ budget: { ...budget, pricePerMTokens: { ...budget.pricePerMTokens, output } } })}
        />
      </fieldset>

      <fieldset>
        <legend>Crawl limits</legend>
        <NumField
          label="Max pages"
          value={caps.maxPages}
          min={10}
          max={10000}
          onChange={(maxPages) => patch({ caps: { ...caps, maxPages } })}
        />
        <NumField
          label="Max link depth"
          value={caps.maxDepth}
          min={1}
          max={20}
          onChange={(maxDepth) => patch({ caps: { ...caps, maxDepth } })}
        />
        <NumField
          label="Max chunks per site"
          value={caps.maxChunksPerSite}
          min={100}
          max={100000}
          onChange={(maxChunksPerSite) => patch({ caps: { ...caps, maxChunksPerSite } })}
        />
        <NumField
          label="Delay between fetches (ms)"
          value={caps.politenessMs}
          min={250}
          max={1000}
          onChange={(politenessMs) => patch({ caps: { ...caps, politenessMs } })}
        />
        <NumField
          label="Chunk size (tokens)"
          value={caps.chunkTokens}
          min={64}
          max={2048}
          onChange={(chunkTokens) => patch({ caps: { ...caps, chunkTokens } })}
        />
        <NumField
          label="Chunk overlap (tokens)"
          value={caps.chunkOverlapTokens}
          min={0}
          max={caps.chunkTokens - 1}
          onChange={(chunkOverlapTokens) => patch({ caps: { ...caps, chunkOverlapTokens } })}
        />
      </fieldset>

      <fieldset>
        <legend>Retrieval</legend>
        <NumField
          label="Top chunks per answer"
          value={retrieval.topK}
          min={1}
          max={50}
          onChange={(topK) => patch({ retrieval: { ...retrieval, topK } })}
        />
        <NumField
          label="Context budget (tokens)"
          value={retrieval.contextTokenBudget}
          min={512}
          max={64000}
          onChange={(contextTokenBudget) => patch({ retrieval: { ...retrieval, contextTokenBudget } })}
        />
      </fieldset>

      <div class="row">
        <button class="primary" onClick={() => void save()}>
          Save settings
        </button>
        {saved && <span class="status-ok">Saved.</span>}
      </div>
    </div>
  );
}
