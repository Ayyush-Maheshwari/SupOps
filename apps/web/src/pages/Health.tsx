import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, RadioTower, Search, Server, ShieldCheck, X, Zap } from 'lucide-react';
import { api, post, put } from '../lib/api';
import { useApp } from '../lib/store';
import { HEALTH_STYLE, SEVERITY_STYLE, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, EnvBadge, HealthBadge, Panel, Spinner } from '../components/ui';
import { topLevelTargets } from '../lib/types';
import type { HealthIssue, HealthOverview, HealthSchedule, HealthTargetMetric, Target } from '../lib/types';

/** The cadences the timer control offers, in minutes. */
const INTERVALS: Array<{ ms: number; label: string }> = [
  { ms: 15 * 60_000, label: '15m' },
  { ms: 30 * 60_000, label: '30m' },
  { ms: 60 * 60_000, label: '1h' },
  { ms: 180 * 60_000, label: '3h' },
  { ms: 360 * 60_000, label: '6h' },
  { ms: 720 * 60_000, label: '12h' },
  { ms: 1440 * 60_000, label: '24h' },
];

export function Health() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [scopeId, setScopeId] = useState<string>('');

  const overview = useQuery({
    queryKey: ['health', projectId],
    queryFn: () => api<HealthOverview>(`/health/overview?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: 5000,
  });

  const targets = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`),
    enabled: !!projectId,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['health', projectId] });
    void qc.invalidateQueries({ queryKey: ['healthCount', projectId] });
    void qc.invalidateQueries({ queryKey: ['targets', projectId] });
  };

  const scan = useMutation({
    mutationFn: (type: 'quick' | 'deep') =>
      post<{ runId?: string }>('/health/scan', {
        projectId,
        type,
        ...(scopeId ? { targetId: scopeId } : {}),
      }),
    onSuccess: (res) => {
      invalidate();
      // Both Quick and Deep are agent runs now -- jump to the run so it can be watched.
      if (res.runId) navigate(`/runs/${res.runId}`);
    },
  });

  const schedule = overview.data?.schedule;
  const saveSchedule = useMutation({
    mutationFn: (patch: Partial<Pick<HealthSchedule, 'enabled' | 'intervalMs' | 'scanType'>>) =>
      put<HealthSchedule>('/health/schedule', {
        enabled: patch.enabled ?? schedule?.enabled ?? false,
        intervalMs: patch.intervalMs ?? schedule?.intervalMs ?? 30 * 60_000,
        scanType: patch.scanType ?? schedule?.scanType ?? 'quick',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['health', projectId] }),
  });

  const investigate = useMutation({
    mutationFn: (id: string) => post<{ runId: string }>(`/health/issues/${id}/investigate`, {}),
    onSuccess: ({ runId }) => {
      invalidate();
      navigate(`/runs/${runId}`);
    },
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => post(`/health/issues/${id}/resolve`, {}),
    onSuccess: invalidate,
  });

  const tops = topLevelTargets(targets.data);
  const issues = overview.data?.issues ?? [];
  const latest = overview.data?.latest;
  const scanning = scan.isPending;
  const metricsById = new Map(
    (latest?.summaryJson?.targets ?? []).map((m) => [m.targetId, m]),
  );

  return (
    <>
      <PageHeader
        title="Health"
        subtitle="Sweep every machine for the essentials — reachability, disk, memory, load and failed services. Run it now or leave it on a timer."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-ghost !min-h-[38px]"
              disabled={scanning || !projectId}
              onClick={() => scan.mutate('quick')}
              title="A fast, read-only probe. No AI, no tokens."
            >
              {scanning && scan.variables === 'quick' ? <Spinner /> : <Zap size={15} />} Quick scan
            </button>
            <button
              className="!min-h-[38px] inline-flex items-center gap-2 rounded-inner border border-violet/40 bg-violet/15 px-3.5 text-sm font-medium text-violet transition-colors hover:bg-violet/25 disabled:opacity-50"
              disabled={scanning || !projectId}
              onClick={() => scan.mutate('deep')}
              title="A full AI investigation of each target. Opens a run."
            >
              {scanning && scan.variables === 'deep' ? <Spinner /> : <Search size={15} />} Deep scan
            </button>
          </div>
        }
      />

      <div className="space-y-4 p-6">
        {/* Timer control */}
        <Panel title="Automatic checks" accent="bg-cyan">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 pb-5 pt-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Every</span>
              <IntervalButton
                label="Off"
                active={!schedule?.enabled}
                onClick={() => saveSchedule.mutate({ enabled: false })}
              />
              {INTERVALS.map((iv) => (
                <IntervalButton
                  key={iv.ms}
                  label={iv.label}
                  active={!!schedule?.enabled && schedule.intervalMs === iv.ms}
                  onClick={() => saveSchedule.mutate({ enabled: true, intervalMs: iv.ms })}
                />
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">Using</span>
              {(['quick', 'deep'] as const).map((t) => (
                <IntervalButton
                  key={t}
                  label={t === 'quick' ? 'Quick' : 'Deep'}
                  active={(schedule?.scanType ?? 'quick') === t}
                  accent={t === 'deep' ? 'violet' : 'blue'}
                  onClick={() => saveSchedule.mutate({ scanType: t })}
                />
              ))}
            </div>

            <div className="ml-auto text-[11px] text-muted">
              {schedule?.enabled && schedule.nextCheckAt
                ? `Next check ${timeAgo(schedule.nextCheckAt).replace(' ago', ' from now').replace('just now', 'imminently')}`
                : 'Automatic checks are off'}
              {latest && <> · last scan {timeAgo(latest.startedAt)}</>}
            </div>
          </div>
        </Panel>

        {/* Latest scan summary */}
        {latest?.summaryJson && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Checked" value={latest.summaryJson.checked} tone="text-ink" />
            <Stat label="Healthy" value={latest.summaryJson.ok} tone="text-green" />
            <Stat label="Degraded" value={latest.summaryJson.degraded} tone="text-amber" />
            <Stat label="Unreachable" value={latest.summaryJson.unreachable} tone="text-red" />
          </div>
        )}

        {/* Open issues */}
        <Panel
          title="Open issues"
          accent="bg-amber"
          action={<span className="text-[11px] text-muted">{issues.length || 'none'}</span>}
        >
          {overview.isLoading ? (
            <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
          ) : issues.length ? (
            <ul className="divide-y divide-hairline">
              {issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  targetName={tops.find((t) => t.id === issue.targetId)?.name}
                  busy={investigate.isPending && investigate.variables === issue.id}
                  onInvestigate={() => investigate.mutate(issue.id)}
                  onDismiss={() => dismiss.mutate(issue.id)}
                />
              ))}
            </ul>
          ) : (
            <Empty
              icon={<ShieldCheck size={26} />}
              title="Nothing needs attention"
              hint="No open issues. Problems a scan finds show up here, each with a one-click deep investigation."
            />
          )}
        </Panel>

        {/* Per-target health -- click a card to scope the next scan to it. */}
        <Panel
          title="Targets"
          accent="bg-blue"
          action={
            <span className="text-[11px] text-muted">
              {scopeId
                ? <>Scanning <span className="text-blue-text">{tops.find((t) => t.id === scopeId)?.name}</span> · <button className="hover:text-ink" onClick={() => setScopeId('')}>scan all</button></>
                : 'Click a target to scope a scan'}
            </span>
          }
        >
          {tops.length ? (
            <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
              {tops.map((t) => {
                const h = HEALTH_STYLE[t.healthState] ?? HEALTH_STYLE.unknown!;
                const selected = scopeId === t.id;
                const cfg = t.config as { host?: string; user?: string };
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setScopeId(selected ? '' : t.id)}
                    aria-pressed={selected}
                    className="tile flex items-start gap-3 border border-hairline p-4 text-left"
                  >
                    <span className={clsx('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-inner', h.text)} style={{ background: `color-mix(in srgb, ${h.hex} 14%, transparent)` }}>
                      <Server size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{t.name}</span>
                        <EnvBadge env={t.env} />
                      </div>
                      {(cfg.host || cfg.user) && (
                        <div className="mt-1 truncate font-mono text-[11px] text-muted">
                          {cfg.user ? `${cfg.user}@` : ''}{cfg.host}
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-2 border-t border-hairline pt-2">
                        <HealthBadge state={t.healthState} />
                        <span className="text-[11px] text-dim">· checked {timeAgo(t.lastCheckedAt)}</span>
                      </div>
                      <TargetMetrics metric={metricsById.get(t.id)} />
                    </div>
                    {selected && <Check size={16} className="shrink-0 text-blue-text" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty
              icon={<RadioTower size={26} />}
              title="No targets yet"
              hint="Register a target to start checking its health."
            />
          )}
        </Panel>

        {scan.error && (
          <p className="text-sm text-red">
            {scan.error instanceof Error ? scan.error.message : 'Could not run the scan'}
          </p>
        )}
      </div>
    </>
  );
}

function IntervalButton({
  label, active, onClick, accent = 'blue',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  accent?: 'blue' | 'violet';
}) {
  const activeStyle =
    accent === 'violet' ? 'border-violet/50 bg-violet/15 text-violet' : 'border-blue/50 bg-blue/15 text-blue-text';
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-full border px-3 py-1 text-[11px] font-medium transition-colors',
        active ? activeStyle : 'border-edge bg-tile-2 text-muted hover:text-ink',
      )}
    >
      {label}
    </button>
  );
}

