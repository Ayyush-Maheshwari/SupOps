import type { RiskContribution, RiskTier } from '@supops/shared';
import { maxTier } from '@supops/shared';
import type { ResolvedTarget } from '../tools/types.ts';
import { lexShell } from './shell-lex.ts';
import type { RuleHit } from './rule-kit.ts';
import { categoryFor, hit, registerLineClassifier, worst } from './rule-kit.ts';
import { classifyRedirectsActive, classifySimpleCommand, classifyWholeLine, riskRulesMode } from './shell-rules.ts';
import { classifyLine } from './rules-line.ts';

/** A rule's verdict as an audit-trail entry, carrying the kind of harm when known. */
function contribution(h: RuleHit): RiskContribution {
  const category = categoryFor(h);
  return {
    stage: 'arguments',
    tier: h.tier,
    ruleId: h.ruleId,
    reason: h.reason,
    ...(category ? { category } : {}),
    ...(h.irreversible ? { irreversible: true } : {}),
  };
}

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
    contributions.push(contribution(wholeLine));
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
    contributions.push(contribution(verdict));

    const redirect = classifyRedirectsActive(cmd, target);
    if (redirect) {
      contributions.push(contribution(redirect));
    }
  }

  if (riskRulesMode() === 'v2') {
    for (const h of classifyLine(lexed.commands, target)) {
      contributions.push(contribution(h));
    }
  }

  return { tier: maxTier(...contributions.map((c) => c.tier)), contributions };
}

// Nested lines (`ssh host "a && b"`) go through the same pipeline as top-level ones.
registerLineClassifier((line, target) => {
  const verdict = classifyShellCommand(line, target);
  const hits = verdict.contributions.map((c) =>
    hit(c.ruleId ?? 'shell.nested', c.tier, c.reason, { ...(c.category ? { category: c.category } : {}), ...(c.irreversible ? { irreversible: true } : {}) }));
  return hits.length ? worst(hits) : hit('shell.nested.empty', 'high', 'nothing to inspect');
});
