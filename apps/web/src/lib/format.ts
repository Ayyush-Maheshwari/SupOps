import type { RiskTier, RunStatus, ToolCallState } from '@supops/shared';

/**
 * The single source of truth for what colour means in this product.
 *
 * Nothing here relies on colour alone: every tier and state also carries a label,
 * and outcomes additionally carry a *shape* (see `OUTCOME_FILL`) so an action strip
 * is still readable without colour vision.
 */

export const TIER_STYLE: Record<RiskTier, { label: string; chip: string; text: string; bg: string; hex: string }> = {
  read_only: {
    label: 'read-only',
    chip: 'border-muted/25 bg-muted/10 text-muted',
    text: 'text-muted',
    bg: 'bg-muted',
    hex: 'rgb(var(--muted))',
  },
  low: {
    label: 'low',
    chip: 'border-cyan/30 bg-cyan/10 text-cyan',
    text: 'text-cyan',
    bg: 'bg-cyan',
    hex: 'rgb(var(--cyan))',
  },
  medium: {
    label: 'medium',
    chip: 'border-amber/30 bg-amber/10 text-amber',
    text: 'text-amber',
    bg: 'bg-amber',
    hex: 'rgb(var(--amber))',
  },
  high: {
    label: 'high',
    chip: 'border-red/30 bg-red/10 text-red',
    text: 'text-red',
    bg: 'bg-red',
    hex: 'rgb(var(--red))',
  },
  forbidden: {
    label: 'forbidden',
    chip: 'border-red/60 bg-red/20 text-red',
    text: 'text-red',
    bg: 'bg-red',
    hex: 'rgb(var(--red))',
  },
};

export const STATUS_STYLE: Record<RunStatus, { label: string; text: string; dot: string; rail: string; live: boolean }> = {
  queued: { label: 'Queued', text: 'text-muted', dot: 'bg-muted', rail: 'bg-muted', live: true },
  running: { label: 'Running', text: 'text-blue-text', dot: 'bg-blue', rail: 'bg-blue', live: true },
  awaiting_approval: { label: 'Needs approval', text: 'text-amber', dot: 'bg-amber', rail: 'bg-amber', live: true },
  // Parked between turns, waiting on the human -- an invitation to type, not a
  // fault, so it does not pulse like an in-flight run.
  awaiting_input: { label: 'Ready', text: 'text-cyan', dot: 'bg-cyan', rail: 'bg-cyan', live: false },
  suspended: { label: 'Backing off', text: 'text-violet', dot: 'bg-violet', rail: 'bg-violet', live: true },
  succeeded: { label: 'Succeeded', text: 'text-green', dot: 'bg-green', rail: 'bg-green', live: false },
  failed: { label: 'Failed', text: 'text-red', dot: 'bg-red', rail: 'bg-red', live: false },
  cancelled: { label: 'Cancelled', text: 'text-muted', dot: 'bg-dim', rail: 'bg-dim', live: false },
  expired: { label: 'Expired', text: 'text-muted', dot: 'bg-dim', rail: 'bg-dim', live: false },
  halted: { label: 'Halted', text: 'text-red', dot: 'bg-red', rail: 'bg-red', live: false },
};

export const ENV_STYLE: Record<string, string> = {
  dev: 'border-muted/25 bg-muted/10 text-muted',
  staging: 'border-cyan/30 bg-cyan/10 text-cyan',
  prod: 'border-red/30 bg-red/10 text-red',
};

export const HEALTH_STYLE: Record<string, { label: string; dot: string; hex: string; text: string }> = {
  ok: { label: 'reachable', dot: 'bg-green', hex: 'rgb(var(--green))', text: 'text-green' },
  degraded: { label: 'degraded', dot: 'bg-amber', hex: 'rgb(var(--amber))', text: 'text-amber' },
  unreachable: { label: 'unreachable', dot: 'bg-red', hex: 'rgb(var(--red))', text: 'text-red' },
  unknown: { label: 'not checked', dot: 'bg-dim', hex: 'rgb(var(--dim))', text: 'text-muted' },
};

