import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ChevronDown, Pencil, Plus, Search, X } from 'lucide-react';
import { formatValue } from '@supops/shared';
import { api, patch, post } from '../lib/api';
import { Empty, Panel, Segmented, Spinner, Switch } from './ui';
import { LineChart, seriesColor } from './viz';
import type { AtRiskItem, ObsConnection, SeriesChartData, Watch, WatchItem } from '../lib/types';

/**
 * Signals: under each headline (Resources, Kubernetes...), everything SupOps watches
 * there -- every series of every signal, worst first -- with graphs of the two
 * nearest to trouble beside it. Clicking anything in the list puts it in the graph.
 */

const GROUPS: Array<{ key: Watch['group']; label: string }> = [
  // Your own signals first: they are what you chose to watch.
  { key: 'custom', label: 'Custom' },
  { key: 'resources', label: 'Resources' },
  { key: 'kubernetes', label: 'Kubernetes' },
  { key: 'traffic', label: 'Traffic' },
  { key: 'stack', label: 'Monitoring stack' },
];

/** What a headline's first graph shows: one item, one signal combined, or (null) the worst. */
type Focus = { kind: 'item'; id: string } | { kind: 'signal'; watchId: string } | null;

/** One thing being watched: a series of a signal. */
interface Item extends WatchItem {
  watch: Watch;
  id: string;
}

const itemId = (watchId: string, key: string) => `${watchId}|${key}`;

/** The colour of how close to trouble a score is. */
const tone = (score: number) => (score >= 85 ? 'text-red' : score >= 60 ? 'text-amber' : 'text-muted');
const dot = (score: number) => (score >= 85 ? 'bg-red' : score >= 60 ? 'bg-amber' : score >= 40 ? 'bg-cyan/70' : 'bg-green/60');

/** The machine an item is about: its matched target, else the first part of its name. */
const machineOf = (i: WatchItem) => i.target ?? (i.name.split(' ')[0] ?? i.name).replace(/:\d+$/, '');

