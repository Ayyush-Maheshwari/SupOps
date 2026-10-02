import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { patch, post } from '../lib/api';
import { Field, Panel, Segmented, Spinner } from './ui';
import type { Target } from '../lib/types';

type Kind = 'prometheus' | 'alertmanager' | 'loki' | 'elasticsearch' | 'grafana';
type AuthType = 'none' | 'bearer' | 'basic';

const KINDS: Array<{ value: Kind; label: string; hint: string; placeholder: string }> = [
  { value: 'prometheus', label: 'Prometheus', hint: 'Metrics via PromQL (Prometheus, Thanos, Mimir, VictoriaMetrics).', placeholder: 'https://prometheus.internal:9090' },
  { value: 'alertmanager', label: 'Alertmanager', hint: 'Active alerts and silences.', placeholder: 'https://alertmanager.internal:9093' },
  { value: 'loki', label: 'Loki', hint: 'Logs via LogQL.', placeholder: 'https://loki.internal:3100' },
  { value: 'elasticsearch', label: 'Elasticsearch', hint: 'Logs via Lucene query syntax (Elasticsearch or OpenSearch).', placeholder: 'https://es.internal:9200' },
  { value: 'grafana', label: 'Grafana', hint: 'PromQL through a Grafana Prometheus datasource (use a Viewer service-account token).', placeholder: 'https://grafana.internal' },
];

/**
 * Add or edit an observability connection. These are read-only to the agent: it can
 * query metrics, logs and alerts, never change anything. Credentials are sent once
 * and stored encrypted; they are never shown again.
 */
export function ConnectionForm({ projectId, existing, onDone }: { projectId: string; existing?: Target; onDone: () => void }) {
  const qc = useQueryClient();
  const isEdit = !!existing;
  const cfg = (existing?.config ?? {}) as { kind?: Kind; baseUrl?: string; allowPrivateNetwork?: boolean; insecureSkipVerify?: boolean; tenantId?: string; indices?: string[]; datasourceUid?: string };
  const [kind, setKind] = useState<Kind>(cfg.kind ?? 'prometheus');
  const [form, setForm] = useState({
    slug: existing?.slug ?? '',
    name: existing?.name ?? '',
    env: existing?.env ?? ('prod' as 'dev' | 'staging' | 'prod'),
    description: existing?.description ?? '',
    baseUrl: cfg.baseUrl ?? '',
    allowPrivateNetwork: cfg.allowPrivateNetwork ?? true,
    insecureSkipVerify: cfg.insecureSkipVerify ?? false,
    tenantId: cfg.tenantId ?? '',
    indices: (cfg.indices ?? []).join(', '),
    datasourceUid: cfg.datasourceUid ?? '',
  });
  const [authType, setAuthType] = useState<AuthType>(isEdit ? 'none' : 'none');
  const [changeAuth, setChangeAuth] = useState(!isEdit);
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const meta = KINDS.find((k) => k.value === kind)!;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const config = {
        kind,
        baseUrl: form.baseUrl.trim(),
        allowPrivateNetwork: form.allowPrivateNetwork,
        ...(form.insecureSkipVerify ? { insecureSkipVerify: true } : {}),
        ...(kind === 'loki' && form.tenantId.trim() ? { tenantId: form.tenantId.trim() } : {}),
        ...(kind === 'elasticsearch' ? { indices: form.indices.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) } : {}),
        ...(kind === 'grafana' && form.datasourceUid.trim() ? { datasourceUid: form.datasourceUid.trim() } : {}),
      };
      const auth =
        authType === 'bearer' ? { type: 'bearer', token } : authType === 'basic' ? { type: 'basic', username, password } : { type: 'none' };
      const body = {
        name: form.name || form.slug,
        env: form.env,
        description: form.description,
        config,
        ...(changeAuth ? { auth } : {}),
      };
      return isEdit ? patch<Target>(`/targets/${existing.id}`, body) : post<Target>('/targets', { ...body, projectId, slug: form.slug });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['targets', projectId] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the connection'),
  });

  return (
    <Panel title={isEdit ? `Edit ${existing.slug}` : 'Add an observability connection'} accent="bg-cyan" className="p-4">
      <div className="space-y-4 px-1 pb-1">
        {!isEdit && (
          <div>
            <Segmented label="Connection type" value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
            <p className="mt-1.5 text-[11px] text-muted">{meta.hint} The agent can only read from it.</p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {!isEdit && (
            <Field label="Slug (what the agent calls it)">
              <input className="input font-mono" value={form.slug} placeholder={`${kind}-prod`} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
            </Field>
          )}
          <Field label="Name"><input className="input" value={form.name} onChange={set('name')} /></Field>
          <Field label="Environment">
            <select className="input" value={form.env} onChange={set('env')}>
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </select>
          </Field>
          <Field label="API URL"><input className="input font-mono" value={form.baseUrl} placeholder={meta.placeholder} onChange={set('baseUrl')} /></Field>
          {kind === 'loki' && <Field label="Tenant (X-Scope-OrgID, optional)"><input className="input" value={form.tenantId} onChange={set('tenantId')} /></Field>}
          {kind === 'grafana' && <Field label="Prometheus datasource uid"><input className="input font-mono" value={form.datasourceUid} placeholder="e.g. P1809F7CD0C75ACF3" onChange={set('datasourceUid')} /></Field>}
          {kind === 'elasticsearch' && <Field label="Allowed index patterns (blank = any)"><input className="input font-mono" value={form.indices} placeholder="logs-*, app-*" onChange={set('indices')} /></Field>}
          <Field label="Description (helps the agent pick it)"><input className="input" value={form.description} onChange={set('description')} /></Field>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.allowPrivateNetwork} onChange={set('allowPrivateNetwork')} /> On a private network (LAN / in-cluster)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.insecureSkipVerify} onChange={set('insecureSkipVerify')} /> Accept a self-signed certificate</label>
        </div>

        <div className="space-y-2 border-t border-hairline pt-3">
          {isEdit && !changeAuth ? (
            <button className="btn-ghost" onClick={() => setChangeAuth(true)}>Change authentication…</button>
          ) : (
            <>
              <Segmented
                label="Authentication"
                value={authType}
                onChange={setAuthType}
                options={[{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Username & password' }]}
              />
              {authType === 'bearer' && <input className="input font-mono" type="password" placeholder="token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
              {authType === 'basic' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input className="input" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                  <input className="input" type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                </div>
              )}
              <p className="text-[11px] text-muted">Stored encrypted and never shown again. Use a read-only token where the backend supports one.</p>
            </>
          )}
        </div>

        {error && <p className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
        <div className="flex gap-2">
          <button
            className="btn-primary"
            disabled={save.isPending || !form.baseUrl.trim() || (!isEdit && !form.slug)}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner /> : null} {isEdit ? 'Save' : 'Add connection'}
          </button>
          <button className="btn-ghost" onClick={onDone}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}