/**
 * How a tool call's outcome is drawn, *independently of its tier colour*.
 *
 * `solid` ran, `hatch` failed, `hollow` never ran (blocked or denied), `dotted` is
 * still waiting. Encoding outcome as shape is what lets the action strip carry two
 * dimensions at once, and keeps it legible without colour.
 */
export type OutcomeFill = 'solid' | 'hatch' | 'hollow' | 'dotted';

export const OUTCOME_FILL: Record<ToolCallState, OutcomeFill> = {
  proposed: 'dotted',
  classified: 'dotted',
  auto_approved: 'dotted',
  awaiting_approval: 'dotted',
  approved: 'dotted',
  executing: 'dotted',
  succeeded: 'solid',
  failed: 'hatch',
  timed_out: 'hatch',
  unknown_outcome: 'hatch',
  blocked: 'hollow',
  denied: 'hollow',
  expired: 'hollow',
};

export const OUTCOME_LABEL: Record<ToolCallState, string> = {
  proposed: 'proposed',
  classified: 'classified',
  auto_approved: 'approved by policy',
  awaiting_approval: 'awaiting approval',
  approved: 'approved',
  executing: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  timed_out: 'timed out',
  unknown_outcome: 'outcome unknown',
  blocked: 'blocked by policy',
  denied: 'rejected',
  expired: 'approval expired',
};

/**
 * Collapse a run's actions into a per-tier tally.
 *
 * `RiskBar` is the single mark for "what did this run do", and it wants counts
 * rather than the action list, so every caller goes through this instead of
 * reducing inline in three different places.
 */
export const tierCounts = (
  actions: Array<{ tier: RiskTier | null }>,
): Partial<Record<RiskTier, number>> =>
  actions.reduce<Partial<Record<RiskTier, number>>>((acc, a) => {
    const t = a.tier ?? 'read_only';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});

export function timeAgo(value: number | string | null): string {
  if (!value) return '--';
  const then = typeof value === 'number' ? value : Date.parse(value);
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/**
 * API timestamps arrive as ISO strings, not epoch numbers. Subtracting two of them
 * yields NaN silently -- which is how "Elapsed NaNm NaNs" reached the dashboard.
 * Every duration calculation goes through this.
 */
export const ms = (v: number | string | null | undefined): number =>
  v == null ? 0 : typeof v === 'number' ? v : Date.parse(v);

/** Elapsed time for a run, counting up while it is still going. */
export const elapsed = (startedAt: number | string, endedAt: number | string | null): number =>
  Math.max((endedAt ? ms(endedAt) : Date.now()) - ms(startedAt), 0);

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const compact = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();

export const SEVERITY_STYLE: Record<string, { label: string; chip: string; dot: string }> = {
  critical: { label: 'critical', chip: 'border-red/40 bg-red/10 text-red', dot: 'bg-red' },
  warning: { label: 'warning', chip: 'border-amber/40 bg-amber/10 text-amber', dot: 'bg-amber' },
  info: { label: 'info', chip: 'border-cyan/40 bg-cyan/10 text-cyan', dot: 'bg-cyan' },
  unknown: { label: 'unknown', chip: 'border-edge bg-tile-2 text-muted', dot: 'bg-dim' },
};

export const ALERT_STATUS_STYLE: Record<string, { label: string; text: string; dot: string }> = {
  new: { label: 'New', text: 'text-amber', dot: 'bg-amber' },
  investigating: { label: 'Investigating', text: 'text-blue-text', dot: 'bg-blue' },
  ignored: { label: 'Ignored', text: 'text-muted', dot: 'bg-dim' },
  resolved: { label: 'Resolved', text: 'text-green', dot: 'bg-green' },
};

/**
 * The first user message of a run is the engine's opening message: Project / Targets
 * / Task, with one block of internal orchestration scaffolding -- the "IMPORTANT: do
 * NOT check these machines one by one ... call confirm_target ... Run NOTHING until
 * approved" direction the engine gives the model. Keep the structure the operator
 * expects; strip only that block. Follow-up messages contain no such block and pass
 * through unchanged.
 */
export const cleanTask = (content: string): string =>
  content.replace(/\n {2}IMPORTANT:[\s\S]*?(?=\n\n|$)/g, '');