/** The at-a-glance numbers a Quick scan surfaced for one target. */
function TargetMetrics({ metric }: { metric?: HealthTargetMetric }) {
  if (!metric || metric.healthState === 'unreachable') return null;

  const chips: Array<{ label: string; value: string; warn?: boolean }> = [];
  if (metric.diskPct !== null) chips.push({ label: 'disk', value: `${metric.diskPct}%`, warn: metric.diskPct >= 90 });
  if (metric.memPct !== null) chips.push({ label: 'mem free', value: `${metric.memPct}%`, warn: metric.memPct < 8 });
  if (metric.load1 !== null && metric.cores) {
    chips.push({ label: 'cpu', value: `${metric.load1.toFixed(2)}/${metric.cores}`, warn: metric.load1 / metric.cores > 4 });
  }
  if (metric.failedUnits > 0) chips.push({ label: 'failed', value: String(metric.failedUnits), warn: true });
  if (metric.namespaces !== null) chips.push({ label: 'ns', value: String(metric.namespaces) });
  if (metric.pods !== null) {
    chips.push({
      label: 'pods',
      value: metric.badPods ? `${metric.pods} · ${metric.badPods} bad` : String(metric.pods),
      warn: !!metric.badPods,
    });
  }
  if (chips.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c.label}
          className={clsx(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
            c.warn ? 'border-amber/40 bg-amber/10 text-amber' : 'border-edge bg-tile-2 text-muted',
          )}
        >
          <span className="uppercase tracking-wide opacity-70">{c.label}</span>
          <span className="tabular font-semibold">{c.value}</span>
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="tile flex flex-col gap-1 p-4">
      <span className={clsx('tabular text-2xl font-semibold', tone)}>{value}</span>
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
    </div>
  );
}

