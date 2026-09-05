/**
 * Risk tiers. The ordering is the whole safety model: every classification stage
 * may only ever RAISE a tier, never lower it (see `maxTier`). That single rule is
 * what makes prompt injection through tool output unable to buy an agent more
 * permission than it started with.
 */
export const RISK_TIERS = ['read_only', 'low', 'medium', 'high', 'forbidden'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

const ORDER: Record<RiskTier, number> = {
  read_only: 0,
  low: 1,
  medium: 2,
  high: 3,
  forbidden: 4,
};

export const tierRank = (t: RiskTier): number => ORDER[t];

/** Monotonic join. The only way tiers are ever combined. */
export function maxTier(...tiers: RiskTier[]): RiskTier {
  let out: RiskTier = 'read_only';
  for (const t of tiers) if (ORDER[t] > ORDER[out]) out = t;
  return out;
}

export const tierAtMost = (t: RiskTier, ceiling: RiskTier): boolean =>
  ORDER[t] <= ORDER[ceiling];

/**
 * `forbidden` is deliberately NOT the top of the approval range -- it is outside
 * it. No role, no policy, and no amount of approval can execute a forbidden call.
 * That separation is what lets approval UX be ergonomic for medium/high without
 * ever putting `rm -rf /` one tired click away.
 */
export const isApprovable = (t: RiskTier): boolean => t !== 'forbidden';

/** One stage's contribution to a decision, kept for the audit trail and the approver UI. */
export interface RiskContribution {
  stage: 'baseline' | 'arguments' | 'target' | 'model' | 'override';
  tier: RiskTier;
  ruleId?: string;
  reason: string;
}

export interface RiskAssessment {
  tier: RiskTier;
  contributions: RiskContribution[];
  decision: 'auto' | 'approve' | 'block';
}
