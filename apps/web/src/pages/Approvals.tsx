import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ShieldCheck, X } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { CommandBlock, Empty, Panel, RiskBadge } from '../components/ui';
import type { ApprovalHistoryEntry, PendingApproval } from '../lib/types';

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

        {/* Decided history: who approved or rejected what, so an admin can see it at a glance. */}
        {history.data && history.data.length > 0 && (
          <Panel title="Recently decided" accent="bg-muted">
            <ul className="divide-y divide-hairline">
              {history.data.map((h) => (
                <li key={h.id} className="flex items-start gap-3 px-5 py-3">
                  <span
                    className={clsx(
                      'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full',
                      h.verdict === 'approved' ? 'bg-green/15 text-green' : 'bg-red/15 text-red',
                    )}
                    aria-hidden
                  >
                    {h.verdict === 'approved' ? <Check size={12} /> : <X size={12} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <RiskBadge tier={h.tier} />
                      <span className="truncate font-mono text-xs text-ink">{h.renderedCommand ?? h.toolKey}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      <span>
                        {h.verdict} by <span className="font-medium text-ink">{h.decidedByName ?? 'unknown'}</span>
                      </span>
                      {h.decidedAt && <><span aria-hidden>·</span><span>{timeAgo(h.decidedAt)}</span></>}
                      <span aria-hidden>·</span>
                      <Link to={`/runs/${h.runId}`} className="truncate text-blue-text hover:underline">{h.runTitle}</Link>
                    </div>
                    {h.decisionComment && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-muted">“{h.decisionComment}”</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}
