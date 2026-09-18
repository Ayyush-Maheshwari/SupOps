import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  AlertTriangle, ArrowLeft, Ban, Bot, Check, ChevronRight, CircleSlash,
  Radio, Server, ShieldAlert, Terminal, User, X,
} from 'lucide-react';
import { api, post } from '../lib/api';
import { useRunStream } from '../lib/useRunStream';
import { cleanTask, duration, timeAgo } from '../lib/format';
import { CommandBlock, Panel, RiskBadge, Spinner, StatusPill } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { RiskBar } from '../components/viz';
import { TIER_STYLE } from '../lib/format';
import { ReportActions } from '../components/ReportActions';
import type { RunDetail as RunDetailData, ToolCall } from '../lib/types';

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['run', id],
    queryFn: () => api<RunDetailData>(`/runs/${id}`),
    enabled: !!id,
  });

  const seedSeq = detail.data?.events.at(-1)?.seq ?? -1;
  const { events, connected } = useRunStream(id, seedSeq);

  // Any live event means the durable state has already changed; refetch rather than
  // trying to mirror the engine's state machine in the browser.
  useEffect(() => {
    if (events.length) void qc.invalidateQueries({ queryKey: ['run', id] });
  }, [events.length, id, qc]);

  const run = detail.data?.run;
  const isLive = run && ['running', 'queued', 'awaiting_approval', 'suspended'].includes(run.status);

  // Follow the output while the run is live -- but only while the reader is already
  // at the bottom. Scrolling up to read something releases the auto-scroll (the
  // sentinel leaves the viewport, so `pinned` goes false) and scrolling back down
  // re-arms it, so a long investigation never yanks the page away mid-read.
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { pinned.current = !!e?.isIntersecting; }, {
      rootMargin: '0px 0px 120px 0px',
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  // Once a run has streamed live in this view, keep following it to the bottom --
  // including the concluding message and the status flip to succeeded, which arrive
  // together after `isLive` has already gone false. A run opened after it finished
  // (history) was never live here, so it opens at the top instead of jumping down.
  const wasLive = useRef(false);
  if (isLive) wasLive.current = true;
  const stepCount = detail.data?.steps.length ?? 0;
  useEffect(() => {
    if (wasLive.current && pinned.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [isLive, stepCount, events.length]);

  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['run', id] }), 3000);
    return () => clearInterval(t);
  }, [isLive, id, qc]);

  const [followUpText, setFollowUpText] = useState('');
  const followUp = useMutation({
    mutationFn: (text: string) => post(`/runs/${id}/message`, { message: text }),
    onSuccess: () => {
      setFollowUpText('');
      void qc.invalidateQueries({ queryKey: ['run', id] });
    },
  });

  if (detail.isLoading) {
    return <div className="grid h-full place-items-center text-muted"><Spinner /></div>;
  }
  if (!detail.data || !run) {
    return <div className="grid h-full place-items-center text-muted">Run not found</div>;
  }

  const callsById = new Map(detail.data.toolCalls.map((c) => [c.toolCallId, c]));

  // The header shows only the entry point(s) and machines actually acted on -- not
  // the whole frozen scope, which for a jump can be dozens of machines and reads as
  // noise the operator never chose.
  const snapshot = (run.targetsSnapshot as Array<{ slug: string; description?: string | null }>) ?? [];
  const acted = new Set(
    detail.data.toolCalls
      .map((c) => (c.argsJson as { target?: string }).target)
      .filter((t): t is string => !!t),
  );
  const primary = snapshot.filter((t) => !/^Behind\s/.test(t.description ?? '')).map((t) => t.slug);
  const shownTargets = [...new Set([...primary, ...acted])];

  return (
    <>
      <header className="border-b border-hairline px-6 py-5">
        <Link to="/runs" className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink">
          <ArrowLeft size={13} /> All runs
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-ink">{run.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
              <StatusPill status={run.status} />
              <span>{run.model}</span>
              {shownTargets.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Server size={12} />
                  {shownTargets.join(', ')}
                </span>
              )}
              <span>{run.iteration} steps</span>
              <span>{run.promptTokens + run.completionTokens} tokens</span>
              <span>{timeAgo(run.startedAt)}</span>
              {isLive && (
                <span className={clsx('inline-flex items-center gap-1', connected ? 'text-green' : 'text-muted')}>
                  <Radio size={12} /> {connected ? 'live' : 'reconnecting'}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            {/* Available on any run that has actually done something, not just on
                success -- a failed or rejected run is often the one worth writing up. */}
            {detail.data.toolCalls.length > 0 && <ReportActions runId={run.id} />}
            {isLive && (
              <button
                className="btn-ghost"
                onClick={async () => {
                  await post(`/runs/${run.id}/cancel`, {});
                  void qc.invalidateQueries({ queryKey: ['run', id] });
                }}
              >
                <CircleSlash size={15} /> Abort
              </button>
            )}
          </div>
        </div>
        {run.statusReason && (
          <p className="mt-3 rounded-inner border border-hairline bg-tile-2 px-3.5 py-2.5 text-sm text-muted">
            {run.statusReason}
          </p>
        )}

        {/* A compact summary only. The timeline below already lists every action with
            its tier, its command and its output -- drawing the same thing twice at the
            top is what made this header feel heavy. */}
        {detail.data.toolCalls.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-tile border border-hairline bg-tile px-4 py-3">
            <div className="min-w-[180px] flex-1">
              <RiskBar
                counts={detail.data.toolCalls.reduce<Record<string, number>>((acc, c) => {
                  const t = c.tier ?? 'read_only';
                  acc[t] = (acc[t] ?? 0) + 1;
                  return acc;
                }, {})}
              />
            </div>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
              <Fact k="Actions" v={String(detail.data.toolCalls.length)} />
              <Fact
                k="Gated"
                v={String(
                  detail.data.toolCalls.filter(
                    (c) => c.tier && c.tier !== 'read_only' && c.tier !== 'low',
                  ).length,
                )}
              />
              <Fact k="Steps" v={String(run.iteration)} />
              <Fact k="Tokens" v={String(run.promptTokens + run.completionTokens)} />
            </dl>
          </div>
        )}
      </header>

      <div className="mx-auto max-w-4xl space-y-3 p-6">
        {detail.data.steps.map((step) => {
          const m = step.messageJson;

          if (m.role === 'system') return <SystemStep key={step.id} content={m.content ?? ''} />;
          if (m.role === 'tool') return null; // rendered inside its tool-call card

          if (m.role === 'user') {
            return (
              <Bubble key={step.id} icon={<User size={15} />} tint="text-cyan" label="Task">
                <p className="whitespace-pre-wrap break-words text-sm text-ink">{cleanTask(m.content ?? '')}</p>
              </Bubble>
            );
          }

          return (
            <div key={step.id} className="space-y-3">
              {m.content && (
                <Bubble icon={<Bot size={15} />} tint="text-violet" label="Agent">
                  <Markdown>{m.content}</Markdown>
                </Bubble>
              )}
              {m.tool_calls?.map((tc) => {
                const call = callsById.get(tc.id);
                return call ? <ToolCallCard key={tc.id} call={call} /> : null;
              })}
            </div>
          );
        })}

        {isLive && (
          <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted">
            <Spinner className="text-blue-text" />
            {run.status === 'awaiting_approval' ? 'Waiting for a decision…' : 'Working…'}
          </div>
        )}

        {/* Keep the conversation going after the agent's final answer. The whole
            transcript replays into the next turn, so a follow-up continues this
            investigation rather than starting a fresh one. */}
        {(run.status === 'succeeded' || run.status === 'awaiting_input') && (
          <div className="tile p-3">
            <div className="flex gap-2">
              <textarea
                className="input max-h-40 min-h-[44px] resize-none py-2.5"
                rows={1}
                placeholder="Ask a follow-up, or tell it what to do next…"
                value={followUpText}
                onChange={(e) => setFollowUpText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (followUpText.trim() && !followUp.isPending) followUp.mutate(followUpText.trim());
                  }
                }}
              />
              <button
                className="btn-primary shrink-0 self-end"
                disabled={!followUpText.trim() || followUp.isPending}
                onClick={() => followUp.mutate(followUpText.trim())}
              >
                {followUp.isPending ? <Spinner /> : <ChevronRight size={15} />}
              </button>
            </div>
            {followUp.error && (
              <p className="mt-1.5 px-1 text-[11px] text-red">
                {followUp.error instanceof Error ? followUp.error.message : 'Could not send that'}
              </p>
            )}
          </div>
        )}

        <div ref={bottomRef} aria-hidden className="h-px" />
      </div>
    </>
  );
}

