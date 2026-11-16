import { useEffect, useMemo, useState } from 'react';
import { configApi, type ProviderInfo } from '../../lib/configApi';
import { Select } from './ui';

export const MODEL_HINT =
  'Point this Bot at a different API. Each Bot can use its own provider and model, so one can run on MiniMax while another runs on DeepSeek or MiMo. Leave it on the account default to use the server-wide setting.';

/**
 * Choose which API and model a Bot runs on. Providers come from the server, so
 * the list is whatever that install has keys for.
 */
export function ModelPicker({ provider, model, onChange }: { provider: string; model: string; onChange: (provider: string, model: string) => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    configApi
      .providers()
      .then((d) => {
        setProviders(d.providers);
        setDefaultId(d.default);
      })
      .catch(() => setFailed(true));
  }, []);

  const effectiveId = provider || defaultId || '';
  const active = useMemo(() => providers.find((p) => p.id === effectiveId), [providers, effectiveId]);

  const providerOptions = useMemo(() => {
    const opts = [{ value: '', label: defaultId ? `Account default (${defaultId})` : 'Account default' }];
    for (const p of providers) {
      if (!p.available) continue;
      opts.push({ value: p.id, label: p.label });
    }
    return opts;
  }, [providers, defaultId]);

  const modelOptions = useMemo(() => {
    const models = active?.models ?? [];
    const opts = models.length ? models.map((m) => ({ value: m, label: m })) : [{ value: '', label: 'Provider default' }];
    if (model && !models.includes(model)) opts.unshift({ value: model, label: `${model} (custom)` });
    return opts;
  }, [active, model]);

  if (failed) return <div className="cfg-field__hint">Could not load the model providers from the server.</div>;
  if (!providers.length) return <div className="cfg-field__hint">No model providers are configured on the server yet.</div>;

  return (
    <div className="cfg-model">
      <Select
        label="Model provider"
        id="cfg-provider"
        value={provider}
        options={providerOptions}
        onChange={(v) => {
          const next = providers.find((p) => p.id === v);
          const nextModel = next?.models?.[0] ?? '';
          onChange(v, v ? nextModel : '');
        }}
      />
      <Select
        label="Model"
        id="cfg-model"
        value={model || active?.models?.[0] || ''}
        options={modelOptions}
        disabled={!effectiveId}
        onChange={(v) => onChange(provider, v)}
      />
    </div>
  );
}
