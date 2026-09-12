import type { ResolvedTarget } from './types.ts';

/** Single-quote for the shell unless the string is already a safe bare word. */
export const shellQuote = (s: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

interface BecomeProfile {
  method: 'none' | 'sudo' | 'su' | 'sudo-su';
  user?: string;
  pty?: boolean;
  template?: string;
}

function profileOf(target: ResolvedTarget): BecomeProfile | null {
  const cfg = target.config;
  if (cfg.kind !== 'ssh') return null;
  const p = cfg.become ?? null;
  if (!p || (p.method === 'none' && !p.template)) return null;
  return p;
}

/** Does this target elevate at all? If so the executor must answer a password prompt. */
export function targetElevates(target: ResolvedTarget): boolean {
  return profileOf(target) !== null;
}

/** The su/sudo account this target becomes, used to pick a password for a bare prompt. */
export function becomeUser(target: ResolvedTarget): string {
  return profileOf(target)?.user ?? '';
}

// A machine-readable sudo prompt. `%p` expands to the account whose password sudo
// is asking for, so the executor can pick the matching stored password even when
// which account gets prompted is not knowable ahead of time. The sentinel is
// stripped from output before anyone (or the model) sees it.
export const SUDO_PROMPT = '[[SUPOPS-SUDO:%p]]';
export const SUDO_PROMPT_RE = /\[\[SUPOPS-SUDO:([^\]]*)\]\]/;
const SUDO = `sudo -S -p '${SUDO_PROMPT}'`;

// sudo option flags that consume the following token as their value.
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-R', '-r', '-t', '-U', '-D']);

/**
 * Strip a redundant leading `sudo`/`su` the model prefixed itself. The target's
 * profile already elevates every command, so wrapping `sudo crontab -l` yields a
 * double-elevation (`sudo su - x -c 'sudo crontab -l'`) whose inner sudo prompts for
 * a password no one can answer. We remove one leading elevation so the command runs
 * under the profile's elevation only. Conservative: only unwraps forms it can read
 * cleanly, leaving anything unusual untouched.
 */
export function stripLeadingElevation(cmd: string): string {
  const toks = cmd.trim().split(/\s+/);
  if (!toks.length) return cmd;
  let i = 0;
  const consumeSudo = () => {
    i++; // the `sudo`/`doas` word
    while (i < toks.length) {
      const a = toks[i]!;
      if (SUDO_VALUE_FLAGS.has(a)) { i += 2; continue; }
      if (a.startsWith('-') || a.includes('=')) { i++; continue; }
      break;
    }
  };
  if (toks[0] === 'sudo' || toks[0] === 'doas') consumeSudo();
  // A leading `su - <user> -c <cmd>` cannot be split back into a bare command without
  // re-parsing shell quoting, so that shape is left untouched.
  const rest = toks.slice(i).join(' ');
  return rest || cmd;
}

/**
 * Wrap a single command for execution on `target`, applying its elevation profile.
 * Pure and deterministic: `render` and `execute` both call this so the classified,
 * displayed, audited and executed strings are identical.
 */
export function wrapCommand(target: ResolvedTarget, inner: string): string {
  const p = profileOf(target);
  if (!p) return inner;
  const elevated = applyMethod(p, stripLeadingElevation(inner));
  // The template COMPOSES with the method rather than replacing it: it wraps the
  // sudo/su-elevated command, so a jump like `ssh -tt loglake2 {{CMD}}` runs the
  // sudo on the far host. With method 'none' it just wraps the bare command.
  return p.template ? p.template.replaceAll('{{CMD}}', shellQuote(elevated)) : elevated;
}

function applyMethod(p: BecomeProfile, inner: string): string {
  switch (p.method) {
    case 'sudo':
      return p.user ? `${SUDO} -u ${shellQuote(p.user)} ${inner}` : `${SUDO} ${inner}`;
    case 'su':
      return `su - ${shellQuote(p.user ?? 'root')} -c ${shellQuote(inner)}`;
    case 'sudo-su':
      return `${SUDO} su - ${shellQuote(p.user ?? 'root')} -c ${shellQuote(inner)}`;
    default:
      return inner;
  }
}

/**
 * Wrap a multi-line script (a heredoc from `ssh_write_file`) for execution under
 * the elevation profile. A script is not a single command, so non-su methods route
 * it through `sh -c`. `ssh_write_file` classifies by destination path (not by
 * lexing this string), so the `sh -c` wrapper does not trip the pipe-to-shell rule.
 */
export function wrapScript(target: ResolvedTarget, script: string): string {
  const p = profileOf(target);
  if (!p) return script;
  const elevated = applyMethodScript(p, script);
  return p.template ? p.template.replaceAll('{{CMD}}', shellQuote(elevated)) : elevated;
}

function applyMethodScript(p: BecomeProfile, script: string): string {
  switch (p.method) {
    case 'sudo':
      return p.user
        ? `${SUDO} -u ${shellQuote(p.user)} sh -c ${shellQuote(script)}`
        : `${SUDO} sh -c ${shellQuote(script)}`;
    case 'su':
      return `su - ${shellQuote(p.user ?? 'root')} -c ${shellQuote(script)}`;
    case 'sudo-su':
      return `${SUDO} su - ${shellQuote(p.user ?? 'root')} -c ${shellQuote(script)}`;
    default:
      return script;
  }
}

/**
 * Pick the elevation password for a prompt. `promptedUser` comes from sudo's `%p`
 * sentinel; for a bare `su` prompt it is the target's become-user. Prefer an exact
 * match, then the wildcard entry (`user: ''`). Returns null when nothing matches --
 * the caller lets the command fail rather than trying a wrong password.
 */
export function pickBecomePassword(
  secrets: Array<{ user: string; value: string }> | undefined,
  promptedUser: string,
): string | null {
  if (!secrets?.length) return null;
  const exact = secrets.find((s) => s.user === promptedUser);
  if (exact) return exact.value;
  const wildcard = secrets.find((s) => s.user === '');
  return wildcard ? wildcard.value : null;
}
