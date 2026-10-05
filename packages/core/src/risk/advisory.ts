import type { RiskTier } from '@supops/shared';
import type { ResolvedTarget } from '../tools/types.ts';
import { classifyShellCommand } from './shell.ts';

/**
 * The machine an advisory run's suggested commands are rated against. The operator
 * runs them by hand somewhere SupOps cannot see, so assume the worst: production,
 * with sudo, and no paths known to be safe to write.
 */
const UNSEEN: ResolvedTarget = {
  id: 'advisory',
  slug: 'advisory',
  kind: 'ssh',
  env: 'prod',
  sensitivity: 3,
  description: null,
  config: { kind: 'ssh', host: 'unknown', port: 22, user: 'ops', sudo: true },
  credentialId: null,
  protectedPaths: null,
  writablePaths: null,
  unitAllowlist: null,
};

export interface CommandRating {
  command: string;
  tier: RiskTier;
  reason: string;
}

/** One line of a suggested ```bash block as a command, or null for a blank or comment line. */
export function commandOfLine(line: string): string | null {
  const s = line.trim().replace(/^\$\s+/, '');
  return s && !s.startsWith('#') ? s : null;
}

/**
 * Rate a command an advisory run suggested, with the same engine that gates live
 * runs. Nothing is executed: this tells the person about to paste it into their own
 * terminal whether it only looks, changes something, or could destroy data.
 */
export function rateSuggestedCommand(command: string): CommandRating {
  // Placeholders like <service> are not redirections: rate the command as it will
  // be typed, with a name in their place.
  const verdict = classifyShellCommand(command.replace(/<([\w.:/@-]+)>/g, '$1'), UNSEEN);
  const worst = verdict.contributions.filter((c) => c.tier === verdict.tier).at(-1);
  return { command, tier: verdict.tier, reason: worst?.reason ?? '' };
}
