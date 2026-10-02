import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import type { RuleHit } from './rule-kit.ts';
import { classifyArgv, hit } from './rule-kit.ts';
import { downloadTargets, isEgress } from './rules-net.ts';
import { readsSensitive } from './rules-files.ts';
import { classifyPath, normalise, resolvePaths } from './paths.ts';
import { ctxOf } from './rules-files.ts';
import { DB_BULK_READERS } from './rules-data.ts';

/*
 * Checks that only make sense across a whole command line.
 *
 * Each simple command can look harmless on its own -- `curl URL`, `bash` -- and be
 * dangerous only in combination: the download piped into a shell, the secret read
 * then sent out. Per-command rules cannot see that, so these run after them over the
 * parsed line and can only add verdicts, never remove one.
 */

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'mksh', 'fish', 'csh', 'tcsh']);
const INTERPRETER = /^(python\d*(\.\d+)?|perl|ruby|node|nodejs|php|lua\d*|tclsh|Rscript|pwsh|osascript)$/;
/** Programs that turn their input into something else, hiding what the next stage runs. */
const DECODERS = new Set(['base64', 'base32', 'xxd', 'uudecode', 'openssl', 'gunzip', 'zcat', 'bzcat', 'xzcat', 'rev', 'tr']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nice', 'ionice', 'nohup', 'timeout', 'stdbuf', 'command', 'builtin', 'exec', 'setsid']);

const base = (n: string) => n.split('/').pop() ?? n;

/** The program a command actually runs, looking through sudo/env/nice and their flags. */
export function effectiveName(cmd: SimpleCommand): { name: string; args: string[] } {
  let name = base(cmd.name);
  let args = cmd.args;
  for (let guard = 0; guard < 4 && WRAPPERS.has(name); guard += 1) {
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      if (['-u', '-g', '-p', '-C', '-h', '-n', '-s', '-k', '--user', '--group'].includes(a)) { i += 2; continue; }
      if (a.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a) || (name === 'timeout' && /^[0-9.]+[smhd]?$/.test(a))) { i += 1; continue; }
      break;
    }
    if (i >= args.length) break;
    name = base(args[i]!);
    args = args.slice(i + 1);
  }
  return { name, args };
}

/** Does this interpreter take its program from stdin (no script file, no -c/-e)? */
function readsProgramFromStdin(name: string, args: string[]): boolean {
  if (SHELLS.has(name)) {
    if (args.some((a) => a === '-c' || /^-[a-zA-Z]*c/.test(a))) return false;
    const operand = args.find((a) => !a.startsWith('-') && a !== '-');
    return !operand || args.includes('-s') || args.includes('-');
  }
  if (INTERPRETER.test(name)) {
    if (args.some((a) => ['-c', '-e', '-E', '-r', '--eval', '-p', '--print', '-m'].includes(a))) return false;
    const operand = args.find((a) => !a.startsWith('-'));
    return !operand || operand === '-';
  }
  return false;
}

/** The pipeline `commands[i]` belongs to: the run of commands joined by `|`. */
function pipelineUpTo(commands: SimpleCommand[], i: number): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let j = i;
  while (j > 0 && commands[j]!.pipedFrom) { j -= 1; out.unshift(commands[j]!); }
  return out;
}

const isDownloader = (c: SimpleCommand) => {
  const n = effectiveName(c).name;
  return ['curl', 'wget', 'fetch', 'aria2c', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'telnet', 'openssl', 'tftp', 'ftp', 'lftp', 'git'].includes(n) || /^(aws|gsutil|gcloud|az|rclone)$/.test(n);
};

const BULK_READERS = new Set(['tar', 'zip', 'cpio', 'dd', 'cat', 'rsync', 'gzip', '7z', 'find', ...DB_BULK_READERS]);

/** An archive or dump of a whole system tree (`tar cz /etc`), which carries its secrets with it. */
function readsSystemTree(cmd: SimpleCommand, target: ResolvedTarget): string | null {
  const { name, args } = effectiveName(cmd);
  if (!BULK_READERS.has(name)) return null;
  for (const a of args) {
    const raw = a.replace(/^if=/, '');
    if (!raw.startsWith('/') && !raw.startsWith('~')) continue;
    for (const p of resolvePaths(raw, ctxOf(cmd, target)).paths) {
      const { cls } = classifyPath(p, target, true);
      if (cls === 'root' || cls === 'top' || cls === 'protected' || cls === 'critical' || cls === 'access' || cls === 'device') return a;
    }
  }
  return null;
}

