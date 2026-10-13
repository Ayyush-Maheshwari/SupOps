import { lexShell } from './shell-lex.ts';
import { contains, globToRegex, hasGlob, normalise } from './paths.ts';

/**
 * Trusted commands: a person's standing approval. Matching is deliberately narrow --
 * a trusted command is skipped past the approval gate, so anything this cannot read
 * with certainty does not match:
 *
 *  - `exact` compares the command as written, with only the spacing between words
 *    normalised (quoting is kept: `rm '/a/*.gz'` and `rm /a/*.gz` do different things).
 *  - `folder` accepts the same program with the same flags acting on files under one
 *    folder whose names match a pattern. One simple command only: no pipes, `&&`,
 *    redirects, here-documents or background jobs, and every file named in full.
 *
 * The risk tier is never changed here; the engine only skips the wait for a human.
 */

export type TrustedToolKey = 'ssh_exec' | 'k8s_kubectl';
export type TrustEnv = 'dev' | 'staging' | 'prod';

export interface TrustRule {
  toolKey: TrustedToolKey;
  matchKind: 'exact' | 'folder';
  canonical: string;
  program?: string | null;
  flags?: string[] | null;
  folder?: string | null;
  glob?: string | null;
  envs: TrustEnv[];
}

const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-R', '-r', '-t', '-U', '-D']);

/** Split on whitespace outside quotes, keeping each word exactly as written (quotes included). */
function words(input: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i]!;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += c + input[++i]!;
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quote) return null;
  if (cur) out.push(cur);
  return out;
}

