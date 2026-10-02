import type { RiskTier, ThreatCategory } from '@supops/shared';
import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import { lexShell } from './shell-lex.ts';

/** One rule's verdict on one command. */
export interface RuleHit {
  ruleId: string;
  tier: RiskTier;
  reason: string;
  category?: ThreatCategory;
  irreversible?: boolean;
}

export interface HitExtra {
  category?: ThreatCategory;
  irreversible?: boolean;
}

export const hit = (ruleId: string, tier: RiskTier, reason: string, extra: HitExtra = {}): RuleHit => ({
  ruleId,
  tier,
  reason,
  ...(extra.category ? { category: extra.category } : {}),
  ...(extra.irreversible ? { irreversible: true } : {}),
});

export const RANK: Record<RiskTier, number> = {
  read_only: 0, low: 1, medium: 2, high: 3, forbidden: 4,
};

/** The most severe of several verdicts (first one wins a tie, so the order is stable). */
export function worst(hits: RuleHit[]): RuleHit {
  return hits.reduce((a, b) => (RANK[b.tier] > RANK[a.tier] ? b : a));
}

/** Raise a verdict to at least `floor`, keeping its explanation. */
export function atLeast(h: RuleHit, floor: RiskTier, why?: string): RuleHit {
  if (RANK[h.tier] >= RANK[floor]) return h;
  return { ...h, tier: floor, reason: why ? `${why}: ${h.reason}` : h.reason };
}

/** Production, or explicitly marked highly sensitive. */
export const isProdTarget = (t: ResolvedTarget): boolean => t.env === 'prod' || t.sensitivity >= 3;

/**
 * Irreversible, large-scale destruction -- dropping a database, formatting a disk,
 * deleting a volume or a whole stack. A human can approve it on dev/staging; on
 * production it is never approvable, because no approval can bring the data back.
 */
export function catastrophic(
  target: ResolvedTarget,
  ruleId: string,
  reason: string,
  category: ThreatCategory = 'destruction',
): RuleHit {
  return isProdTarget(target)
    ? hit(ruleId, 'forbidden', `${reason}; irreversible destruction is never approvable on a production target`, { category, irreversible: true })
    : hit(ruleId, 'high', reason, { category, irreversible: true });
}

/** Legacy rules without an explicit category get one from their rule id. */
const CATEGORY_BY_PREFIX: Array<[RegExp, ThreatCategory]> = [
  [/^shell\.(rm|find\.delete|dd|shred|truncate|mkfs|disk|git\.(reset|clean|force)|docker\.(rm|prune|volume)|kubectl\.delete|helm\.uninstall|sql\.(ddl|unqualified))/, 'destruction'],
  [/^shell\.(systemctl\.(stop|disable|mask|poweroff|reboot|halt|isolate)|flat\.(shutdown|reboot|halt|poweroff|init|telinit)|kill|pkill|killall|kubectl\.(scale|drain)|docker\.compose\.down)/, 'availability'],
  [/^shell\.(firewall|net\.)/, 'lockout'],
  [/^shell\.(read\.secret|embedded)/, 'secrets'],
  [/^shell\.(chmod|chown|flat\.(userdel|usermod|useradd|passwd|chpasswd|visudo)|docker\.escape)/, 'privilege'],
  [/^shell\.(history|audit)/, 'anti-forensics'],
  [/^shell\.(pipe-to-shell|base64|curl\.pipe|unknown|unparseable|wrapper|su\.)/, 'code-execution'],
  [/^shell\.(forkbomb)/, 'resource'],
];

export function categoryFor(h: RuleHit): ThreatCategory | undefined {
  if (h.category) return h.category;
  for (const [re, cat] of CATEGORY_BY_PREFIX) if (re.test(h.ruleId)) return cat;
  return undefined;
}

/*
 * Recursion hooks. Rule modules need to classify the commands they wrap (`find -exec`,
 * `ssh host cmd`, `sudo …`), but importing the dispatcher back would make a module
 * cycle. The dispatcher registers itself here instead. Until it has, anything that
 * needs recursion fails closed to `high`.
 */
type CommandClassifier = (cmd: SimpleCommand, target: ResolvedTarget) => RuleHit;
type LineClassifier = (line: string, target: ResolvedTarget) => RuleHit;

let commandClassifier: CommandClassifier | null = null;
let lineClassifier: LineClassifier | null = null;

export function registerCommandClassifier(fn: CommandClassifier): void {
  commandClassifier = fn;
}
export function registerLineClassifier(fn: LineClassifier): void {
  lineClassifier = fn;
}

const unwired = (what: string): RuleHit =>
  hit('shell.unwired', 'high', `${what} could not be inspected; treated as high risk`);

/** Classify one already-parsed command through the full dispatcher. */
export function classifyCommand(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  return commandClassifier ? commandClassifier(cmd, target) : unwired(cmd.name);
}

/**
 * Classify a nested argv. `viaShell` means a shell will re-read it as one line (the
 * remote side of `ssh host a b c` joins its arguments and runs them through a shell);
 * otherwise it is executed directly, as `find -exec` does.
 */
export function classifyArgv(
  argv: string[],
  target: ResolvedTarget,
  label: string,
  viaShell: boolean,
): RuleHit {
  if (!argv.length) return hit('shell.nested.empty', 'high', `${label} with no command to inspect`);
  let verdict: RuleHit;
  if (viaShell) {
    const line = argv.join(' ');
    if (lineClassifier) {
      verdict = lineClassifier(line, target);
    } else {
      const lexed = lexShell(line);
      if (!lexed.ok) return hit('shell.nested.unparseable', 'high', `${label}: could not safely read "${line}" (${lexed.reason})`);
      verdict = worst(lexed.commands.map((c) => classifyCommand(c, target)));
    }
  } else {
    verdict = classifyCommand(
      { name: argv[0]!, args: argv.slice(1), redirects: [], raw: argv.join(' '), pipedInto: false },
      target,
    );
  }
  return { ...verdict, reason: `${label}: ${verdict.reason}` };
}
