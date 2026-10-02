import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ShieldCheck, X } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { CommandBlock, Empty, Panel, RiskBadge } from '../components/ui';
import { Approvers } from '../components/Approvers';
import type { ApprovalHistoryEntry, PendingApproval } from '../lib/types';

/** Same kind colours as the Runs list chips. */
const KIND_CHIP: Record<ApprovalHistoryEntry['kind'], string> = {
  investigate: 'border-blue/40 bg-blue/10 text-blue-text',
  console: 'border-edge text-muted',
  health: 'border-green/40 bg-green/10 text-green',
  alert: 'border-amber/40 bg-amber/10 text-amber',
};

export function Approvals() {
  const projectId = useApp((s) => s.projectId);
  const approvals = useQuery({
    queryKey: ['approvals', projectId],
    queryFn: () => api<PendingApproval[]>(`/runs/approvals/pending?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: 4000,
  });
  const history = useQuery({
    queryKey: ['approvalHistory', projectId],
    queryFn: () => api<ApprovalHistoryEntry[]>(`/runs/approvals/history?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: 8000,
  });

  return (
    <>
      <PageHeader title="Approvals" subtitle="An agent wanted to do something risky and stopped to ask. Your call." />
      <div className="space-y-3 p-6">
        {approvals.data?.length ? (
          approvals.data.map(({ toolCall, run }) => (
            <Panel key={toolCall.id} className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <RiskBadge tier={toolCall.tier} />
                <span className="font-mono text-xs text-muted">{toolCall.toolKey}</span>
                <div className="flex-1" />
                <span className="text-xs text-muted">{run && timeAgo(run.startedAt)}</span>
              </div>
              <CommandBlock className="mb-3">{toolCall.renderedCommand}</CommandBlock>
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-xs text-muted">{run?.title}</p>
                {/* Decisions are made on the run page, in the context that justifies them. */}
                <Link to={`/runs/${toolCall.runId}`} className="btn-primary shrink-0">
                  Review in context
                </Link>
              </div>
            </Panel>
          ))
        ) : (
          <Panel>
            <Empty
              icon={<ShieldCheck size={28} />}
              title="Nothing waiting"
              hint="When an agent proposes something riskier than your policy allows it to run on its own, it will appear here."
            />
          </Panel>
        )}

        {/* Decided history, one row per run: which investigation / console / health
            check it was and who approved or rejected its steps. Per-step detail is on
            the run page. */}
        {history.data && history.data.length > 0 && (
          <Panel title="Recently decided" accent="bg-muted">
            <ul className="divide-y divide-hairline">
              {history.data.map((h) => (
                <li key={h.runId}>
                  <Link to={`/runs/${h.runId}`} className="flex items-start gap-3 px-5 py-3 hover:bg-tile-2">
                    <span
                      className={clsx(
                        'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full',
                        h.denied === 0 ? 'bg-green/15 text-green' : h.approved === 0 ? 'bg-red/15 text-red' : 'bg-amber/15 text-amber',
                      )}
                      aria-hidden
                    >
                      {h.denied === 0 ? <Check size={12} /> : <X size={12} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={clsx('shrink-0 rounded border px-1.5 py-px text-[10px] uppercase tracking-wider', KIND_CHIP[h.kind])}>
                          {h.kind}
                        </span>
                        <span className="truncate text-[13px] text-ink">{h.runTitle}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                        <Approvers approvals={h} />
                        <span aria-hidden>·</span>
                        <span className="tabular whitespace-nowrap">
                          {h.approved} approved{h.denied ? `, ${h.denied} rejected` : ''}
                        </span>
                        {h.startedByName && <><span aria-hidden>·</span><span className="whitespace-nowrap">started by {h.startedByName}</span></>}
                        {h.lastDecidedAt && <><span aria-hidden>·</span><span className="whitespace-nowrap">{timeAgo(h.lastDecidedAt)}</span></>}
                      </div>
                      {h.lastComment && (
                        <p className="mt-1 line-clamp-2 text-[11px] text-muted">“{h.lastComment}”</p>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}
