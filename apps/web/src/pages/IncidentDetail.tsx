import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, ChevronDown, ExternalLink, GitMerge, Play, RefreshCw, Scissors, ShieldCheck } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { Empty, Panel, Spinner, StatusPill } from '../components/ui';
import type { Evidence, IncidentDetail as Detail } from '../lib/types';

const SEV_CHIP: Record<string, string> = {
  critical: 'border-red/40 bg-red/10 text-red',
  warning: 'border-amber/40 bg-amber/10 text-amber',
  info: 'border-cyan/40 bg-cyan/10 text-cyan',
  unknown: 'border-edge bg-tile-2 text-muted',
};
const CONFIDENCE: Record<string, string> = {
  high: 'text-green',
  medium: 'text-amber',
  low: 'text-muted',
  inconclusive: 'text-muted',
};
const EV_DOT: Record<Evidence['status'], string> = {
  interesting: 'bg-amber',
  normal: 'bg-green/70',
  error: 'bg-red',
  unavailable: 'bg-dim',
};

export function IncidentDetail() {
  const { id } = useParams();
  const projectId = useApp((s) => s.projectId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const d = useQuery({
    queryKey: ['incident', id],
    queryFn: () => api<Detail>(`/observability/incidents/${id}`),
    refetchInterval: (q) => (q.state.data?.incident.triageState === 'running' || q.state.data?.incident.triageState === 'evidence' ? 4000 : 15_000),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['incident', id] });
    void qc.invalidateQueries({ queryKey: ['obs', projectId] });
    void qc.invalidateQueries({ queryKey: ['incidents', projectId] });
  };
  const investigate = useMutation({
    mutationFn: () => post<{ runId: string }>(`/observability/incidents/${id}/investigate`, {}),
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });
  const recheck = useMutation({ mutationFn: () => post(`/observability/incidents/${id}/evidence`, {}), onSuccess: invalidate });
  const resolve = useMutation({ mutationFn: () => post(`/observability/incidents/${id}/resolve`, {}), onSuccess: invalidate });
  const merge = useMutation({ mutationFn: (into: string) => post(`/observability/incidents/${id}/merge`, { into }), onSuccess: () => navigate('/observability?tab=incidents') });
  const [splitting, setSplitting] = useState<Set<string> | null>(null);
  const split = useMutation({
    mutationFn: () => post<{ id: string }>(`/observability/incidents/${id}/split`, { alertIds: [...(splitting ?? [])] }),
    onSuccess: () => {
      setSplitting(null);
      invalidate();
    },
  });

  if (d.isLoading) return <div className="grid place-items-center py-20"><Spinner /></div>;
  if (!d.data) return <Empty title="Incident not found" hint="It may have been cleaned up after 15 days." action={<Link className="btn-ghost" to="/observability">Back</Link>} />;
  const { incident: inc, alerts, evidence, run, fixRun, timeline, mergeCandidates } = d.data;
  const cited = evidence.filter((e) => e.ref !== '-');
  const missing = evidence.filter((e) => e.ref === '-');
  const busy = inc.triageState === 'evidence' || inc.triageState === 'running';
  const error = [investigate, recheck, resolve, merge, split].find((m) => m.isError)?.error as Error | undefined;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 pb-10 pt-5 sm:px-6">
      <Link to="/observability" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"><ArrowLeft size={13} /> Observability</Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('chip uppercase', SEV_CHIP[inc.severity])}>{inc.severity}</span>
          <span className={clsx('text-xs', inc.status === 'open' ? 'text-amber' : 'text-green')}>{inc.status === 'open' ? 'Open' : 'Resolved'}</span>
          {inc.origin === 'prediction' && <span className="text-xs text-amber">· predicted, nothing has failed yet</span>}
          <span className="text-xs text-muted">· opened {timeAgo(inc.openedAt)}</span>
        </div>
        <h1 className="text-[22px] font-semibold leading-snug tracking-[-0.01em] text-ink">{inc.title}</h1>
        {(inc.targets.length > 0 || inc.groupReason) && (
          <p className="text-xs text-muted">
            {inc.targets.length > 0 && <>On <span className="font-mono text-ink/80">{inc.targets.join(', ')}</span>. </>}
            {inc.groupReason && <>Grouped because {inc.groupReason}.</>}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {busy && run ? (
            <Link to={`/runs/${run.id}`} className="btn-primary !min-h-[36px]"><Play size={14} /> Watch the diagnosis</Link>
          ) : inc.status === 'open' || !fixRun ? (
            <button className="btn-primary !min-h-[36px]" disabled={investigate.isPending || busy} onClick={() => investigate.mutate()} title="Starts from the diagnosis and proposes the fix; every change waits for your approval">
              {investigate.isPending ? <Spinner /> : <ShieldCheck size={14} />} Investigate
            </button>
          ) : null}
          {fixRun && (
            <Link to={`/runs/${fixRun.id}`} className="btn-ghost !min-h-[36px]"><Play size={14} /> Open fix run</Link>
          )}
          {run && !busy && (
            <Link to={`/runs/${run.id}`} className="btn-ghost !min-h-[36px]"><Play size={14} /> Diagnosis report</Link>
          )}
          <button className="btn-ghost !min-h-[36px]" disabled={recheck.isPending || busy} onClick={() => recheck.mutate()}>
            {recheck.isPending ? <Spinner /> : <RefreshCw size={14} />} Re-run checks
          </button>
          {inc.status === 'open' && (
            <button className="btn-ghost !min-h-[36px]" disabled={resolve.isPending} onClick={() => resolve.mutate()}>Mark resolved</button>
          )}
        </div>
        {!busy && inc.status === 'open' && <p className="text-[11px] text-muted">Investigate builds on the read-only diagnosis below and proposes the fix. Nothing changes without your approval.</p>}
        {error && <p className="text-sm text-red">{error.message}</p>}
      </header>

      {/* The verdict */}
      <Panel title="Diagnosis" accent="bg-blue">
        <div className="px-5 pb-5">
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="!h-3.5 !w-3.5 text-blue" />
              {inc.triageState === 'evidence' ? 'Running the read-only checks…' : 'Diagnosing, read-only. Nothing is changed.'}
              {run && <Link className="text-blue-text hover:underline" to={`/runs/${run.id}`}>Watch</Link>}
            </p>
          ) : inc.rootCause ? (
            <>
              <p className="text-[15px] leading-relaxed text-ink">{inc.rootCause}</p>
              <p className="mt-1.5 text-xs text-muted">
                Confidence <span className={clsx('font-medium', CONFIDENCE[inc.confidence ?? 'low'])}>{inc.confidence ?? 'not stated'}</span>
                {run && <> · <Link className="text-blue-text hover:underline" to={`/runs/${run.id}`}>full report</Link></>}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">
              {inc.triageState === 'done' ? 'The diagnosis finished without naming a root cause.' : 'Not diagnosed yet. Investigate diagnoses it first.'}
            </p>
          )}
          {inc.triageNote && <p className="mt-3 rounded-inner border border-amber/30 bg-amber/[0.06] px-3 py-2 text-xs leading-relaxed text-amber">{inc.triageNote}</p>}
          {run && !busy && (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted"><StatusPill status={run.status} /> <span>started {timeAgo(run.startedAt)}</span></div>
          )}
        </div>
      </Panel>

      {/* Evidence */}
      <Panel title="Evidence" accent="bg-amber" action={<span className="text-[11px] text-muted">{cited.filter((e) => e.status === 'interesting').length} of {cited.length} notable</span>}>
        {cited.length ? (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {cited.map((e) => <EvidenceRow key={e.id} e={e} />)}
          </ul>
        ) : (
          <p className="px-5 pb-4 text-sm text-muted">{busy ? 'Gathering…' : 'No metrics or logs connection could be checked.'}</p>
        )}
        {missing.length > 0 && (
          <p className="border-t border-hairline px-5 py-2.5 text-[11px] text-muted">Not measured here: {[...new Set(missing.map((e) => e.title))].join(', ')}.</p>
        )}
      </Panel>

      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        {/* Alerts */}
        <Panel
          title={`Alerts (${alerts.length})`}
          accent="bg-red"
          action={
            alerts.length > 1 && inc.status === 'open' ? (
              splitting ? (
                <div className="flex gap-1.5">
                  <button className="btn-ghost !min-h-[28px] !px-2 text-[11px]" onClick={() => setSplitting(null)}>Cancel</button>
                  <button className="btn-primary !min-h-[28px] !px-2 text-[11px]" disabled={!splitting.size || splitting.size === alerts.length || split.isPending} onClick={() => split.mutate()}>Split {splitting.size || ''}</button>
                </div>
              ) : (
                <button className="btn-ghost !min-h-[28px] !px-2 text-[11px]" onClick={() => setSplitting(new Set())}><Scissors size={12} /> Split</button>
              )
            ) : undefined
          }
        >
          {alerts.length ? (
            <ul className="divide-y divide-hairline border-t border-hairline">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 px-5 py-2.5">
                  {splitting && (
                    <input type="checkbox" className="mt-1" checked={splitting.has(a.id)} aria-label={`Split out ${a.title}`}
                      onChange={(e) => {
                        const next = new Set(splitting);
                        if (e.target.checked) next.add(a.id);
                        else next.delete(a.id);
                        setSplitting(next);
                      }} />
                  )}
                  <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', a.status === 'resolved' ? 'bg-green' : a.severity === 'critical' ? 'bg-red' : 'bg-amber')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                      <span className="text-ink">{a.title}</span>
                      {a.labels?.instance && <span className="font-mono text-[11px] text-muted">{a.labels.instance}</span>}
                      {a.status === 'resolved' && <span className="text-[11px] text-green">resolved</span>}
                    </div>
                    {a.summary && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{a.summary}</p>}
                    <div className="mt-0.5 text-[10.5px] text-dim">
                      {a.source} · {timeAgo(a.startsAt ?? a.receivedAt)}
                      {a.slackPermalink && <> · <a className="inline-flex items-center gap-0.5 hover:text-ink" href={a.slackPermalink} target="_blank" rel="noreferrer">Slack <ExternalLink size={9} /></a></>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 pb-4 text-sm text-muted">{inc.origin === 'prediction' ? 'Raised by a forecast, before any alert fired.' : 'No alerts.'}</p>
          )}
          {mergeCandidates.length > 0 && inc.status === 'open' && (
            <div className="flex items-center gap-2 border-t border-hairline px-5 py-2.5">
              <GitMerge size={13} className="shrink-0 text-muted" />
              <select className="input !min-h-[30px] !py-1 text-xs" defaultValue="" onChange={(e) => e.target.value && merge.mutate(e.target.value)} aria-label="Merge into another incident">
                <option value="" disabled>Same problem as…</option>
                {mergeCandidates.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </div>
          )}
        </Panel>

        {/* Timeline */}
        <Panel title="Timeline" accent="bg-cyan">
          <ol className="relative space-y-3 border-t border-hairline px-5 pb-5 pt-4">
            {timeline.map((t, i) => (
              <li key={i} className="relative pl-4">
                <span className={clsx('absolute left-0 top-1.5 h-1.5 w-1.5 rounded-full', t.kind === 'alert' ? 'bg-red' : t.kind === 'resolved' || t.kind === 'closed' ? 'bg-green' : t.kind === 'change' || t.kind === 'deploy' ? 'bg-amber' : 'bg-blue')} />
                {i < timeline.length - 1 && <span className="absolute left-[2.5px] top-3.5 h-[calc(100%+4px)] w-px bg-hairline" />}
                <div className="text-[12.5px] leading-snug text-ink">{t.text}</div>
                <div className="font-mono text-[10.5px] text-dim">{new Date(t.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

function EvidenceRow({ e }: { e: Evidence }) {
  const [open, setOpen] = useState(e.status === 'interesting');
  const [head, ...rest] = e.summary.split('\n');
  return (
    <li>
      <button className="flex w-full items-start gap-3 px-5 py-2.5 text-left transition-colors hover:bg-white/[0.03]" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="mt-0.5 w-7 shrink-0 font-mono text-[11px] text-muted">{e.ref}</span>
        <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', EV_DOT[e.status])} aria-label={e.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={clsx('text-[13px]', e.status === 'interesting' ? 'font-medium text-ink' : 'text-ink/85')}>{e.title}</span>
            {e.connection && <span className="font-mono text-[10.5px] text-dim">{e.connection}</span>}
          </div>
          <div className={clsx('mt-0.5 text-xs', e.status === 'error' ? 'text-red' : 'text-muted', !open && 'truncate')}>{head}</div>
        </div>
        <ChevronDown size={13} className={clsx('mt-1 shrink-0 text-dim transition-transform', open && 'rotate-180')} />
      </button>
      {open && (rest.length > 0 || e.query) && (
        <div className="space-y-2 pb-3 pl-5 pr-5 sm:pl-[78px]">
          {rest.length > 0 && <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink/90">{rest.join('\n')}</pre>}
          {e.query && <pre className="whitespace-pre-wrap break-all rounded-inner border border-hairline bg-ground/60 px-2.5 py-1.5 font-mono text-[10.5px] text-muted">{e.query}</pre>}
        </div>
      )}
    </li>
  );
}
