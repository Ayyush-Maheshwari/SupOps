import type { RiskTier, Role } from '@supops/shared';
import { AUTONOMY_HARD_CAP, minTier, tierRank } from '@supops/shared';
import type { RiskPolicy } from '@supops/db';

/**
 * Combine a project's policy with an agent's override into the policy a run uses.
 *
 * An agent may set its own auto-run level anywhere up to the project's ceiling --
 * that is how one agent (say, a dev-only fixer) is given more room than the rest.
 * Every other field an agent sets can only make things stricter: lower caps,
 * a lower second-person tier, stronger approver roles, shorter approval windows.
 * The result is clamped every time, so lowering a project's ceiling later also
 * reins in agents that were raised before.
 */

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, approver: 2, admin: 3, owner: 4 };
const clampHard = (t: RiskTier): RiskTier => minTier(t, AUTONOMY_HARD_CAP);

/** The most any agent in this project may be raised to. */
export const projectCeiling = (p: RiskPolicy): RiskTier =>
  clampHard(p.autoExecuteCeiling ?? p.autoExecuteMaxTier);

function minCaps<K extends string>(a?: Partial<Record<K, RiskTier>>, b?: Partial<Record<K, RiskTier>>) {
  if (!a && !b) return undefined;
  const out: Partial<Record<K, RiskTier>> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {}) as Array<[K, RiskTier]>) {
    out[k] = out[k] ? minTier(out[k]!, v) : v;
  }
  return out;
}

export function mergePolicy(project: RiskPolicy, override: Partial<RiskPolicy> | null | undefined): RiskPolicy {
  const base: RiskPolicy = { ...project, autoExecuteMaxTier: clampHard(project.autoExecuteMaxTier) };
  if (!override) return base;

  const second = (t: RiskTier | null | undefined): number => (t ? tierRank(t) : Infinity);
  const roles: RiskPolicy['approverRoleByTier'] = { ...project.approverRoleByTier };
  for (const [tier, role] of Object.entries(override.approverRoleByTier ?? {}) as Array<[RiskTier, Role]>) {
    const cur = roles[tier];
    if (!cur || ROLE_RANK[role] > ROLE_RANK[cur]) roles[tier] = role;
  }
  const ttl: RiskPolicy['ttlMsByTier'] = { ...project.ttlMsByTier };
  for (const [tier, ms] of Object.entries(override.ttlMsByTier ?? {}) as Array<[RiskTier, number]>) {
    ttl[tier] = ttl[tier] ? Math.min(ttl[tier]!, ms) : ms;
  }

  return {
    ...base,
    autoExecuteMaxTier: override.autoExecuteMaxTier
      ? minTier(override.autoExecuteMaxTier, projectCeiling(project))
      : base.autoExecuteMaxTier,
    prodAutoExecuteCap: override.prodAutoExecuteCap
      ? minTier(override.prodAutoExecuteCap, project.prodAutoExecuteCap ?? 'low')
      : project.prodAutoExecuteCap,
    toolAutoExecuteCap: minCaps(project.toolAutoExecuteCap, override.toolAutoExecuteCap) as Record<string, RiskTier> | undefined,
    triggerAutoExecuteCap: minCaps(project.triggerAutoExecuteCap, override.triggerAutoExecuteCap),
    approverRoleByTier: roles,
    requireSecondPersonAtTier:
      second(override.requireSecondPersonAtTier) < second(project.requireSecondPersonAtTier)
        ? override.requireSecondPersonAtTier!
        : project.requireSecondPersonAtTier,
    ttlMsByTier: ttl,
    onExpiry: override.onExpiry === 'abort_run' ? 'abort_run' : project.onExpiry,
    maxConcurrentApprovals: Math.min(project.maxConcurrentApprovals, override.maxConcurrentApprovals ?? Infinity),
  };
}

/** Reject an agent override that asks for more than the project allows, with a reason an admin can act on. */
export function validateAgentOverride(project: RiskPolicy, override: Partial<RiskPolicy> | null | undefined): string | null {
  if (!override?.autoExecuteMaxTier) return null;
  const ceiling = projectCeiling(project);
  if (tierRank(override.autoExecuteMaxTier) > tierRank(ceiling)) {
    return `This project lets agents act on their own only up to ${ceiling}. Raise the project ceiling in Settings › Autonomy first.`;
  }
  return null;
}

/** Validate a project policy update: nothing above the hard cap, ceiling not below the default. */
export function validateProjectPolicy(p: RiskPolicy): string | null {
  for (const [label, t] of [
    ['Auto-run level', p.autoExecuteMaxTier],
    ['Agent ceiling', p.autoExecuteCeiling],
    ['Production cap', p.prodAutoExecuteCap],
  ] as const) {
    if (t && tierRank(t) > tierRank(AUTONOMY_HARD_CAP)) return `${label} cannot be above ${AUTONOMY_HARD_CAP}: high-risk actions always need a human.`;
  }
  if (p.autoExecuteCeiling && tierRank(p.autoExecuteCeiling) < tierRank(p.autoExecuteMaxTier)) {
    return 'The agent ceiling cannot be lower than the project auto-run level.';
  }
  return null;
}