function IssueRow({
  issue, targetName, busy, onInvestigate, onDismiss,
}: {
  issue: HealthIssue;
  targetName?: string;
  busy: boolean;
  onInvestigate: () => void;
  onDismiss: () => void;
}) {
  const sev = SEVERITY_STYLE[issue.severity] ?? SEVERITY_STYLE.unknown!;
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', sev.dot)} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('chip border', sev.chip)}>{sev.label}</span>
          <span className="truncate text-[13px] font-medium text-ink">{issue.title}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {targetName && <span className="font-mono text-cyan">{targetName}</span>}
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">seen {timeAgo(issue.lastSeenAt)}</span>
          {issue.state === 'investigating' && <span className="text-blue-text">· investigating</span>}
        </div>
        {issue.detail && issue.detail !== issue.title && (
          <p className="mt-1.5 line-clamp-2 break-words text-xs text-muted">{issue.detail}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button className="btn-primary !min-h-[34px] !text-xs" disabled={busy} onClick={onInvestigate}>
          {busy ? <Spinner /> : <Search size={13} />} Investigate
        </button>
        <button className="btn-ghost !min-h-[34px] !text-xs" onClick={onDismiss} title="Dismiss this issue">
          <X size={13} /> Dismiss
        </button>
      </div>
    </li>
  );
}
