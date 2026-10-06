import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Activity, ArrowRight, Hourglass, Plus, RadioTower, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { formatEta, formatValue } from '@supops/shared';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, Field, Panel, Segmented, Spinner, Switch } from '../components/ui';
import { LineChart, seriesColor } from '../components/viz';
import type { Incident, ObsConnection, Observation, ObservabilityOverview, Watch, WatchDetail } from '../lib/types';

type Tab = 'overview' | 'incidents' | 'signals';

const SEV_DOT: Record<string, string> = { critical: 'bg-red', warning: 'bg-amber', info: 'bg-cyan', unknown: 'bg-dim' };
const SEV_TEXT: Record<string, string> = { critical: 'text-red', warning: 'text-amber', info: 'text-cyan', unknown: 'text-muted' };

export function Observability() {
  const projectId = useApp((s) => s.projectId);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const navigate = useNavigate();

  const overview = useQuery({
    queryKey: ['obs', projectId],
    queryFn: () => api<ObservabilityOverview>(`/observability/overview?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: 10_000,
  });

  const stack = useMutation({
    mutationFn: () => post<{ run: { id: string } }>('/observability/stack-investigate', { projectId }),
    onSuccess: ({ run }) => navigate(`/runs/${run.id}`),
  });

  const conns = overview.data?.connections ?? [];
  return (
    <>
      <PageHeader
        title="Observability"
        subtitle="Alerts grouped into incidents, investigated as they open. Signals watched for what is unusual and what is about to run out."
        action={
          conns.length > 0 ? (
            <button className="btn-ghost !min-h-[38px]" disabled={stack.isPending} onClick={() => stack.mutate()} title="Check that the monitoring itself works: scraping, rules, notifications, storage.">
              {stack.isPending ? <Spinner /> : <Search size={15} />} Check the stack
            </button>
          ) : undefined
        }
      />
      <div className="space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <Segmented
          label="View"
          value={tab}
          onChange={(t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'incidents', label: 'Incidents' },
            { value: 'signals', label: 'Signals' },
          ]}
        />
        {stack.isError && <p className="text-sm text-red">{(stack.error as Error).message}</p>}
        {overview.isLoading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : !conns.length ? (
          <Panel>
            <Empty
              icon={<RadioTower size={28} />}
              title="No metrics, logs or alerts connected"
              hint="Add a Prometheus, Grafana, Alertmanager, Loki or Elasticsearch connection. SupOps reads alerts from it, watches its signals and gathers evidence when something breaks. Everything it does there is read-only."
              action={<Link to="/targets" className="btn-primary">Add a connection</Link>}
            />
          </Panel>
        ) : tab === 'incidents' ? (
          <IncidentList projectId={projectId!} />
        ) : tab === 'signals' ? (
          <Signals projectId={projectId!} connections={conns} />
        ) : (
          <Overview data={overview.data!} />
        )}
      </div>
    </>
  );
}

// ---- overview ----------------------------------------------------------------------

function Overview({ data }: { data: ObservabilityOverview }) {
  const forecasts = data.observations
    .filter((o) => o.kind === 'forecast')
    .sort((a, b) => (a.details?.etaMs ?? Infinity) - (b.details?.etaMs ?? Infinity));
  const anomalies = data.observations.filter((o) => o.kind === 'anomaly');
  const soonest = forecasts[0]?.details?.etaMs;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-tile border border-hairline bg-hairline">
        <Stat label="Open incidents" value={data.incidents.length} tone={data.incidents.some((i) => i.severity === 'critical') ? 'text-red' : data.incidents.length ? 'text-amber' : 'text-ink'} />
        <Stat label="Unusual now" value={anomalies.length} tone={anomalies.length ? 'text-amber' : 'text-ink'} />
        <Stat label="Running out" value={forecasts.length} sub={soonest !== undefined ? `soonest in ${formatEta(soonest)}` : undefined} tone={forecasts.some((f) => f.severity === 'critical') ? 'text-red' : forecasts.length ? 'text-amber' : 'text-ink'} />
      </div>

      <Panel title="Open incidents" accent="bg-red">
        {data.incidents.length ? (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {data.incidents.map((i) => <IncidentRow key={i.id} incident={i} />)}
          </ul>
        ) : (
          <p className="px-5 pb-5 text-sm text-muted">Nothing open. New alerts are grouped here and investigated as they arrive.</p>
        )}
      </Panel>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title="Running out" accent="bg-amber">
          <ObservationList items={forecasts} empty="No resource is on course to run out within a week." icon={<Hourglass size={13} />} />
        </Panel>
        <Panel title="Unusual right now" accent="bg-violet">
          <ObservationList items={anomalies} empty="Every watched signal is within its usual range." icon={<Activity size={13} />} />
        </Panel>
      </div>

      <Panel title="Sources" accent="bg-cyan">
        <ul className="divide-y divide-hairline border-t border-hairline">
          {data.connections.map((c) => <SourceRow key={c.id} c={c} />)}
        </ul>
      </Panel>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone: string }) {
  return (
    <div className="bg-tile px-4 py-3.5">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={clsx('mt-0.5 text-2xl font-semibold tabular-nums tracking-tight', tone)}>{value}</div>
      {sub && <div className="text-[11px] leading-snug text-muted">{sub}</div>}
    </div>
  );
}

const TRIAGE_LABEL: Record<Incident['triageState'], string> = {
  none: 'Waiting',
  evidence: 'Gathering evidence',
  running: 'Diagnosing, read-only',
  done: 'Diagnosed',
  skipped: 'Evidence ready',
  failed: 'Triage failed',
};

export function IncidentRow({ incident: i }: { incident: Incident }) {
  return (
    <li>
      <Link to={`/observability/incidents/${i.id}`} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-white/[0.03]">
        <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEV_DOT[i.severity])} aria-label={i.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-ink">{i.title}</span>
            {i.origin === 'prediction' && <span className="text-[11px] text-amber">predicted</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {i.rootCause ? (
              <><span className="text-ink/80">{i.rootCause}</span>{i.confidence && <span> · {i.confidence}</span>}</>
            ) : (
              <>
                {TRIAGE_LABEL[i.triageState]}
                {i.alertCount ? ` · ${i.alertCount} alert${i.alertCount > 1 ? 's' : ''}` : ''}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
          {(i.triageState === 'evidence' || i.triageState === 'running') && <Spinner className="!h-3 !w-3 text-blue" />}
          <span className="hidden sm:inline">{timeAgo(i.status === 'resolved' ? i.resolvedAt : i.openedAt)}</span>
          <ArrowRight size={13} className="text-dim" />
        </div>
      </Link>
    </li>
  );
}

function ObservationList({ items, empty, icon }: { items: Observation[]; empty: string; icon: React.ReactNode }) {
  if (!items.length) return <p className="px-5 pb-5 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-hairline border-t border-hairline">
      {items.slice(0, 12).map((o) => (
        <li key={o.id} className="flex items-start gap-3 px-5 py-2.5">
          <span className={clsx('mt-0.5 shrink-0', SEV_TEXT[o.severity])}>{icon}</span>
          <div className="min-w-0 flex-1 text-[13px] leading-snug text-ink">
            {o.message}
            <div className="mt-0.5 text-[11px] text-muted">
              {o.kind === 'forecast' ? `${o.severity}${o.details?.confidence ? ` · ${o.details.confidence} confidence` : ''}` : (o.details as { direction?: string } | null)?.direction === 'down' ? 'below its usual range' : 'above its usual range'}
              {' · '}since {timeAgo(o.startedAt)}
              {o.incidentId && <> · <Link className="text-blue-text hover:underline" to={`/observability/incidents/${o.incidentId}`}>incident</Link></>}
            </div>
          </div>
        </li>
      ))}
      {items.length > 12 && <li className="px-5 py-2 text-[11px] text-muted">{items.length - 12} more</li>}
    </ul>
  );
}

function SourceRow({ c }: { c: ObsConnection }) {
  const qc = useQueryClient();
  const projectId = useApp((s) => s.projectId);
  const refresh = useMutation({
    mutationFn: () => post(`/observability/connections/${c.id}/refresh`, {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['obs', projectId] }),
  });
  const parts: Array<{ text: string; bad?: boolean }> = [];
  if (c.importsAlerts) {
    parts.push(c.poll ? (c.poll.ok ? { text: `${c.poll.firing} firing · read ${timeAgo(c.poll.at)}` } : { text: `alerts: ${c.poll.error ?? 'read failed'}`, bad: true }) : { text: 'alerts: first read pending' });
  }
  if (c.watches) {
    parts.push({ text: `${c.watchCount} signal${c.watchCount === 1 ? '' : 's'}${c.lastSampledAt ? ` · sampled ${timeAgo(c.lastSampledAt)}` : ''}` });
    if (c.watchErrors) parts.push({ text: `${c.watchErrors} failing`, bad: true });
  }
  if (!parts.length) parts.push({ text: 'used during investigations' });
  return (
    <li className="flex items-center gap-3 px-5 py-2.5">
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', parts.some((p) => p.bad) ? 'bg-red' : 'bg-green')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[13px] text-ink">{c.slug}</span>
          <span className="text-[11px] text-muted">{c.kind}</span>
        </div>
        <div className="truncate text-[11px]">
          {parts.map((p, i) => (
            <span key={i} className={p.bad ? 'text-red' : 'text-muted'}>{i ? ' · ' : ''}{p.text}</span>
          ))}
        </div>
      </div>
      {(c.importsAlerts || c.watches) && (
        <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs" disabled={refresh.isPending} onClick={() => refresh.mutate()} title="Read alerts and sample signals now">
          {refresh.isPending ? <Spinner className="!h-3 !w-3" /> : <RefreshCw size={13} />}
          <span className="hidden sm:inline">Refresh</span>
        </button>
      )}
    </li>
  );
}

// ---- incidents -----------------------------------------------------------------------

function IncidentList({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const list = useQuery({
    queryKey: ['incidents', projectId, status],
    queryFn: () => api<Incident[]>(`/observability/incidents?projectId=${projectId}&status=${status}`),
    refetchInterval: 10_000,
  });
  return (
    <Panel
      title={status === 'open' ? 'Open incidents' : 'Resolved incidents'}
      accent={status === 'open' ? 'bg-red' : 'bg-green'}
      action={<Segmented label="Status" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }]} />}
    >
      {list.isLoading ? (
        <div className="grid place-items-center py-10"><Spinner /></div>
      ) : list.data?.length ? (
        <ul className="divide-y divide-hairline border-t border-hairline">{list.data.map((i) => <IncidentRow key={i.id} incident={i} />)}</ul>
      ) : (
        <p className="px-5 pb-5 text-sm text-muted">{status === 'open' ? 'No open incidents.' : 'No resolved incidents in the last 15 days.'}</p>
      )}
    </Panel>
  );
}

// ---- signals ---------------------------------------------------------------------------

const GROUP_LABEL: Record<Watch['group'], string> = {
  resources: 'Resources',
  traffic: 'Traffic',
  kubernetes: 'Kubernetes',
  stack: 'Monitoring stack',
  custom: 'Custom',
};

function Signals({ projectId, connections }: { projectId: string; connections: ObsConnection[] }) {
  const [hours, setHours] = useState<'6' | '24' | '168'>('24');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ['watches', projectId, hours],
    queryFn: () => api<Watch[]>(`/observability/watches?projectId=${projectId}&hours=${hours}`),
    refetchInterval: 60_000,
  });
  const groups = useMemo(() => {
    const m = new Map<Watch['group'], Watch[]>();
    for (const w of list.data ?? []) m.set(w.group, [...(m.get(w.group) ?? []), w]);
    return [...m.entries()];
  }, [list.data]);
  const metricConns = connections.filter((c) => c.kind === 'prometheus' || c.kind === 'grafana');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }]} />
        {metricConns.length > 0 && (
          <button className="btn-ghost ml-auto !min-h-[34px] text-xs" onClick={() => setAdding((v) => !v)}>
            {adding ? <X size={13} /> : <Plus size={13} />} {adding ? 'Cancel' : 'Watch a query'}
          </button>
        )}
      </div>
      {adding && <AddWatch projectId={projectId} connections={metricConns} onDone={() => setAdding(false)} />}
      {list.isLoading ? (
        <div className="grid place-items-center py-10"><Spinner /></div>
      ) : !list.data?.length ? (
        <Panel>
          <Empty
            icon={<Activity size={26} />}
            title={metricConns.length ? 'Discovering signals…' : 'No metrics connection'}
            hint={metricConns.length ? 'SupOps looks for node_exporter, kube-state-metrics, cAdvisor and the monitoring stack’s own metrics, then samples them every few minutes. Refresh the source on the Overview to do it now.' : 'Add a Prometheus or Grafana connection to watch signals.'}
          />
        </Panel>
      ) : (
        groups.map(([g, ws]) => (
          <section key={g}>
            <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{GROUP_LABEL[g]}</h3>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {ws.map((w) => <WatchCard key={w.id} w={w} onOpen={() => setOpen(w.id)} />)}
            </div>
          </section>
        ))
      )}
      {open && <WatchDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function WatchCard({ w, onOpen }: { w: Watch; onOpen: () => void }) {
  const qc = useQueryClient();
  const projectId = useApp((s) => s.projectId);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch(`/observability/watches/${w.id}`, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['watches', projectId] }),
  });
  const flagged = w.series.filter((s) => s.flags.length);
  const latest = [...w.series]
    .map((s) => ({ name: s.name, v: s.points[s.points.length - 1]?.[1], flagged: s.flags.length > 0 }))
    .filter((s) => s.v !== undefined)
    .sort((a, b) => Number(b.flagged) - Number(a.flagged) || (w.badDirection === 'down' ? a.v! - b.v! : b.v! - a.v!))
    .slice(0, 3);

  return (
    <div className={clsx('tile flex flex-col p-4', !w.enabled && 'opacity-60')}>
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={onOpen} disabled={!w.enabled}>
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-ink">{w.title}</span>
            {flagged.length > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" title={`${flagged.length} series flagged`} />}
          </div>
          <div className="truncate font-mono text-[10.5px] text-muted">{w.connection}{w.seriesCount ? ` · ${w.seriesCount} series` : ''}</div>
        </button>
        <Switch label={`Watch ${w.title}`} checked={w.enabled} disabled={toggle.isPending} onChange={(v) => toggle.mutate(v)} />
      </div>
      {w.enabled && (
        <button className="mt-3 text-left" onClick={onOpen} aria-label={`Open ${w.title}`}>
          <LineChart
            compact
            height={56}
            empty={w.lastRunAt ? (w.lastError ? 'Query failed' : 'The query returns no data here') : 'First sample pending'}
            unit={w.unit}
            series={w.series.map((s) => ({ key: s.key, name: s.name, points: s.points, flagged: s.flags.length > 0 }))}
          />
          <div className="mt-2 space-y-0.5">
            {latest.map((s, i) => (
              <div key={i} className="flex items-center gap-2 text-[11.5px]">
                <span className={clsx('truncate', s.flagged ? 'text-amber' : 'text-muted')}>{s.name}</span>
                <span className="ml-auto shrink-0 font-mono text-ink">{formatValue(s.v!, w.unit)}</span>
              </div>
            ))}
          </div>
        </button>
      )}
      {w.lastError && w.enabled && <p className="mt-2 truncate text-[11px] text-red" title={w.lastError}>{w.lastError}</p>}
    </div>
  );
}

function WatchDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [hours, setHours] = useState<'24' | '72' | '168'>('24');
  const d = useQuery({
    queryKey: ['watch', id, hours],
    queryFn: () => api<WatchDetail>(`/observability/watches/${id}/series?hours=${hours}`),
  });
  const qc = useQueryClient();
  const projectId = useApp((s) => s.projectId);
  const remove = useMutation({
    mutationFn: () => del(`/observability/watches/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watches', projectId] });
      onClose();
    },
  });
  const [focus, setFocus] = useState<string | null>(null);
  const w = d.data?.watch;
  const series = (d.data?.series ?? []).filter((s) => !focus || s.key === focus);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div className="tile max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-b-none p-5 sm:rounded-b-tile" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={w?.title ?? 'Signal'}>
        <div className="mb-3 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-ink">{w?.title ?? '…'}</h2>
            {w && <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{w.query}</p>}
          </div>
          <button className="btn-ghost !min-h-[32px] !px-2" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: '24', label: '24h' }, { value: '72', label: '3d' }, { value: '168', label: '7d' }]} />
        <div className="mt-4">
          {d.isLoading || !w ? (
            <div className="grid h-[220px] place-items-center"><Spinner /></div>
          ) : (
            <LineChart
              height={220}
              unit={w.unit}
              limit={w.limit?.value}
              series={series.map((s) => ({ key: s.key, name: s.name, points: s.points, band: series.length === 1 ? s.band : null, forecast: s.forecast }))}
            />
          )}
        </div>
        {d.data && d.data.series.length > 0 && (
          <ul className="mt-4 divide-y divide-hairline rounded-inner border border-hairline">
            {d.data.series.map((s, i) => (
              <li key={s.key}>
                <button className={clsx('flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.03]', focus === s.key && 'bg-white/[0.04]')} onClick={() => setFocus(focus === s.key ? null : s.key)}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(focus ? 0 : i) }} />
                  <span className="min-w-0 flex-1 truncate text-ink">{s.name}</span>
                  {s.forecast && <span className="shrink-0 text-amber">out in {formatEta(s.forecast.etaMs)}</span>}
                  <span className="shrink-0 font-mono text-muted">{formatValue(s.points[s.points.length - 1]?.[1] ?? NaN, w!.unit)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {w && !w.builtin && (
          <button className="btn-ghost mt-4 !min-h-[32px] text-xs text-red" onClick={() => remove.mutate()} disabled={remove.isPending}>Stop watching and delete</button>
        )}
      </div>
    </div>
  );
}

function AddWatch({ projectId, connections, onDone }: { projectId: string; connections: ObsConnection[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ connectionId: connections[0]?.id ?? '', title: '', query: '', unit: 'count', badDirection: 'up' as 'up' | 'down' | 'both', limit: '', when: 'below' as 'below' | 'above' });
  const save = useMutation({
    mutationFn: () =>
      post('/observability/watches', {
        projectId,
        connectionId: form.connectionId,
        title: form.title,
        query: form.query,
        unit: form.unit,
        badDirection: form.badDirection,
        limit: form.limit.trim() ? { value: Number(form.limit), when: form.when } : null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['watches', projectId] });
      onDone();
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Panel title="Watch a query" accent="bg-blue" className="p-4">
      <div className="grid gap-3 px-1 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={form.title} placeholder="Checkout queue depth" onChange={set('title')} /></Field>
        <Field label="Connection">
          <select className="input" value={form.connectionId} onChange={set('connectionId')}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.slug}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="PromQL" hint="Aggregate it (sum by …) so it returns a few series, not thousands. At most 50 are kept.">
            <textarea className="input min-h-[64px] font-mono text-[12px]" value={form.query} placeholder='sum by (queue) (rabbitmq_queue_messages_ready)' onChange={set('query')} />
          </Field>
        </div>
        <Field label="Unit">
          <select className="input" value={form.unit} onChange={set('unit')}>
            {['count', 'percent', 'bytes', 'seconds', 'per_second', 'ratio', 'days'].map((u) => <option key={u} value={u}>{u.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="A problem when it goes">
          <select className="input" value={form.badDirection} onChange={set('badDirection')}>
            <option value="up">up</option>
            <option value="down">down</option>
            <option value="both">either way</option>
          </select>
        </Field>
        <Field label="Runs out at (optional)" hint="Forecast when the value reaches this.">
          <div className="flex gap-2">
            <select className="input !w-auto" value={form.when} onChange={set('when')}>
              <option value="below">below</option>
              <option value="above">above</option>
            </select>
            <input className="input font-mono" inputMode="decimal" value={form.limit} placeholder="e.g. 0" onChange={set('limit')} />
          </div>
        </Field>
      </div>
      {save.isError && <p className="mt-3 px-1 text-sm text-red">{(save.error as Error).message}</p>}
      <div className="mt-4 flex gap-2 px-1">
        <button className="btn-primary" disabled={save.isPending || !form.title.trim() || !form.query.trim() || !form.connectionId} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : <Sparkles size={14} />} Start watching
        </button>
      </div>
    </Panel>
  );
}

