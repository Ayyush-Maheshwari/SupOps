import type { RiskContribution, RiskTier } from '@supops/shared';
import { maxTier } from '@supops/shared';
import type { ResolvedTarget } from '../tools/types.ts';
import { lexShell } from './shell-lex.ts';
import { classifyRedirects, classifySimpleCommand, classifyWholeLine } from './shell-rules.ts';

export interface ShellVerdict {
  tier: RiskTier;
  contributions: RiskContribution[];
}

/**
 * Classify a shell command line.
 *
 * Regex over shell text is a losing game -- `rm -rf /` has infinitely many
 * spellings. So we read the line into simple commands and classify each, and any
 * construct we cannot read makes us return `high` rather than guess. The line's
 * tier is the max over everything in it: a read-only command joined to a
 * destructive one by `&&` is exactly as dangerous as the destructive one.
 */
export function classifyShellCommand(
  command: string,
  target: ResolvedTarget,
): ShellVerdict {
  const contributions: RiskContribution[] = [];

  const wholeLine = classifyWholeLine(command);
  if (wholeLine) {
    contributions.push({
      stage: 'arguments',
      tier: wholeLine.tier,
      ruleId: wholeLine.ruleId,
      reason: wholeLine.reason,
    });
    if (wholeLine.tier === 'forbidden') {
      return { tier: 'forbidden', contributions };
    }
  }

  const lexed = lexShell(command);
  if (!lexed.ok) {
    contributions.push({
      stage: 'arguments',
      tier: 'high',
      ruleId: 'shell.unparseable',
      reason:
        `could not safely read this command (${lexed.reason}); ` +
        `unreadable commands are treated as high risk. Split it into separate steps.`,
    });
    return { tier: maxTier('high', ...contributions.map((c) => c.tier)), contributions };
  }

  for (const cmd of lexed.commands) {
    const verdict = classifySimpleCommand(cmd, target);
    contributions.push({
      stage: 'arguments',
      tier: verdict.tier,
      ruleId: verdict.ruleId,
      reason: verdict.reason,
    });

    const redirect = classifyRedirects(cmd, target);
    if (redirect) {
      contributions.push({
        stage: 'arguments',
        tier: redirect.tier,
        ruleId: redirect.ruleId,
        reason: redirect.reason,
      });
    }
  }

  return { tier: maxTier(...contributions.map((c) => c.tier)), contributions };
}