export function SignalsView({
  projectId,
  connections,
  renderForm,
}: {
  projectId: string;
  connections: ObsConnection[];
  /** The create/edit form for a signal (shared with the page). */
  renderForm: (props: { existing?: Watch; onDone: (msg?: string) => void }) => React.ReactNode;
}) {
  const list = useQuery({
    queryKey: ['watches', projectId],
    queryFn: () => api<Watch[]>(`/observability/watches?projectId=${projectId}`),
    refetchInterval: 60_000,
  });
  const atRisk = useQuery({
    queryKey: ['atRisk', projectId],
    queryFn: () => api<AtRiskItem[]>(`/observability/at-risk?projectId=${projectId}&limit=5`),
    refetchInterval: 60_000,
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Watch | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Per headline: what its first graph is focused on. */
  const [focus, setFocus] = useState<Record<string, Focus>>({});
  const metricConns = connections.filter((c) => c.kind === 'prometheus' || c.kind === 'grafana');

  const groups = useMemo(() => {
    const ws = list.data ?? [];
    return GROUPS.map((g) => ({ ...g, watches: ws.filter((w) => w.group === g.key) })).filter((g) => g.watches.length);
  }, [list.data]);

  if (list.isLoading) return <div className="grid place-items-center py-10"><Spinner /></div>;
  if (!list.data?.length) {
    return (
      <Panel>
        <Empty
          title={metricConns.length ? 'Discovering signals…' : 'No metrics connection'}
          hint={metricConns.length ? 'SupOps looks for node_exporter, Kubernetes and monitoring-stack metrics, then checks every series every few minutes. Refresh the source on the Overview to do it now.' : 'Add a Prometheus or Grafana connection to watch signals.'}
        />
      </Panel>
    );
  }

  const pick = (group: Watch['group'], id: string) => {
    setFocus((p) => ({ ...p, [group]: { kind: 'item', id } }));
    document.getElementById(`signals-${group}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="space-y-4">
      {/* The worst things right now, across every headline. */}
      {!!atRisk.data?.length && (
        <div className="tile flex flex-wrap items-center gap-2 px-4 py-3">
          <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Most at risk</span>
          {atRisk.data.map((a) => (
            <button
              key={itemId(a.watchId, a.key)}
              onClick={() => pick(a.group, itemId(a.watchId, a.key))}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-hairline bg-tile-2/60 px-3 py-1.5 text-left text-xs transition-colors hover:border-edge"
            >
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', dot(a.score))} />
              <span className="truncate text-ink">{a.title} · {a.name}</span>
              <span className={clsx('shrink-0', tone(a.score))}>{a.reasons[0] ?? formatValue(a.value, a.unit)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {metricConns.length > 0 && (
          <button className="btn-ghost !min-h-[34px] text-xs" onClick={() => setAdding((v) => !v)}>
            {adding ? <X size={13} /> : <Plus size={13} />} {adding ? 'Cancel' : 'Watch a query'}
          </button>
        )}
      </div>
      {adding && renderForm({ onDone: () => setAdding(false) })}
      {note && <p className={clsx('text-xs', note.includes('failed') ? 'text-red' : 'text-green')}>{note}</p>}

      {groups.map((g) => (
        <GroupSection
          key={g.key}
          id={`signals-${g.key}`}
          label={g.label}
          watches={g.watches}
          focus={focus[g.key] ?? null}
          onFocus={(f) => setFocus((p) => ({ ...p, [g.key]: f }))}
          onEdit={(w) => { setEditing(w); setNote(null); }}
        />
      ))}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-6" onClick={() => setEditing(null)}>
          <div className="tile max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-b-none p-5 sm:rounded-b-tile" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Edit ${editing.title}`}>
            <div className="mb-4 flex items-center gap-3">
              <h2 className="flex-1 text-base font-semibold text-ink">Edit {editing.title}</h2>
              <button className="btn-ghost !min-h-[32px] !px-2" onClick={() => setEditing(null)} aria-label="Close"><X size={15} /></button>
            </div>
            {renderForm({ existing: editing, onDone: (msg) => { setEditing(null); if (msg) setNote(msg); } })}
            {editing.builtin && <ResetLink watch={editing} onDone={(msg) => { setEditing(null); setNote(msg); }} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ResetLink({ watch, onDone }: { watch: Watch; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: () => patch<{ error?: string }>(`/observability/watches/${watch.id}`, { reset: true }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['watches'] });
      onDone(r.error ? `Reset, but the query failed: ${r.error}` : 'Back to the built-in definition, and re-evaluated.');
    },
  });
  return (
    <button className="mt-3 text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline" disabled={reset.isPending} onClick={() => reset.mutate()}>
      Reset to SupOps' built-in definition
    </button>
  );
}

// ---- one headline ---------------------------------------------------------------------

function GroupSection({
  id, label, watches, focus, onFocus, onEdit,
}: {
  id: string;
  label: string;
  watches: Watch[];
  focus: Focus;
  onFocus: (f: Focus) => void;
  onEdit: (w: Watch) => void;
}) {
  const [by, setBy] = useState<'signal' | 'machine'>('signal');
  const [q, setQ] = useState('');
  const items: Item[] = useMemo(
    () => watches.flatMap((w) => w.series.map((s) => ({ ...s, watch: w, id: itemId(w.id, s.key) }))),
    [watches],
  );
  const ranked = useMemo(() => [...items].sort((a, b) => b.score - a.score), [items]);
  const needle = q.trim().toLowerCase();
  const visible = needle ? ranked.filter((i) => `${i.watch.title} ${i.name} ${i.target ?? ''}`.toLowerCase().includes(needle)) : ranked;

  // Click an item: its own graph. Click it again: its signal across every machine.
  const pickItem = (i: Item) => onFocus(focus?.kind === 'item' && focus.id === i.id ? { kind: 'signal', watchId: i.watch.id } : { kind: 'item', id: i.id });
  // Click a signal's name: it combined. Click again: back to the two worst.
  const pickSignal = (w: Watch) => onFocus(focus?.kind === 'signal' && focus.watchId === w.id ? null : { kind: 'signal', watchId: w.id });

  const focusedItem = focus?.kind === 'item' ? items.find((i) => i.id === focus.id) : undefined;
  const focusedWatch = focus?.kind === 'signal' ? watches.find((w) => w.id === focus.watchId) : undefined;
  const first = focusedItem ?? (focusedWatch ? undefined : ranked[0]);
  const second = ranked.find((i) => i.id !== first?.id && (!focusedWatch || i.watch.id !== focusedWatch.id)) ?? (focusedWatch ? undefined : ranked.find((i) => i.id !== first?.id));
  const selectedId = focusedItem?.id ?? null;

  return (
    <section id={id} className="scroll-mt-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</h3>
        <span className="text-[11px] text-dim">{items.length} watched · {watches.length} signal{watches.length === 1 ? '' : 's'}</span>
        {focus && (
          <button className="ml-auto text-[11px] text-blue-text hover:underline" onClick={() => onFocus(null)}>Back to the two worst</button>
        )}
      </div>
      <div className="tile grid gap-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Everything under this headline */}
        <div className="flex min-w-0 flex-col border-b border-hairline lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2.5">
            <div className="relative min-w-0 flex-1">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
              <input className="input !min-h-[32px] !py-1 !pl-8 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${items.length} items`} aria-label={`Search ${label}`} />
            </div>
            <Segmented label="Group by" value={by} onChange={setBy} options={[{ value: 'signal', label: 'Signal' }, { value: 'machine', label: 'Machine' }]} />
          </div>
          <div className="max-h-[440px] overflow-y-auto overscroll-contain">
            {by === 'signal'
              ? [...watches].sort((a, b) => (b.series[0]?.score ?? -1) - (a.series[0]?.score ?? -1)).map((w) => (
                  <SignalGroup
                    key={w.id}
                    watch={w}
                    items={visible.filter((i) => i.watch.id === w.id)}
                    selected={selectedId}
                    combined={focusedWatch?.id === w.id}
                    onPick={pickItem}
                    onSignal={() => pickSignal(w)}
                    onEdit={() => onEdit(w)}
                    searching={!!needle}
                  />
                ))
              : machineGroups(visible).map(([machine, rows]) => (
                  <ItemGroup key={machine} title={machine} items={rows} selected={selectedId} onPick={pickItem} label={(i) => i.watch.title} searching={!!needle} />
                ))}
            {!visible.length && <p className="px-4 py-6 text-center text-xs text-muted">Nothing matches.</p>}
          </div>
          <p className="border-t border-hairline px-3 py-2 text-[10.5px] text-dim">Click an item for its graph, again for its signal across all machines. Click a signal's name for all its machines.</p>
        </div>

        {/* The two nearest to trouble -- or what was chosen */}
        <div className="grid min-w-0 content-start gap-0 divide-y divide-hairline">
          {focusedWatch ? (
            <CombinedSlot key={`c-${focusedWatch.id}`} watch={focusedWatch} />
          ) : first ? (
            <ChartSlot key={first.id} item={first} picked={!!focusedItem} />
          ) : (
            <p className="p-6 text-sm text-muted">No data yet.</p>
          )}
          {second && <ChartSlot key={second.id} item={second} picked={false} />}
        </div>
      </div>
    </section>
  );
}

function machineGroups(items: Item[]): Array<[string, Item[]]> {
  const m = new Map<string, Item[]>();
  for (const i of items) m.set(machineOf(i), [...(m.get(machineOf(i)) ?? []), i]);
  // Machines ordered by their worst item.
  return [...m.entries()].sort((a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0));
}

const SHOWN = 6;

function SignalGroup({
  watch: w, items, selected, combined, onPick, onSignal, onEdit, searching,
}: {
  watch: Watch;
  items: Item[];
  selected: string | null;
  combined: boolean;
  onPick: (i: Item) => void;
  onSignal: () => void;
  onEdit: () => void;
  searching: boolean;
}) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch(`/observability/watches/${w.id}`, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['watches'] }),
  });
  if (searching && !items.length) return null;
  return (
    <ItemGroup
      title={w.title}
      onTitle={w.series.length > 1 ? onSignal : undefined}
      titleActive={combined}
      sub={`${w.connection ?? ''}${w.seriesCount ? ` · ${w.seriesCount}` : ''}`}
      error={w.enabled && w.lastError ? w.lastError : null}
      items={items}
      selected={selected}
      onPick={onPick}
      label={(i) => i.name}
      searching={searching}
      muted={!w.enabled}
      actions={
        <>
          <button className="rounded p-1 text-dim hover:text-ink" onClick={onEdit} aria-label={`Edit ${w.title}`} title="Edit"><Pencil size={12} /></button>
          <Switch label={`Watch ${w.title}`} checked={w.enabled} disabled={toggle.isPending} onChange={(v) => toggle.mutate(v)} />
        </>
      }
    />
  );
}