function Bubble({
  icon, tint, label, children,
}: { icon: React.ReactNode; tint: string; label: string; children: React.ReactNode }) {
  return (
    <div className="tile min-w-0 overflow-hidden p-4">
      <div className={clsx('mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide', tint)}>
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

function SystemStep({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tile">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted hover:text-ink"
      >
        <ChevronRight size={13} className={clsx('transition-transform', open && 'rotate-90')} />
        System prompt
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words border-t border-hairline px-4 py-3 font-mono text-[11px] leading-relaxed text-muted">
          {content}
        </pre>
      )}
    </div>
  );
}

/**
 * One action, with everything a human needs to judge it: the exact command, why the
 * agent wants to run it, what it expects to happen, and which rules produced the
 * risk tier. The approve/reject controls are here rather than on a separate screen
 * so the decision is made in context.
 */
function ToolCallCard({ call }: { call: ToolCall }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      post(`/runs/tool-calls/${call.id}/decision`, { decision, comment: comment || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['run', call.runId] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const waiting = call.state === 'awaiting_approval';
  const blocked = call.state === 'blocked';
  const denied = call.state === 'denied';
  const failed = call.isError && !blocked && !denied;

  const args = call.argsJson as { intent?: string; expected_effect?: string; target?: string };

  return (
    <div
      className={clsx(
        'tile relative overflow-hidden',
        waiting && 'border-amber/50 ring-1 ring-amber/20',
        blocked && 'border-red/50',
      )}
    >
      {/* Tier as a rail: readable down a long transcript without reading labels. */}
      <span className={clsx('rail', call.tier ? TIER_STYLE[call.tier].bg : 'bg-muted')} aria-hidden />
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5 pl-5">
        <Terminal size={14} className="shrink-0 text-muted" />
        <span className="font-mono text-xs text-muted">{call.toolKey}</span>
        {args.target && (
          <span className="rounded bg-tile-2 px-1.5 py-0.5 font-mono text-[11px] text-cyan">
            {args.target}
          </span>
        )}
        <div className="flex-1" />
        <RiskBadge tier={call.tier} />
        <StateChip call={call} />
      </div>

      <div className="space-y-3 p-4">
        <CommandBlock>{call.renderedCommand ?? JSON.stringify(call.argsJson)}</CommandBlock>

        {(args.intent || args.expected_effect) && (
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            {args.intent && (
              <div>
                <dt className="mb-0.5 font-medium uppercase tracking-wide text-muted">Why</dt>
                <dd className="text-ink">{args.intent}</dd>
              </div>
            )}
            {args.expected_effect && (
              <div>
                <dt className="mb-0.5 font-medium uppercase tracking-wide text-muted">Expected effect</dt>
                <dd className="text-ink">{args.expected_effect}</dd>
              </div>
            )}
          </dl>
        )}

        {/* The risk explanation is the difference between a decision and a rubber stamp. */}
        {call.riskJson && call.tier !== 'read_only' && (
          <div className="rounded-lg border border-hairline bg-tile-2 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
              <ShieldAlert size={13} /> Why this is {call.tier}
            </div>
            <ul className="space-y-1 text-xs text-muted">
              {call.riskJson.contributions
                .filter((c) => c.tier !== 'read_only')
                .map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted/50">·</span>
                    <span>
                      {c.reason}
                      {c.ruleId && <span className="ml-1.5 font-mono text-[10px] text-muted/60">{c.ruleId}</span>}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {waiting && (
          <div className="space-y-2 rounded-lg border border-amber/30 bg-amber/5 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber">
              <AlertTriangle size={13} /> This action needs your approval before it runs
            </div>
            <input
              className="input"
              placeholder="Optional note — the agent reads this if you reject"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="btn-primary" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
                <Check size={15} /> Approve &amp; run
              </button>
              <button className="btn-danger" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
                <X size={15} /> Reject
              </button>
            </div>
          </div>
        )}

        {call.decidedByName && (
          <p className="text-xs text-muted">
            {denied ? 'Rejected' : 'Approved'} by{' '}
            <span className="font-medium text-ink">{call.decidedByName}</span>
            {call.decidedAt ? ` · ${timeAgo(call.decidedAt)}` : ''}
          </p>
        )}
        {call.decisionComment && (
          <p className="text-xs text-muted">Reviewer note: “{call.decisionComment}”</p>
        )}

        {call.resultJson && (
          <CommandBlock
            className={clsx(
              'max-h-80 overflow-y-auto',
              (failed || blocked || denied) && 'border-red/30 text-red-200',
            )}
          >
            {call.resultJson.text}
          </CommandBlock>
        )}
      </div>
    </div>
  );
}

function StateChip({ call }: { call: ToolCall }) {
  const map: Partial<Record<ToolCall['state'], { label: string; className: string; icon: React.ReactNode }>> = {
    awaiting_approval: { label: 'needs approval', className: 'text-amber', icon: <AlertTriangle size={12} /> },
    executing: { label: 'running', className: 'text-blue-text', icon: <Spinner className="!h-3 !w-3" /> },
    succeeded: { label: 'done', className: 'text-green', icon: <Check size={12} /> },
    failed: { label: 'failed', className: 'text-red', icon: <X size={12} /> },
    blocked: { label: 'blocked', className: 'text-red', icon: <Ban size={12} /> },
    denied: { label: 'rejected', className: 'text-red', icon: <X size={12} /> },
    unknown_outcome: { label: 'outcome unknown', className: 'text-amber', icon: <AlertTriangle size={12} /> },
  };
  const s = map[call.state];
  if (!s) return <span className="text-[11px] text-muted">{call.state}</span>;
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[11px] font-medium', s.className)}>
      {s.icon} {s.label}
    </span>
  );
}

const Fact = ({ k, v }: { k: string; v: string }) => (
  <div>
    <dt className="text-muted">{k}</dt>
    <dd className="tabular mt-0.5 font-medium text-ink">{v}</dd>
  </div>
);