export function classifyLine(commands: SimpleCommand[], target: ResolvedTarget): RuleHit[] {
  const hits: RuleHit[] = [];

  // 1. Pipe receivers: `… | sh`, `… | sudo python3 -`, and heredocs fed to a shell.
  commands.forEach((cmd, i) => {
    const { name, args } = effectiveName(cmd);
    const isShell = SHELLS.has(name);
    if (cmd.heredoc !== undefined && readsProgramFromStdin(name, args)) {
      hits.push(isShell
        ? classifyArgv([cmd.heredoc], target, `${name} <<heredoc`, true)
        : hit('shell.heredoc.interpreter', 'high', `${name} runs a program written inline in a heredoc`, { category: 'code-execution' }));
      return;
    }
    if (!cmd.pipedFrom || !readsProgramFromStdin(name, args)) return;
    const upstream = pipelineUpTo(commands, i);
    const remote = upstream.find(isDownloader);
    const decoded = upstream.find((c) => DECODERS.has(effectiveName(c).name));
    if (remote) {
      hits.push(hit('shell.pipe.remote-code', 'forbidden', `${base(remote.name)} output is piped into ${name}, running code fetched from elsewhere that no one has reviewed`, { category: 'code-execution' }));
    } else if (decoded) {
      hits.push(hit('shell.pipe.decoded-code', 'forbidden', `${base(decoded.name)} output is piped into ${name}, running code that is deliberately unreadable here`, { category: 'code-execution' }));
    } else {
      hits.push(hit('shell.pipe.to-interpreter', 'high', `input is piped into ${name} as a program, so what runs is not visible in the command`, { category: 'code-execution' }));
    }
  });

  // 2. Download, then make executable or run, in the same line.
  const downloaded = new Map<string, string>();
  for (const cmd of commands) {
    const { name, args } = effectiveName(cmd);
    for (const [path, from] of downloaded) {
      const norm = normalise(path);
      const matches = (a: string) => a === path || normalise(a) === norm || base(a) === base(path);
      const runsIt = matches(cmd.name) || matches(name)
        || ((SHELLS.has(name) || INTERPRETER.test(name) || name === 'source' || name === '.') && args.some(matches))
        || (name === 'chmod' && args.some((a) => /\+?[ugoa]*\+[rw]*x|^[0-7]*[1357][0-7]{0,2}$/.test(a)) && args.some(matches))
        || (['dpkg', 'rpm', 'apt', 'apt-get', 'dnf', 'yum', 'insmod', 'crontab'].includes(name) && args.some(matches));
      if (runsIt) {
        hits.push(hit('shell.download-exec', 'forbidden', `${path} is downloaded by ${from} and then executed or installed in the same command: unreviewed remote code`, { category: 'code-execution' }));
      }
    }
    for (const p of downloadTargets(cmd)) downloaded.set(p, base(cmd.name));
  }

  // 3. Exfiltration: credential material read, and something that sends data off the host.
  const reader = commands
    .map((c) => ({ c, path: DB_BULK_READERS.includes(effectiveName(c).name) ? 'the database contents' : (readsSensitive(c, target) ?? readsSystemTree(c, target)) }))
    .find((r) => r.path);
  const sender = commands.find((c) => isEgress(c));
  if (reader && sender && reader.c !== sender) {
    hits.push(hit('shell.exfil.line', 'forbidden', `the command reads credential or system material (${reader.path}) and sends data off the host with ${base(sender.name)}`, { category: 'exfiltration' }));
  } else if (reader && sender) {
    hits.push(hit('shell.exfil.self', 'forbidden', `${base(sender.name)} sends credential material (${reader.path}) off the host`, { category: 'exfiltration' }));
  }

  // 4. Detached jobs outlive the run and its approval.
  for (const cmd of commands) {
    const { name } = effectiveName(cmd);
    if (cmd.background || base(cmd.name) === 'nohup' || base(cmd.name) === 'setsid') {
      hits.push(hit('shell.background', 'medium', `${name} is started in the background and keeps running after this step finishes`, { category: 'persistence' }));
    }
  }

  return hits;
}

/**
 * `bash -c "<line>"` / `sh -c`: the string is re-read as a line and judged on what
 * it contains. Anything else a shell is asked to run (a script file, an interactive
 * session) is not visible here.
 */
export function classifyShellInvocation(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = base(cmd.name);
  const args = cmd.args;
  const ci = args.findIndex((a) => a === '-c' || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
  if (ci >= 0) {
    const script = args[ci + 1];
    if (script === undefined) return hit('shell.sh.c-empty', 'high', `${name} -c with no command to inspect`);
    return classifyArgv([script], target, `${name} -c`, true);
  }
  if (readsProgramFromStdin(name, args)) {
    // Piped input and heredocs are judged by classifyLine; an unfed shell is interactive.
    if (cmd.pipedFrom || cmd.heredoc !== undefined) return hit('shell.sh.stdin', 'read_only', `${name} reading a program from its input (judged with the rest of the line)`);
    return hit('shell.sh.interactive', 'high', `${name} with no command opens a shell whose input is not visible here`, { category: 'code-execution' });
  }
  const script = args.find((a) => !a.startsWith('-'));
  return hit('shell.sh.script', 'high', `${name} ${script ?? ''} runs a script whose contents are not visible in the command`, { category: 'code-execution' });
}
