import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bot, Check, RotateCcw, Send, Server, User, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { useRunStream } from '../lib/useRunStream';
import { cleanTask, OUTCOME_LABEL, TIER_STYLE, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { Terminal, type TerminalLine } from '../components/Terminal';
import { CommandBlock, Empty, RiskBadge, Spinner, StatusPill } from '../components/ui';
import type { Agent, Run, RunDetail, Target, ToolCall } from '../lib/types';

const SESSION_KEY = 'supops.consoleRun';
const BUSY = ['queued', 'running', 'awaiting_approval'];
/** A finished turn: the session is terminal but a follow-up revives it. */
const RESUMABLE = ['succeeded', 'awaiting_input'];
/** Over for good: the next message opens a fresh session instead of continuing. */
const ENDED = ['failed', 'cancelled', 'expired', 'halted'];

export function Console() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  });
  const [input, setInput] = useState('');
  /**
   * Targets are frozen into the run's snapshot when the session starts, which is
   * what makes the audit record mean anything -- so this only applies to the first
   * message, and the picker is replaced by a read-only scope line afterwards.
   */
  const [scope, setScope] = useState<string[]>([]);
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  const [error, setError] = useState<string | null>(null);

  /**
   * Live output, keyed by tool call. Kept in a ref rather than state: chunks arrive
   * many times a second and re-rendering the whole page per chunk would drop frames.
   * A counter nudges React once per batch instead.
   */
  const liveOutput = useRef(new Map<string, string>());
  const [, bump] = useState(0);

  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<Agent[]>(`/agents?projectId=${projectId}`),
    enabled: !!projectId,
  });
  const targets = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`),
    enabled: !!projectId,
  });

  // Machines reached via a jump are hidden from the picker (same as Investigate):
  // you pick the jump ("prod") and the session includes the machines behind it, so
  // the agent confirms which one to reach with confirm_target. Each VM is still its
  // own target for scope and audit.
  const allTargets = targets.data ?? [];
  const isVia = (t: Target) => !!(t.config as { via?: { alias?: string } }).via?.alias;
  const hostOf = (t: Target) => (t.config as { host?: string }).host ?? '';
  const childrenByHost = new Map<string, Target[]>();
  for (const t of allTargets) {
    if (isVia(t)) {
      const list = childrenByHost.get(hostOf(t)) ?? [];
      list.push(t);
      childrenByHost.set(hostOf(t), list);
    }
  }
  const primaries = allTargets.filter((t) => !isVia(t));
  const childrenOf = (t: Target) => childrenByHost.get(hostOf(t)) ?? [];

  const detail = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api<RunDetail>(`/runs/${runId}`),
    enabled: !!runId,
  });

  const run = detail.data?.run;
  const busy = !!run && BUSY.includes(run.status);
  const seedSeq = detail.data?.events.at(-1)?.seq ?? -1;

  const { events } = useRunStream(runId ?? undefined, seedSeq, (c) => {
    liveOutput.current.set(c.toolCallId, (liveOutput.current.get(c.toolCallId) ?? '') + c.chunk);
    bump((n) => n + 1);
  });

  // Any semantic event means the durable state moved; refetch rather than mirroring
  // the engine's state machine in the browser.
  useEffect(() => {
    if (events.length) void qc.invalidateQueries({ queryKey: ['run', runId] });
  }, [events.length, runId, qc]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['run', runId] }), 2500);
    return () => clearInterval(t);
  }, [busy, runId, qc]);

  useEffect(() => {
    try {
      if (runId) localStorage.setItem(SESSION_KEY, runId);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, [runId]);

  const consoleAgent = agents.data?.find((a) => a.slug === 'console') ?? agents.data?.[0];

  const send = useMutation({
    mutationFn: async (text: string) => {
      // Only a parked session can be continued. A session that failed or was closed
      // is over, so the next message quietly starts a fresh one rather than 409ing.
      if (runId && run?.interactive && RESUMABLE.includes(run.status)) {
        await post(`/runs/${runId}/message`, { message: text });
        return runId;
      }
      // Expand each selected jump to include the machines behind it, so the agent
      // can reach whichever node the request points to via confirm_target.
      const ids = new Set(scope);
      for (const id of scope) {
        const t = allTargets.find((x) => x.id === id);
        if (t) for (const c of childrenOf(t)) ids.add(c.id);
      }
      const created = await post<Run>('/runs', {
        projectId,
        agentId: consoleAgent!.id,
        task: text,
        interactive: true,
        ...(ids.size ? { targetIds: [...ids] } : {}),
      });
      return created.id;
    },
    onSuccess: (id) => {
      if (id !== runId) liveOutput.current.clear();
      setRunId(id);
      setInput('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['run', id] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not send that'),
  });

  // Completed output lives on the tool call; in-flight output comes off the socket.
  const terminalLines = useMemo<TerminalLine[]>(() => {
    const out: TerminalLine[] = [];
    for (const c of detail.data?.toolCalls ?? []) {
      if (c.toolKey === 'record_finding') continue;
      out.push({
        kind: 'command',
        text: c.renderedCommand ?? c.toolKey,
        target: typeof c.argsJson.target === 'string' ? c.argsJson.target : null,
      });
      const finished = c.resultJson?.text;
      const streaming = liveOutput.current.get(c.toolCallId);
      const body = finished ?? streaming;
      if (body) for (const line of body.split('\n')) out.push({ kind: 'output', text: line });
      else if (c.state === 'awaiting_approval') out.push({ kind: 'note', text: 'waiting for approval…' });
      else if (c.state === 'executing') out.push({ kind: 'note', text: 'running…' });
    }
    return out;
  }, [detail.data, liveOutput.current.size, events.length]);

  function newSession() {
    liveOutput.current.clear();
    setRunId(null);
    setInput('');
    setError(null);
    setScope([]);
  }

  const noAgent = agents.data && !consoleAgent;

  return (
    /* The page owns the viewport: each pane scrolls on its own, so a long command
       dump in the terminal never drags the chat composer off-screen. */
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader
        title="Console"
        subtitle="Ask a question or get something done — you'll see every command run live on the right"
        action={
          runId && (
            <button className="btn-ghost" onClick={newSession}>
              <RotateCcw size={15} /> New session
            </button>
          )
        }
      />

      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-6 lg:grid-cols-2 lg:grid-rows-1">
        {/* tabs on narrow screens; side by side from lg */}
        <div className="flex gap-2 lg:col-span-2 lg:hidden">
          {(['chat', 'terminal'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'flex-1 rounded-inner px-3 py-2 text-sm capitalize transition-colors',
                tab === t ? 'bg-blue text-white' : 'border border-edge bg-tile-2 text-muted',
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ---------------- chat ---------------- */}
        <section className={clsx('tile flex min-h-0 flex-col overflow-hidden', tab !== 'chat' && 'hidden lg:flex')}>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {!runId && (
              <Empty
                title="Nothing running"
                hint={
                  noAgent
                    ? 'This project has no Console agent. Create the project again or add one under Agents.'
                    : 'Ask a question, request a check, or describe something to create. Read-only work runs immediately; anything riskier asks first.'
                }
              />
            )}

            {detail.data?.steps.map((step) => {
              const m = step.messageJson;
              if (m.role === 'system') return null;
              if (m.role === 'tool') return null;

              if (m.role === 'user') {
                return (
                  <Bubble key={step.id} icon={<User size={13} />} tint="text-cyan" label="You">
                    <p className="whitespace-pre-wrap text-sm text-ink">{cleanTask(m.content ?? '')}</p>
                  </Bubble>
                );
              }

              return (
                <div key={step.id} className="space-y-2">
                  {m.content && (
                    <Bubble icon={<Bot size={13} />} tint="text-violet" label="Assistant">
                      <Markdown>{m.content}</Markdown>
                    </Bubble>
                  )}
                  {m.tool_calls?.map((tc) => {
                    const call = detail.data?.toolCalls.find((c) => c.toolCallId === tc.id);
                    return call ? <ActionCard key={tc.id} call={call} /> : null;
                  })}
                </div>
              );
            })}

            {busy && (
              <div className="flex items-center gap-2 px-1 text-sm text-muted">
                <Spinner className="text-blue" />
                {run?.status === 'awaiting_approval' ? 'Waiting for your decision…' : 'Working…'}
              </div>
            )}

            {run && RESUMABLE.includes(run.status) && (
              <p className="px-1 text-[11px] text-muted">
                Turn complete — ask a follow-up, or start a new session to change scope.
              </p>
            )}

            {run && ENDED.includes(run.status) && (
              <p className="rounded-inner border border-hairline bg-tile-2/50 px-3 py-2 text-[11px] text-muted">
                {run.status === 'failed'
                  ? `This session ended — ${run.statusReason ?? 'the turn failed'}`
                  : 'This session has ended.'}{' '}
                Your next message starts a new one.
              </p>
            )}
          </div>

          {error && <p className="px-4 pb-2 text-sm text-red">{error}</p>}

          <div className="border-t border-hairline p-3">
            <ScopePicker
              targets={primaries}
              selected={scope}
              onChange={setScope}
              locked={!!runId}
              lockedTo={run?.targets ?? []}
            />
            <div className="flex gap-2">
              <textarea
                className="input max-h-40 min-h-[44px] resize-y py-2.5"
                rows={1}
                placeholder={
                  runId ? 'Follow up…' : 'e.g. how many pods are not Running on k3master?'
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a newline. Standard for a chat box.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim() && !busy) send.mutate(input.trim());
                  }
                }}
                disabled={!consoleAgent}
              />
              <button
                className="btn-primary shrink-0 self-end"
                disabled={!input.trim() || busy || send.isPending || !consoleAgent}
                onClick={() => send.mutate(input.trim())}
              >
                {send.isPending ? <Spinner /> : <Send size={15} />}
              </button>
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-muted">
              {targets.data?.length
                ? 'Enter to send · Shift+Enter for a new line'
                : 'No targets registered — the agent can answer questions but cannot inspect anything.'}
            </p>
          </div>
        </section>

        {/* ---------------- terminal ---------------- */}
        <section className={clsx('tile flex min-h-0 flex-col overflow-hidden', tab !== 'terminal' && 'hidden lg:flex')}>
          <header className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
            <span className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-green/70" />
            </span>
            <span className="ml-1 font-mono text-[11px] text-muted">
              {run?.targets?.join(', ') || 'terminal'}
            </span>
            {run && <span className="ml-auto"><StatusPill status={run.status} /></span>}
          </header>
          <Terminal lines={terminalLines} live={busy} className="flex-1" />
        </section>
      </div>
    </div>
  );
}

function Bubble({
  icon, tint, label, children,
}: { icon: React.ReactNode; tint: string; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-inner border border-hairline bg-tile-2/50 p-3">
      <div className={clsx('mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider', tint)}>
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

/** One action, with an inline approve/reject when it is gated. */
function ActionCard({ call }: { call: ToolCall }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const waiting = call.state === 'awaiting_approval';

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      post(`/runs/tool-calls/${call.id}/decision`, { decision, comment: comment || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['run', call.runId] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const args = call.argsJson as { intent?: string };

  return (
    <div className={clsx('rounded-inner border p-3', waiting ? 'border-amber/50 bg-amber/5' : 'border-hairline bg-tile-2/40')}>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted">{call.toolKey}</span>
        <RiskBadge tier={call.tier} />
        <span className={clsx('ml-auto text-[11px]', call.isError ? 'text-red' : 'text-muted')}>
          {OUTCOME_LABEL[call.state] ?? call.state}
        </span>
      </div>

      <CommandBlock className="!text-[11px]">{call.renderedCommand ?? call.toolKey}</CommandBlock>
      {args.intent && <p className="mt-2 text-[11px] text-muted">{args.intent}</p>}

      {waiting && (
        <div className="mt-3 space-y-2">
          <input
            className="input !py-2 text-xs"
            placeholder="Optional note — the agent reads this if you reject"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex gap-2">
            <button className="btn-primary !min-h-[36px] !text-xs" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              <Check size={14} /> Approve
            </button>
            <button className="btn-danger !min-h-[36px] !text-xs" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
              <X size={14} /> Reject
            </button>
          </div>
          <p className="text-[10px] text-muted">
            Also queued under Approvals — deciding in either place resolves it.
          </p>
        </div>
      )}

      {call.decisionComment && <p className="mt-2 text-[11px] text-muted">Note: “{call.decisionComment}”</p>}
    </div>
  );
}

/**
 * Target selection for a new session. Scope is part of the run's frozen snapshot,
 * so once the session has started this becomes a read-only statement of what the
 * agent can reach rather than a control that would lie about being changeable.
 */
function ScopePicker({
  targets, selected, onChange, locked, lockedTo,
}: {
  targets: Target[];
  selected: string[];
  onChange: (next: string[]) => void;
  locked: boolean;
  lockedTo: string[];
}) {
  if (locked) {
    return (
      <p className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-muted">
        <Server size={12} className="shrink-0" />
        <span className="truncate">
          Scope: {lockedTo.length ? lockedTo.join(', ') : 'all targets'} · fixed for this session
        </span>
      </p>
    );
  }
  if (!targets.length) return null;

  const all = selected.length === 0;
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
        Scope
      </span>
      <button
        type="button"
        onClick={() => onChange([])}
        className={clsx(
          'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
          all ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink',
        )}
      >
        All targets
      </button>
      {targets.map((t) => {
        const on = selected.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => toggle(t.id)}
            className={clsx(
              'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
              on ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink',
            )}
          >
            {t.slug}
          </button>
        );
      })}
    </div>
  );
}