/** Drop one leading `sudo`/`doas` (and its flags): the target's own elevation applies anyway. */
function withoutElevation(ws: string[]): string[] {
  if (ws[0] !== 'sudo' && ws[0] !== 'doas') return ws;
  let i = 1;
  while (i < ws.length) {
    const a = ws[i]!;
    if (SUDO_VALUE_FLAGS.has(a)) { i += 2; continue; }
    if (a === '--') { i++; break; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  return ws.slice(i);
}

/** The text a tool call runs, as the trust rules see it: `ssh_exec` command, or `kubectl <args>`. */
export function trustText(toolKey: string, args: Record<string, unknown>): string | null {
  if (toolKey === 'ssh_exec') return typeof args.command === 'string' ? args.command : null;
  if (toolKey === 'k8s_kubectl') return typeof args.args === 'string' ? `kubectl ${args.args.trim().replace(/^kubectl\s+/, '')}` : null;
  return null;
}

/**
 * The command normalised for comparison, or null when it cannot be read with certainty
 * (unbalanced quotes, command substitution and the like): such a command is never trusted.
 */
export function canonicalCommand(command: string): string | null {
  const ws = words(command.trim());
  if (!ws || !ws.length) return null;
  const bare = withoutElevation(ws);
  if (!bare.length) return null;
  const text = bare.join(' ');
  return lexShell(text).ok ? text : null;
}

interface FolderShape {
  program: string;
  flags: string[];
  operands: string[];
}

/** One simple command split into program, flags and file operands; null when it is anything more. */
export function folderShape(command: string): FolderShape | null {
  const canon = canonicalCommand(command);
  if (!canon) return null;
  const lexed = lexShell(canon);
  if (!lexed.ok || lexed.commands.length !== 1) return null;
  const c = lexed.commands[0]!;
  if (c.redirects.length || c.pipedInto || c.pipedFrom || c.background || c.heredoc || c.subshellOpen || c.subshellClose) return null;
  const flags: string[] = [];
  const operands: string[] = [];
  let endOfFlags = false;
  for (const a of c.args) {
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && a.startsWith('-') && a.length > 1) flags.push(a);
    else operands.push(a);
  }
  if (!operands.length) return null;
  return { program: c.name, flags: [...new Set(flags)].sort(), operands };
}

/** Folders a folder rule may never cover: deleting "any matching file" there is never routine. */
const NEVER_FOLDER = ['/etc', '/boot', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/proc', '/sys', '/dev', '/root', '/home'];

export function folderProblem(folder: string, glob: string): string | null {
  const f = normalise(folder);
  if (!folder.startsWith('/')) return 'The folder must be an absolute path.';
  if (hasGlob(folder)) return 'The folder cannot contain wildcards.';
  if (f.split('/').filter(Boolean).length < 2) return 'Choose a more specific folder (at least two levels deep, like /var/log).';
  if (NEVER_FOLDER.some((d) => f === d || f.startsWith(`${d}/`))) return `Files under ${f} cannot be trusted by pattern; trust the exact command instead.`;
  if (!glob.trim() || glob.includes('/')) return 'The file pattern is a name pattern like *.gz, without slashes.';
  return null;
}

/** Does this file operand fall under the rule's folder, with a matching name? */
function operandFits(op: string, folder: string, glob: string): boolean {
  if (!op.startsWith('/') || hasGlob(op) || op.split('/').includes('..')) return false;
  const p = normalise(op);
  if (!contains(folder, p) || p === normalise(folder)) return false;
  const name = p.slice(p.lastIndexOf('/') + 1);
  return globToRegex(glob).test(name);
}

/** The environment a target counts as for trust: a sensitivity-3 target is production whatever its label. */
export function trustEnvOf(target: { env: string; sensitivity?: number }): TrustEnv {
  if ((target.sensitivity ?? 0) >= 3) return 'prod';
  return target.env === 'dev' || target.env === 'staging' ? target.env : 'prod';
}

/** Does a rule cover this command, run with this tool on a target in this environment? */
export function matchesRule(rule: TrustRule, toolKey: string, command: string, env: TrustEnv): boolean {
  if (rule.toolKey !== toolKey || !rule.envs.includes(env)) return false;
  if (rule.matchKind === 'exact') return canonicalCommand(command) === rule.canonical;
  if (toolKey !== 'ssh_exec' || !rule.program || !rule.folder || !rule.glob) return false;
  const shape = folderShape(command);
  if (!shape || shape.program !== rule.program) return false;
  if (shape.flags.join(' ') !== [...(rule.flags ?? [])].sort().join(' ')) return false;
  return shape.operands.every((op) => operandFits(op, rule.folder!, rule.glob!));
}

/**
 * Build a rule from a command someone wants to trust, or say why it cannot be.
 * The forbidden check needs the risk engine, so the caller passes the command's tier.
 */
export function buildTrustRule(input: {
  toolKey: string;
  command: string;
  matchKind: 'exact' | 'folder';
  folder?: string | null;
  glob?: string | null;
  envs: TrustEnv[];
  tier: string;
}): { ok: true; rule: TrustRule } | { ok: false; error: string } {
  if (input.toolKey !== 'ssh_exec' && input.toolKey !== 'k8s_kubectl') return { ok: false, error: 'Only shell and kubectl commands can be trusted.' };
  if (input.tier === 'forbidden') return { ok: false, error: 'This command is forbidden. It can never run, so it cannot be trusted.' };
  const envs = [...new Set(input.envs)].filter((e): e is TrustEnv => e === 'dev' || e === 'staging' || e === 'prod');
  if (!envs.length) return { ok: false, error: 'Choose at least one environment.' };
  const canonical = canonicalCommand(input.command);
  if (!canonical) return { ok: false, error: 'This command cannot be read with certainty (for example it builds part of itself at run time), so it cannot be trusted.' };
  if (input.matchKind === 'exact') return { ok: true, rule: { toolKey: input.toolKey, matchKind: 'exact', canonical, envs } };

  if (input.toolKey !== 'ssh_exec') return { ok: false, error: 'kubectl commands can only be trusted exactly.' };
  const shape = folderShape(input.command);
  if (!shape) return { ok: false, error: 'Only a single command acting on files can be trusted by folder (no pipes, &&, redirects or wildcards). Trust the exact command instead.' };
  const folder = normalise(input.folder ?? '');
  const glob = (input.glob ?? '').trim();
  const problem = folderProblem(input.folder ?? '', glob);
  if (problem) return { ok: false, error: problem };
  const rule: TrustRule = { toolKey: 'ssh_exec', matchKind: 'folder', canonical, program: shape.program, flags: shape.flags, folder, glob, envs };
  if (!matchesRule(rule, 'ssh_exec', input.command, envs[0]!)) {
    return { ok: false, error: `The command itself is not covered: every file it names must be under ${folder} and match ${glob}.` };
  }
  return { ok: true, rule };
}

/** The rule in words, for the UI. */
export function describeTrustRule(rule: Pick<TrustRule, 'matchKind' | 'canonical' | 'program' | 'flags' | 'folder' | 'glob'>): string {
  if (rule.matchKind === 'exact') return rule.canonical;
  return `${[rule.program, ...(rule.flags ?? [])].join(' ')} <any ${rule.glob} under ${rule.folder}/>`;
}
