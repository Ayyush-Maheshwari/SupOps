import type { Incident } from './types';

/**
 * Plain words for what SupOps found, used everywhere an incident or a finding is
 * shown -- so a person reads "Act now" or "Nothing to do", never a model's jargon.
 */

export type Verdict = 'act_now' | 'can_wait' | 'none' | 'checking' | 'checked' | 'unchecked';

export function verdictOf(i: Pick<Incident, 'action' | 'triageState' | 'severity' | 'status'>): Verdict {
  if (i.action) return i.action;
  if (i.triageState === 'evidence' || i.triageState === 'running') return 'checking';
  // Diagnosed before verdicts existed: checked, but read the diagnosis for what it found.
  if (i.triageState === 'done') return 'checked';
  return 'unchecked';
}

export const VERDICT: Record<Verdict, { label: string; chip: string; bar: string; hint: string }> = {
  act_now: { label: 'Act now', chip: 'border-red/40 bg-red/10 text-red', bar: 'bg-red', hint: 'A real problem that needs fixing.' },
  can_wait: { label: 'Can wait', chip: 'border-amber/40 bg-amber/10 text-amber', bar: 'bg-amber', hint: 'Real, but not urgent.' },
  none: { label: 'Nothing to do', chip: 'border-green/40 bg-green/10 text-green', bar: 'bg-green/70', hint: 'Checked: not a real problem.' },
  checking: { label: 'Checking…', chip: 'border-blue/40 bg-blue/10 text-blue-text', bar: 'bg-blue', hint: 'SupOps is looking into it, read-only.' },
  checked: { label: 'Checked', chip: 'border-edge bg-tile-2 text-ink/80', bar: 'bg-dim', hint: 'Diagnosed: open it to read what was found.' },
  unchecked: { label: 'Not checked yet', chip: 'border-edge bg-tile-2 text-muted', bar: 'bg-dim', hint: 'Investigate to have it checked.' },
};

/** Where an incident came from, in words. */
export const ORIGIN_LABEL: Record<Incident['origin'], string> = {
  alerts: 'Alert',
  prediction: 'Forecast',
  threshold: 'Over its limit',
};

/** How sure a diagnosis is, in words. */
export const SURE: Record<string, string> = { high: 'Sure', medium: 'Fairly sure', low: 'Not sure', inconclusive: 'Could not tell' };

/** Order for "needs you": act now, then checking or unchecked by severity, then can wait. */
export function urgency(i: Incident): number {
  const v = verdictOf(i);
  const sev = i.severity === 'critical' ? 0 : i.severity === 'warning' ? 1 : 2;
  return v === 'act_now' ? 0 + sev : v === 'checking' || v === 'unchecked' || v === 'checked' ? 10 + sev : v === 'can_wait' ? 20 + sev : 30 + sev;
}
