import type { RiskTier, Role } from '@supops/shared';
import { tierRank } from '@supops/shared';
import type { RiskPolicy } from '@supops/db';

/**
 * Who may decide an action that is waiting for a human.
 *
 * The run's policy snapshot names a minimum role per tier (`approverRoleByTier`) and
 * a tier at or above which the approver must be someone other than whoever started
 * the run (`requireSecondPersonAtTier`). Both were stored and shown but never
 * checked, so any signed-in user could approve anything -- including their own
 * high-risk change. This is the one place they are enforced.
 *
 * Denying is always allowed to any signed-in user: refusing an action can only make
 * things safer, and a junior engineer who spots a bad command must be able to stop it.
 */

/** Role order, weakest first. `approver` sits between operator and admin. */
const RANK: Record<Role, number> = { viewer: 0, operator: 1, approver: 2, admin: 3, owner: 4 };

/** Accounts carry a global role; map it onto the policy's role scale. */
export function approverRoleOf(globalRole: string): Role {
  if (globalRole === 'owner') return 'owner';
  if (globalRole === 'admin') return 'admin';
  if (globalRole === 'member') return 'operator';
  return 'viewer';
}

export interface DecisionInput {
  decision: 'approve' | 'deny';
  tier: RiskTier;
  policy: Pick<RiskPolicy, 'approverRoleByTier' | 'requireSecondPersonAtTier'>;
  decider: { id: string; globalRole: string };
  /** Who started the run; null for alert/schedule runs nobody started. */
  startedBy: string | null;
  /** Active accounts that hold the required role for this tier, the decider included. */
  eligibleApprovers: number;
}

export type DecisionCheck =
  | { ok: true; selfApproved: boolean }
  | { ok: false; reason: string };

export function requiredRole(tier: RiskTier, policy: DecisionInput['policy']): Role {
  return policy.approverRoleByTier[tier] ?? (tierRank(tier) >= tierRank('high') ? 'admin' : 'operator');
}

export function canDecide(input: DecisionInput): DecisionCheck {
  if (input.decision === 'deny') return { ok: true, selfApproved: false };

  const need = requiredRole(input.tier, input.policy);
  const have = approverRoleOf(input.decider.globalRole);
  if (RANK[have] < RANK[need]) {
    return {
      ok: false,
      reason: `A ${input.tier}-risk action needs an ${need} to approve it; you are signed in as ${input.decider.globalRole}.`,
    };
  }

  const secondFrom = input.policy.requireSecondPersonAtTier;
  const own = !!input.startedBy && input.startedBy === input.decider.id;
  if (own && secondFrom && tierRank(input.tier) >= tierRank(secondFrom)) {
    // A single-person install has nobody else to ask; refusing would deadlock every
    // high-risk action. Allow it, but record that it was self-approved.
    if (input.eligibleApprovers < 2) return { ok: true, selfApproved: true };
    return {
      ok: false,
      reason: `${input.tier}-risk actions need a second person: someone other than whoever started this run must approve it.`,
    };
  }
  return { ok: true, selfApproved: false };
}

/** Which global roles meet a policy role -- for counting eligible approvers. */
export function globalRolesMeeting(need: Role): string[] {
  return (['owner', 'admin', 'member'] as const).filter((g) => RANK[approverRoleOf(g)] >= RANK[need]);
}
