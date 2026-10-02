import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { autoCeiling, describeAutonomy, RISK_TIERS, tierAtMost } from '@supops/shared';
import type { RiskTier } from '@supops/shared';
import { api, patch } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Panel, Segmented, Spinner } from './ui';
import type { AuditEntry, Project, ProjectPolicy } from '../lib/types';

type T3 = 'read_only' | 'low' | 'medium';
const LEVELS: Array<{ value: T3; label: string }> = [
  { value: 'read_only', label: 'Read-only' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
];

const TIER_NAME: Record<RiskTier, string> = { read_only: 'Read-only', low: 'Low', medium: 'Medium', high: 'High', forbidden: 'Forbidden' };

/** Columns of the live matrix: where and how a run was started. */
const CONTEXTS: Array<{ label: string; sensitive: boolean; trigger: string }> = [
  { label: 'Console / Investigate', sensitive: false, trigger: 'chat' },
  { label: 'On production', sensitive: true, trigger: 'chat' },
  { label: 'Started by an alert', sensitive: false, trigger: 'alert' },
  { label: 'Scheduled health scan', sensitive: false, trigger: 'health' },
];

/**
 * Settings › Autonomy: how much this project's agents do on their own. Every control
 * is backed by the same autoCeiling() the engine uses, so the matrix below is exactly
 * what will happen, not a description of it. Admin-only to change.
 */
export function AutonomyPanel({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const qc = useQueryClient();
  const [p, setP] = useState<ProjectPolicy | null>(project.riskPolicy ?? null);
  useEffect(() => setP(project.riskPolicy ?? null), [project.riskPolicy]);

  const save = useMutation({
    mutationFn: (next: ProjectPolicy) => patch<Project>(`/projects/${project.id}/policy`, next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['audit', project.id] });
    },
  });
  const apply = (change: Partial<ProjectPolicy>) => {
    if (!p) return;
    const next = { ...p, ...change };
    // Keep the ceiling at least the project level so the pair stays valid.
    const rank = (t: RiskTier) => RISK_TIERS.indexOf(t);
    if (rank(next.autoExecuteCeiling ?? next.autoExecuteMaxTier) < rank(next.autoExecuteMaxTier)) next.autoExecuteCeiling = next.autoExecuteMaxTier;
    setP(next);
    save.mutate(next);
  };

  const [instructions, setInstructions] = useState(project.systemPromptExtra ?? '');
  useEffect(() => setInstructions(project.systemPromptExtra ?? ''), [project.systemPromptExtra]);
  const saveInstructions = useMutation({
    mutationFn: () => patch<Project>(`/projects/${project.id}`, { systemPromptExtra: instructions.trim() || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['audit', project.id] });
    },
  });

  const history = useQuery({
    queryKey: ['audit', project.id],
    queryFn: () => api<AuditEntry[]>(`/projects/${project.id}/audit`),
    enabled: canEdit,
  });

  if (!p) return null;
  const alertCap = (p.triggerAutoExecuteCap?.alert ?? 'low') as T3;
  const second = p.requireSecondPersonAtTier ?? 'never';

  return (
    <Panel title="Autonomy" accent="bg-violet">
      <div className="space-y-5 px-5 pb-5 pt-1">
        <p className="text-sm text-muted">{describeAutonomy(p)}</p>

        <div className="space-y-3">
          <Row label="Agents act without asking, up to" hint="Anything riskier waits for someone to approve it.">
            <Segmented label="Project auto-run level" value={p.autoExecuteMaxTier as T3} disabled={!canEdit} options={LEVELS} onChange={(v) => apply({ autoExecuteMaxTier: v })} />
          </Row>
          <Row label="The most freedom one agent can be given" hint="Agents can be raised on the Agents page, never beyond this.">
            <Segmented
              label="Agent ceiling"
              value={(p.autoExecuteCeiling ?? p.autoExecuteMaxTier) as T3}
              disabled={!canEdit}
              options={LEVELS}
              onChange={(v) => apply({ autoExecuteCeiling: v })}
            />
          </Row>
          <Row label="On production, act without asking up to" hint="Every action on production also counts as one level riskier.">
            <Segmented label="Production cap" value={(p.prodAutoExecuteCap ?? 'low') as T3} disabled={!canEdit} options={LEVELS} onChange={(v) => apply({ prodAutoExecuteCap: v })} />
          </Row>
          <Row label="When an alert starts the run, act without asking up to" hint="Alert text comes from outside SupOps and could be written to mislead the agent.">
            <Segmented
              label="Alert cap"
              value={alertCap}
              disabled={!canEdit}
              options={LEVELS}
              onChange={(v) => apply({ triggerAutoExecuteCap: { ...(p.triggerAutoExecuteCap ?? {}), alert: v } })}
            />
          </Row>
          <Row label="Require a different approver for" hint="Whoever started the run cannot approve their own actions at this level.">
            <Segmented
              label="Second person"
              value={second as 'medium'}
              disabled={!canEdit}
              options={[
                { value: 'medium', label: 'Medium and up' },
                { value: 'high', label: 'High only' },
                { value: 'never' as 'medium', label: 'Off' },
              ]}
              onChange={(v) => apply({ requireSecondPersonAtTier: (v as string) === 'never' ? null : v })}
            />
          </Row>
          {save.isPending && <p className="text-[11px] text-muted"><Spinner /> Saving…</p>}
          {save.error && <p className="text-[11px] text-red">{(save.error as Error).message}</p>}
        </div>

        {/* ---- live matrix ---- */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-xs">
            <thead>
              <tr>
                <th className="px-2 py-1.5 text-left font-semibold text-muted">Risk of the action</th>
                {CONTEXTS.map((c) => (
                  <th key={c.label} className="px-2 py-1.5 text-left font-semibold text-muted">{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {RISK_TIERS.map((t) => (
                <tr key={t} className="border-t border-hairline">
                  <td className="px-2 py-1.5 text-ink">{TIER_NAME[t]}</td>
                  {CONTEXTS.map((c) => {
                    const ceiling = autoCeiling({ policy: p, sensitive: c.sensitive, trigger: c.trigger }).tier;
                    const verdict = t === 'forbidden' ? 'Never runs' : tierAtMost(t, ceiling) ? 'Runs' : c.trigger === 'health' ? 'Skipped' : 'Asks you';
                    return (
                      <td key={c.label} className="px-2 py-1.5">
                        <span
                          className={clsx(
                            'chip border',
                            verdict === 'Runs' && 'border-green/40 bg-green/10 text-green',
                            verdict === 'Asks you' && 'border-amber/40 bg-amber/10 text-amber',
                            (verdict === 'Never runs' || verdict === 'Skipped') && 'border-red/40 bg-red/10 text-red',
                          )}
                        >
                          {verdict}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px] text-muted">Whatever you set above, high-risk actions always need approval and forbidden ones never run. Health scans run with nobody watching, so anything that would need approval is skipped and reported instead.</p>
        </div>

        {/* ---- project instructions ---- */}
        <div className="space-y-2 border-t border-hairline pt-4">
          <div className="text-sm text-ink">Project instructions</div>
          <p className="text-[11px] text-muted">Added to every agent's instructions in this project — short, stable conventions such as “we deploy only through ArgoCD”.</p>
          <textarea
            className="input min-h-24 resize-y text-sm"
            value={instructions}
            disabled={!canEdit}
            maxLength={5000}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder={canEdit ? 'e.g. Never restart the payments service during business hours (09:00–18:00 UTC).' : 'None'}
          />
          {canEdit && (
            <div className="flex items-center gap-3">
              <button
                className="btn-ghost"
                disabled={saveInstructions.isPending || instructions === (project.systemPromptExtra ?? '')}
                onClick={() => saveInstructions.mutate()}
              >
                {saveInstructions.isPending ? <Spinner /> : null} Save instructions
              </button>
              <span className="text-[11px] text-muted">{instructions.length}/5000</span>
              {saveInstructions.error && <span className="text-[11px] text-red">{(saveInstructions.error as Error).message}</span>}
            </div>
          )}
        </div>

        {/* ---- change history ---- */}
        {canEdit && (
          <div className="space-y-2 border-t border-hairline pt-4">
            <div className="text-sm text-ink">Change history</div>
            {history.data?.length ? (
              <ul className="space-y-1 text-[11px] text-muted">
                {history.data.slice(0, 12).map((h) => (
                  <li key={h.id} className="flex flex-wrap gap-x-2">
                    <span className="text-ink">{h.actorName ?? 'system'}</span>
                    <span>{describeChange(h)}</span>
                    <span className="text-dim">· {timeAgo(h.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-muted">No changes recorded yet.</p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function describeChange(h: AuditEntry): string {
  const what: Record<string, string> = {
    'project.policy': 'changed autonomy',
    'project.settings': 'changed project settings',
    'project.killSwitch': h.action === 'halt' ? 'halted all agents' : 'resumed agents',
    agent: `${h.action}d an agent`,
    history: 'cleaned up run history',
  };
  return what[h.entity] ?? `${h.action} ${h.entity}`;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
