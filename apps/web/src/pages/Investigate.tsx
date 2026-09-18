import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Send } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { PageHeader } from '../components/Layout';
import { EnvBadge, Field, HealthBadge, Panel, Spinner } from '../components/ui';
import { HealthRing } from '../components/viz';
import { HEALTH_STYLE } from '../lib/format';
import type { Agent, Run, Target } from '../lib/types';

const EXAMPLES = [
  'Disk usage is climbing. Work out what is filling it.',
  'The service stopped responding after the last deploy. Diagnose and fix it.',
  'Report disk, memory and load, and flag anything unhealthy.',
];

export function Investigate() {
  const projectId = useApp((s) => s.projectId);
  const navigate = useNavigate();
  const [task, setTask] = useState('');
  const [agentId, setAgentId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  // VMs reached via a jump are hidden from the picker: you select the jump ("prod")
  // and the run includes the machines behind it, so the agent can decide which node
  // to check. Each VM is still its own target for scoping/audit.
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

  // With a single primary there is nothing to choose, so preselect it and let the
  // operator write "check disk usage" rather than naming the host every time.
  useEffect(() => {
    if (primaries.length === 1 && selected.length === 0) {
      setSelected([primaries[0]!.id]);
    }
  }, [primaries.length, selected.length]);

  // Default to the Triage agent when the operator hasn't picked one.
  const chosenAgent =
    agentId ||
    agents.data?.find((a) => a.slug === 'triage')?.id ||
    agents.data?.[0]?.id ||
    '';
  const scoped = selected.length > 0 && selected.length < primaries.length;
  const chosenTargets = primaries.filter((t) => selected.includes(t.id));
  const hiddenVmCount = chosenTargets.reduce((n, t) => n + childrenOf(t).length, 0);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function start() {
    if (!task.trim() || !chosenAgent || !projectId) return;
    setBusy(true);
    setError(null);
    try {
      // Expand each selected jump to include the machines behind it, so the agent
      // can reach whichever node the investigation points to.
      const ids = new Set(selected);
      for (const id of selected) {
        const t = allTargets.find((x) => x.id === id);
        if (t) for (const c of childrenOf(t)) ids.add(c.id);
      }
      const run = await post<Run>('/runs', {
        projectId,
        agentId: chosenAgent,
        task: task.trim(),
        ...(ids.size ? { targetIds: [...ids] } : {}),
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run');
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Investigate" subtitle="Tell it what's wrong. It digs through the evidence and figures out why." />

      <div className="mx-auto max-w-3xl space-y-4 p-6">
        {targets.data?.length === 0 && (
          <div className="rounded-lg border border-amber/30 bg-amber/5 px-4 py-3 text-sm text-amber">
            No targets registered yet. Add one under Targets before starting a run.
          </div>
        )}

        <Panel className="p-4">
          <div className="space-y-4">
            <Field
              label="Targets"
              hint={
                selected.length === 0
                  ? 'Nothing selected — the agent may use any target in the project.'
                  : hiddenVmCount > 0
                    ? `Includes ${hiddenVmCount} machine${hiddenVmCount === 1 ? '' : 's'} behind the selected jump${selected.length === 1 ? '' : 's'} — the agent picks which to check.`
                    : selected.length === 1
                      ? `Scoped to ${chosenTargets[0]?.slug}. You do not need to name it in the task.`
                      : `Scoped to ${selected.length} targets. Nothing else is reachable.`
              }
            >
              <div className="flex flex-wrap gap-2">
                {primaries.map((t) => {
                  const on = selected.includes(t.id);
                  const h = HEALTH_STYLE[t.healthState] ?? HEALTH_STYLE.unknown!;
                  const behind = childrenOf(t).length;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(t.id)}
                      className={clsx(
                        'group flex min-h-[44px] items-center gap-3 rounded-inner border p-3 text-left transition-all duration-150',
                        on
                          ? 'border-blue/60 bg-blue/10 text-ink shadow-[0_8px_20px_-14px_rgb(var(--blue))]'
                          : 'border-hairline bg-tile-2/60 text-muted hover:border-edge hover:text-ink',
                      )}
                    >
                      <HealthRing
                        size={34}
                        thickness={4}
                        segments={[{ label: h.label, value: 1, hex: h.hex }]}
                        center={on ? <Check size={13} strokeWidth={3} /> : t.env.slice(0, 1).toUpperCase()}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs text-ink">{t.slug}</span>
                          <EnvBadge env={t.env} />
                        </span>
                        <span className="mt-1 block">
                          {behind > 0 ? (
                            <span className="text-[11px] text-muted">{behind} machine{behind === 1 ? '' : 's'} behind it</span>
                          ) : (
                            <HealthBadge state={t.healthState} />
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {!!selected.length && (
                  <button
                    type="button"
                    onClick={() => setSelected([])}
                    className="rounded-lg px-3 py-2 text-xs text-muted hover:text-ink"
                  >
                    Clear
                  </button>
                )}
              </div>
            </Field>

            <Field label="What is wrong?" hint="Be specific about the symptom. The agent will find the cause.">
              <textarea
                className="input min-h-32 resize-y"
                placeholder={
                  chosenTargets.length === 1
                    ? `e.g. disk is filling up on ${chosenTargets[0]!.slug}, or just: check disk usage`
                    : 'e.g. checkout is returning 500s since about 14:20'
                }
                value={task}
                onChange={(e) => setTask(e.target.value)}
                autoFocus
              />
            </Field>

            <Field label="Agent">
              <select className="input" value={chosenAgent} onChange={(e) => setAgentId(e.target.value)}>
                {agents.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.role}
                  </option>
                ))}
              </select>
            </Field>

            {error && (
              <p className="rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-muted">
                {scoped
                  ? 'Targets outside this selection are not just discouraged — they are absent from the tools the agent is given.'
                  : 'Read-only checks run immediately. Anything riskier will pause for your approval.'}
              </p>
              <button
                className="btn-primary shrink-0"
                onClick={start}
                disabled={busy || !task.trim() || !chosenAgent || !targets.data?.length}
              >
                {busy ? <Spinner /> : <Send size={15} />} Start
              </button>
            </div>
          </div>
        </Panel>

        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => setTask(e)}
              className="rounded-full border border-hairline bg-tile px-3 py-1.5 text-xs text-muted hover:border-blue/50 hover:text-ink"
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
