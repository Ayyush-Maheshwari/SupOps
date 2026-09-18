import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bell, ExternalLink, Search, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { SEVERITY_STYLE, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, Panel, Spinner } from '../components/ui';
import type { Alert, AlertList, Run } from '../lib/types';

export function Alerts() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [channel, setChannel] = useState<string | null>(null);

  const q = new URLSearchParams({ projectId: projectId ?? '', status: 'new' });
  if (channel) q.set('channel', channel);

  const list = useQuery({
    queryKey: ['alerts', projectId, channel],
    queryFn: () => api<AlertList>(`/alerts?${q.toString()}`),
    enabled: !!projectId,
    refetchInterval: 5000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['alerts', projectId] });
    void qc.invalidateQueries({ queryKey: ['alertCount', projectId] });
  };

  const investigate = useMutation({
    mutationFn: (id: string) => post<{ run: Run }>(`/alerts/${id}/investigate`, {}),
    onSuccess: ({ run }) => {
      invalidate();
      navigate(`/runs/${run.id}`);
    },
  });
  const ignore = useMutation({
    mutationFn: (id: string) => post(`/alerts/${id}/ignore`, {}),
    onSuccess: invalidate,
  });

  const channels = list.data?.channels ?? [];

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Live alerts picked up from Slack. Start a triage run or wave one off — resolved and ignored alerts clear themselves out."
      />

      <div className="space-y-4 p-6">
        {channels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Channel</span>
            <button
              onClick={() => setChannel(null)}
              className={clsx(
                'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                !channel ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink',
              )}
            >
              All
            </button>
            {channels.map((c) => (
              <button
                key={c.channelId}
                onClick={() => setChannel(channel === c.channelId ? null : c.channelId)}
                className={clsx(
                  'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
                  channel === c.channelId
                    ? 'border-blue/50 bg-blue/15 text-blue-text'
                    : 'border-edge bg-tile-2 text-muted hover:text-ink',
                )}
              >
                {c.channelName ?? c.channelId}
              </button>
            ))}
          </div>
        )}

        <Panel>
          {list.isLoading ? (
            <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
          ) : list.data?.alerts.length ? (
            <ul className="divide-y divide-hairline">
              {list.data.alerts.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  busy={investigate.isPending && investigate.variables === a.id}
                  onInvestigate={() => investigate.mutate(a.id)}
                  onIgnore={() => ignore.mutate(a.id)}
                />
              ))}
            </ul>
          ) : (
            <Empty
              icon={<Bell size={26} />}
              title="No active alerts"
              hint="Nothing needs a decision right now. New alerts appear here as they fire; investigated ones move to Runs, and resolved or ignored ones clear out."
            />
          )}
        </Panel>

        {investigate.error && (
          <p className="text-sm text-red">
            {investigate.error instanceof Error ? investigate.error.message : 'Could not start the investigation'}
          </p>
        )}
      </div>
    </>
  );
}

function AlertRow({
  alert, busy, onInvestigate, onIgnore,
}: {
  alert: Alert;
  busy: boolean;
  onInvestigate: () => void;
  onIgnore: () => void;
}) {
  const sev = SEVERITY_STYLE[alert.severity] ?? SEVERITY_STYLE.unknown!;

  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', sev.dot)} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('chip border', sev.chip)}>{sev.label}</span>
          <span className="truncate text-[13px] font-medium text-ink">{alert.title}</span>
          {alert.count > 1 && (
            <span className="tabular rounded border border-edge px-1.5 py-px text-[10px] text-muted">×{alert.count}</span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {alert.channelName && <span className="font-mono text-cyan">{alert.channelName}</span>}
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">{timeAgo(alert.lastSeenAt)}</span>
          {alert.slackPermalink && (
            <a
              href={alert.slackPermalink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted hover:text-ink"
            >
              <ExternalLink size={11} /> Slack
            </a>
          )}
        </div>

        {alert.summary && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{alert.summary}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button className="btn-primary !min-h-[34px] !text-xs" disabled={busy} onClick={onInvestigate}>
          {busy ? <Spinner /> : <Search size={13} />} Investigate
        </button>
        <button className="btn-ghost !min-h-[34px] !text-xs" onClick={onIgnore} title="Ignore this alert">
          <X size={13} /> Ignore
        </button>
      </div>
    </li>
  );
}
