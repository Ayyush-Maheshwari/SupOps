/**
 * How a health scan's findings become per-target health.
 *
 * Pure so it can be tested without a database. The rule the whole feature hangs on:
 * only an essential problem (warning/critical) degrades a target. A `notice` is worth
 * showing but never changes the state, and `reachable: false` means the agent could
 * not get in at all, which outranks everything else.
 */

export type HealthState = 'ok' | 'degraded' | 'unreachable';
export type FindingSeverity = 'info' | 'notice' | 'warning' | 'critical';

export interface ScanFinding {
  targetId: string;
  severity: FindingSeverity;
  finding: string;
  reachable?: boolean;
}

/** A finding that is kept as an issue: essential problems and notes. */
export interface IssueDraft {
  targetId: string;
  severity: Exclude<FindingSeverity, 'info'>;
  title: string;
  detail: string;
}

export interface HealthJudgement {
  states: Map<string, HealthState>;
  issues: IssueDraft[];
  summary: { checked: number; ok: number; degraded: number; unreachable: number; issues: number; notes: number };
}

const STATE_RANK: Record<HealthState, number> = { ok: 0, degraded: 1, unreachable: 2 };

export const SEVERITIES: readonly FindingSeverity[] = ['info', 'notice', 'warning', 'critical'];

/** Anything the agent sent that is not a known severity is read as info. */
export const asSeverity = (v: unknown): FindingSeverity =>
  SEVERITIES.includes(v as FindingSeverity) ? (v as FindingSeverity) : 'info';

const stateOf = (f: ScanFinding): HealthState =>
  f.reachable === false ? 'unreachable' : f.severity === 'warning' || f.severity === 'critical' ? 'degraded' : 'ok';

/**
 * Judge one scan. `scoped` is every target the scan covered: a target the agent never
 * flagged counts as healthy.
 */
export function judgeHealth(findings: ScanFinding[], scoped: string[]): HealthJudgement {
  const states = new Map<string, HealthState>(scoped.map((id) => [id, 'ok']));
  const issues: IssueDraft[] = [];

  for (const f of findings) {
    if (!states.has(f.targetId)) continue;
    const next = stateOf(f);
    if (STATE_RANK[next] > STATE_RANK[states.get(f.targetId)!]) states.set(f.targetId, next);
    if (f.severity !== 'info') {
      issues.push({
        targetId: f.targetId,
        severity: f.severity,
        title: f.finding.split('\n')[0]!.slice(0, 120),
        detail: f.finding,
      });
    }
  }

  const summary = { checked: 0, ok: 0, degraded: 0, unreachable: 0, issues: 0, notes: 0 };
  for (const state of states.values()) {
    summary.checked += 1;
    summary[state] += 1;
  }
  for (const i of issues) {
    if (i.severity === 'notice') summary.notes += 1;
    else summary.issues += 1;
  }
  return { states, issues, summary };
}