function ItemGroup({
  title, onTitle, titleActive, sub, error, items, selected, onPick, label, actions, searching, muted,
}: {
  title: string;
  /** Clicking the title shows this group combined. */
  onTitle?: () => void;
  titleActive?: boolean;
  sub?: string;
  error?: string | null;
  items: Item[];
  selected: string | null;
  onPick: (i: Item) => void;
  label: (i: Item) => string;
  actions?: React.ReactNode;
  searching: boolean;
  muted?: boolean;
}) {
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [searching]);
  const shown = all || searching ? items : items.slice(0, SHOWN);
  return (
    <div className={clsx('border-b border-hairline last:border-b-0', muted && 'opacity-60')}>
      <div className={clsx('sticky top-0 z-[1] flex items-center gap-2 px-3 py-2 backdrop-blur', titleActive ? 'bg-blue/15' : 'bg-tile/95')}>
        {onTitle ? (
          <button
            className={clsx('truncate text-left text-[12px] font-medium hover:underline', titleActive ? 'text-blue-text' : 'text-ink')}
            onClick={onTitle}
            aria-pressed={titleActive}
            title={titleActive ? 'Back to the two worst' : 'Show all machines together'}
          >
            {title}
          </button>
        ) : (
          <span className="truncate text-[12px] font-medium text-ink">{title}</span>
        )}
        {sub && <span className="truncate font-mono text-[10px] text-dim">{sub}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>
      </div>
      {error && <p className="truncate px-3 pb-1.5 text-[11px] text-red" title={error}>{error}</p>}
      <ul>
        {shown.map((i) => (
          <li key={i.id}>
            <button
              onClick={() => onPick(i)}
              aria-pressed={selected === i.id}
              className={clsx(
                'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-white/[0.04]',
                selected === i.id && 'bg-blue/10',
              )}
            >
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', dot(i.score))} />
              <span className="min-w-0 flex-1 truncate text-ink/90">{label(i)}</span>
              {i.reasons[0] && <span className={clsx('hidden shrink-0 truncate text-[11px] sm:inline sm:max-w-[45%]', tone(i.score))}>{i.reasons[0]}</span>}
              <span className="shrink-0 font-mono text-[11px] text-muted">{formatValue(i.value, i.watch.unit)}</span>
            </button>
          </li>
        ))}
      </ul>
      {!searching && items.length > SHOWN && (
        <button className="flex w-full items-center gap-1 px-3 pb-2 pt-1 text-[11px] text-blue-text hover:underline" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          <ChevronDown size={12} className={clsx('transition-transform', all && 'rotate-180')} /> {all ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

// ---- a graph -----------------------------------------------------------------------------

function ChartSlot({ item, picked }: { item: Item; picked: boolean }) {
  const [hours, setHours] = useState<'6' | '24' | '168'>('24');
  const navigate = useNavigate();
  const chart = useQuery({
    queryKey: ['seriesChart', item.watch.id, item.key, hours],
    queryFn: () => api<SeriesChartData>(`/observability/watches/${item.watch.id}/chart?key=${encodeURIComponent(item.key)}&hours=${hours}`),
    staleTime: 60_000,
  });
  const investigate = useMutation({
    mutationFn: () => post<{ runId: string }>(`/observability/watches/${item.watch.id}/investigate`, { key: item.key }),
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });
  const d = chart.data;
  return (
    <div className="min-w-0 p-4">
      <div className="mb-2 flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx('h-2 w-2 shrink-0 rounded-full', dot(item.score))} />
            <span className="truncate text-[13px] font-medium text-ink">{item.watch.title} · {item.name}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted">
            <span className="font-mono text-ink/80">{formatValue(item.value, item.watch.unit)}</span>
            {item.reasons.length > 0 && <span className={clsx('ml-2', tone(item.score))}>{item.reasons.join(' · ')}</span>}
            {!picked && <span className="ml-2 text-dim">{item.score >= 60 ? 'nearest to trouble' : 'top of the list'}</span>}
          </div>
        </div>
        <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }]} />
      </div>
      {chart.isLoading ? (
        <div className="grid h-[150px] place-items-center"><Spinner /></div>
      ) : chart.isError ? (
        <p className="grid h-[150px] place-items-center text-xs text-red">{(chart.error as Error).message}</p>
      ) : d ? (
        <LineChart
          height={150}
          unit={d.unit}
          limit={d.limit?.value ?? null}
          series={[{ key: item.key, name: item.name, points: d.points, band: d.band, forecast: d.forecast, flagged: item.score >= 60 }]}
        />
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10.5px] text-dim">{d?.band ? 'Shaded: its usual range over the last day.' : ''}{d?.forecast ? ' Dashed: where it is heading.' : ''}</span>
        <button className="btn-ghost !min-h-[30px] !px-2.5 text-[11px]" disabled={investigate.isPending} onClick={() => investigate.mutate()} title="A read-only investigation of this, starting from what the watcher sees">
          {investigate.isPending ? <Spinner className="!h-3 !w-3" /> : <Search size={12} />} Investigate
        </button>
      </div>
      {investigate.isError && <p className="mt-1 text-xs text-red">{(investigate.error as Error).message}</p>}
    </div>
  );
}

/** A signal across its machines: the worst ten together, with a legend. */
function CombinedSlot({ watch: w }: { watch: Watch }) {
  const [hours, setHours] = useState<'6' | '24' | '168'>('24');
  const chart = useQuery({
    queryKey: ['combinedChart', w.id, hours],
    queryFn: () => api<{ unit: string; limit: Watch['limit']; total: number; series: Array<{ key: string; name: string; points: Array<[number, number]> }> }>(`/observability/watches/${w.id}/combined?hours=${hours}`),
    staleTime: 60_000,
  });
  const d = chart.data;
  return (
    <div className="min-w-0 p-4">
      <div className="mb-2 flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{w.title} · all machines</div>
          <div className="mt-0.5 text-[11px] text-muted">
            {d ? (d.series.length < d.total ? `The ${d.series.length} closest to trouble, of ${d.total}` : `${d.series.length} machines`) : ' '}
          </div>
        </div>
        <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }]} />
      </div>
      {chart.isLoading ? (
        <div className="grid h-[200px] place-items-center"><Spinner /></div>
      ) : chart.isError ? (
        <p className="grid h-[200px] place-items-center text-xs text-red">{(chart.error as Error).message}</p>
      ) : d ? (
        <>
          <LineChart height={200} unit={d.unit} limit={d.limit?.value ?? null} series={d.series.map((x) => ({ key: x.key, name: x.name, points: x.points }))} />
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {d.series.map((x, i) => (
              <li key={x.key} className="flex max-w-full items-center gap-1.5 text-[11px] text-muted">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(i) }} />
                <span className="truncate">{x.name}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
