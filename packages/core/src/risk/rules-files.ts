import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import type { RuleHit } from './rule-kit.ts';
import { atLeast, classifyCommand, hit, worst } from './rule-kit.ts';
import {
  classifyPath, hasGlob, isAccessPath, isAuditPath, isCriticalFile, isDevicePath, isHarmlessSink,
  isNetworkDevice, isProtectedPath, isWritablePath, normalise, resolvePaths,
} from './paths.ts';
import type { PathContext } from './paths.ts';

/*
 * Rules for commands that delete, move, overwrite or re-permission files.
 *
 * Every one of them judges a path the same way (see paths.ts): resolved against a
 * known cwd and `~`, brace-expanded, and matched as a glob against what matters, so
 * `rm -rf /.`, `rm -rf /etc/..`, `rm -rf /{etc,usr}` and `cd / && rm -rf *` all read
 * as what they are. Consistency is the point: a rule that protects `/etc` from `rm`
 * but not from `mv`, `shred` or `chmod -R` is a rule with a hole in it.
 */

export const ctxOf = (cmd: SimpleCommand, target: ResolvedTarget): PathContext => ({ cwd: cmd.cwd ?? null, target });

/** Split argv into flags and operands, honouring `--`. */
export function operands(args: string[], valueFlags: string[] = []): { flags: string[]; ops: string[] } {
  const flags: string[] = [];
  const ops: string[] = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (endOfFlags) { ops.push(a); continue; }
    if (a === '--') { endOfFlags = true; continue; }
    if (a.startsWith('-') && a.length > 1) {
      flags.push(a);
      if (valueFlags.includes(a) && i + 1 < args.length) flags.push(args[++i]!);
      continue;
    }
    ops.push(a);
  }
  return { flags, ops };
}

const shortFlags = (flags: string[]) => flags.filter((f) => /^-[^-]/.test(f)).map((f) => f.slice(1)).join('');

// ---- secrets ---------------------------------------------------------------

/** Paths whose contents are login/credential material -- reading them must be gated. */
const SENSITIVE_READ_PATTERNS: RegExp[] = [
  /\/\.ssh\//i, // anything under ~/.ssh
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)\b/i, // private keys by name
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|asc|gpg)$/i, // key/cert/secret stores
  /\/\.aws\//i, /\/\.azure\//i, /\/\.config\/gcloud\//i, /\/\.gnupg\//i, // cloud + gpg credentials
  /\/\.kube\//i, /kubeconfig/i, /\/etc\/kubernetes\/(admin|kubelet|controller-manager|scheduler)\.conf$/i,
  /\/etc\/kubernetes\/pki\//i, /\/etc\/rancher\/k3s\/k3s\.yaml$/i, /\/var\/lib\/rancher\/k3s\/server\/(token|cred|tls)/i,
  /(^|\/)\.env(\.|$)/i, // .env files
  /(^|\/)\.netrc$/i, /(^|\/)\.pgpass$/i, /(^|\/)\.my\.cnf$/i, /(^|\/)\.git-credentials$/i,
  /(^|\/)\.docker\/config\.json$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.pypirc$/i, /(^|\/)\.vault-token$/i,
  /(^|\/)terraform\.tfstate(\.backup)?$/i, /\.tfvars$/i, /(^|\/)wp-config\.php$/i,
  /(^|\/)\.?htpasswd$/i, /(^|\/)credentials(\.|$)/i,
  /\/etc\/(shadow|gshadow|sudoers|security\/opasswd)/i, /\/etc\/ssl\/private\//i, // system secrets
  /\/proc\/[^/]+\/(environ|mem|maps)$/i, /\/proc\/kcore$/i, /^\/dev\/(mem|kmem)$/i,
  /(^|\/)\.(bash|zsh|mysql|psql|python)_history$/i,
  /(^|\/)secrets?\//i, /\/vault\//i,
];

export function isSensitiveReadPath(arg: string): boolean {
  if (arg.startsWith('-')) return false; // a flag, not a path
  const p = arg.replace(/^['"]|['"]$/g, '').replace(/^file:\/\//, '');
  return SENSITIVE_READ_PATTERNS.some((re) => re.test(p));
}

/** Does this command read credential material (from a path argument or stdin redirect)? */
export function readsSensitive(cmd: SimpleCommand, target: ResolvedTarget): string | null {
  for (const a of cmd.args) {
    for (const p of resolvePaths(a.replace(/^[^=@]*[=@](?=\/|~)/, ''), ctxOf(cmd, target)).paths) {
      if (isSensitiveReadPath(p) || isSensitiveReadPath(a)) return a;
    }
  }
  const input = cmd.redirects.find((r) => r.op === '<' && isSensitiveReadPath(r.path));
  return input ? input.path : null;
}

// ---- writes ----------------------------------------------------------------

/** Files that, appended to, grant access, privilege or code that runs later. */
const PERSISTENCE_APPEND: RegExp[] = [
  /(^|\/)\.(bashrc|bash_profile|profile|zshrc|zprofile|bash_login|bash_logout)$/,
  /^\/etc\/(profile|bash\.bashrc|environment|rc\.local|crontab)$/, /^\/etc\/profile\.d\//,
  /^\/etc\/cron\.(d|daily|hourly|weekly|monthly)\//, /^\/var\/spool\/cron\//,
  /^\/etc\/systemd\/system\//, /^\/lib\/systemd\/system\//, /^\/etc\/init\.d\//,
];

/** Kernel control files: one write reboots, crashes or re-tunes the running host. */
const KERNEL_WRITE = /^\/proc\/(sysrq-trigger|sys\/)|^\/sys\//;

/**
 * How dangerous is writing to `raw`? `mode` distinguishes replacing a file's contents
 * (`>`, `tee`, `cp` onto it), adding to it (`>>`, `tee -a`) and editing it in place
 * (`sed -i`). Returns null for the harmless sinks (/dev/null, `2>&1`).
 */
export function classifyWrite(
  raw: string,
  mode: 'overwrite' | 'append' | 'edit',
  cmd: SimpleCommand,
  target: ResolvedTarget,
  via: string,
): RuleHit | null {
  if (isHarmlessSink(raw)) return null;
  if (isNetworkDevice(raw)) {
    return hit('shell.write.network', 'forbidden', `${via} opens a network socket (${raw}): the classic reverse-shell / exfiltration channel`, { category: 'exfiltration' });
  }
  const { paths, unknown } = resolvePaths(raw, ctxOf(cmd, target));
  const hits: RuleHit[] = [];
  for (const p of paths) {
    if (p === '/proc/sysrq-trigger') {
      hits.push(hit('shell.write.sysrq', 'forbidden', `${via} writes to /proc/sysrq-trigger, which instantly crashes, reboots or powers off the host`, { category: 'availability' }));
      continue;
    }
    if (isDevicePath(p)) {
      hits.push(hit('shell.write.device', 'forbidden', `${via} writes directly to device ${p}`, { category: 'destruction', irreversible: true }));
      continue;
    }
    if (KERNEL_WRITE.test(p)) {
      hits.push(hit('shell.write.kernel', 'high', `${via} changes live kernel settings (${p})`, { category: 'integrity' }));
      continue;
    }
    if (p === '/etc/ld.so.preload') {
      hits.push(hit('shell.write.preload', 'forbidden', `${via} writes /etc/ld.so.preload, which injects a library into every process (a rootkit technique)`, { category: 'persistence' }));
      continue;
    }
    if (isAuditPath(p)) {
      hits.push(mode === 'append'
        ? hit('shell.write.audit-append', 'high', `${via} appends to audit evidence (${p}), which can forge log entries`, { category: 'anti-forensics' })
        : hit('shell.write.audit', 'forbidden', `${via} rewrites audit evidence (${p}); destroying logs of what happened is never a fix`, { category: 'anti-forensics', irreversible: true }));
      continue;
    }
    if (isAccessPath(p, target) && /authorized_keys2?$/.test(p)) {
      hits.push(mode === 'append'
        ? hit('shell.write.authkeys-append', 'high', `${via} adds a key to ${p}, granting new SSH access`, { category: 'persistence' })
        : hit('shell.write.authkeys', 'forbidden', `${via} replaces ${p}, which would drop the key SupOps logs in with`, { category: 'lockout' }));
      continue;
    }
    if (isCriticalFile(p)) {
      const bricking = /^\/etc\/(passwd|shadow|group|gshadow|sudoers|fstab|crypttab)$|^\/etc\/pam\.d|^\/boot|^\/(usr\/)?s?bin\/|^\/lib\//.test(p);
      if (mode === 'overwrite' && bricking) {
        hits.push(hit('shell.write.critical', 'forbidden', `${via} overwrites ${p}; replacing it wholesale can stop the host booting or anyone logging in`, { category: 'lockout', irreversible: true }));
      } else if (mode === 'append' && /^\/etc\/(passwd|shadow|group|sudoers)|^\/etc\/sudoers\.d\//.test(p)) {
        hits.push(hit('shell.write.privilege', 'high', `${via} appends to ${p}, which adds accounts or sudo rights`, { category: 'privilege' }));
      } else {
        hits.push(hit('shell.write.critical-edit', 'high', `${via} changes ${p}; a mistake here can lock everyone out`, { category: /ssh/.test(p) ? 'lockout' : 'integrity' }));
      }
      continue;
    }
    if (mode === 'append' && PERSISTENCE_APPEND.some((re) => re.test(p))) {
      hits.push(hit('shell.write.persistence', 'high', `${via} appends to ${p}, which runs code at login, boot or on a schedule`, { category: 'persistence' }));
      continue;
    }
    if (isProtectedPath(p, target)) {
      hits.push(hit('shell.write.protected', 'high', `${via} writes into protected path ${p}`, { category: 'integrity' }));
      continue;
    }
    if (isWritablePath(p, target)) continue;
    hits.push(hit('shell.write.file', mode === 'append' ? 'low' : 'medium', `${via} writes ${p}`, { category: 'integrity' }));
  }
  if (unknown && !hits.length) hits.push(hit('shell.write.relative', 'medium', `${via} writes ${raw} (a path whose location isn't known from the command)`, { category: 'integrity' }));
  return hits.length ? worst(hits) : null;
}

/** Redirections write files regardless of what the command itself does. */
export function classifyRedirects(cmd: SimpleCommand, target: ResolvedTarget): RuleHit | null {
  const hits: RuleHit[] = [];
  for (const r of cmd.redirects) {
    if (r.dup) continue;
    if (r.op === '<' || r.op === '<<' || r.op === '<<<' || r.op === '<&') {
      if (isNetworkDevice(r.path)) {
        hits.push(hit('shell.redirect.network-in', 'forbidden', `reading from a network socket (${r.path}) feeds remote input into the command`, { category: 'code-execution' }));
      }
      continue;
    }
    const mode = r.op === '>>' || r.op === '&>>' ? 'append' : 'overwrite';
    const h = classifyWrite(r.path, mode, cmd, target, `redirecting output (${r.op})`);
    if (h) hits.push({ ...h, ruleId: h.ruleId.replace(/^shell\.write\./, 'shell.redirect.') });
  }
  return hits.length ? worst(hits) : null;
}

// ---- delete ----------------------------------------------------------------

export function classifyRm(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args);
  const sf = shortFlags(flags);
  const recursive = /[rR]/.test(sf) || flags.includes('--recursive');
  const force = sf.includes('f') || flags.includes('--force');
  if (flags.includes('--no-preserve-root')) {
    return hit('shell.rm.no-preserve-root', 'forbidden', 'rm --no-preserve-root exists only to delete the root filesystem', { category: 'destruction', irreversible: true });
  }

  const hits: RuleHit[] = [];
  let anyGlob = false;
  let allScratch = ops.length > 0;
  let unknownPath = false;
  for (const op of ops) {
    // `rm -rf "$DIR"/` deletes from / when DIR is empty or unset (the Steam bug).
    if (recursive && /^\$[A-Za-z_]\w*\/\*?$/.test(op)) {
      hits.push(hit('shell.rm.empty-var', 'forbidden', `rm -r ${op}: if the variable is empty or unset this deletes from /`, { category: 'destruction', irreversible: true }));
      continue;
    }
    const { paths, unknown } = resolvePaths(op, ctxOf(cmd, target));
    if (unknown) unknownPath = true;
    for (const p of paths) {
      if (hasGlob(p)) anyGlob = true;
      const { cls, what } = classifyPath(p, target, recursive);
      if (cls !== 'scratch') allScratch = false;
      switch (cls) {
        case 'root': hits.push(hit('shell.rm.root', 'forbidden', `rm targeting ${op} destroys the host`, { category: 'destruction', irreversible: true })); break;
        case 'top': hits.push(recursive
          ? hit('shell.rm.top', 'forbidden', `recursive rm of ${what} removes a whole system directory`, { category: 'destruction', irreversible: true })
          : hit('shell.rm.top-file', 'high', `rm of system directory ${what}`, { category: 'destruction' })); break;
        case 'device': hits.push(hit('shell.rm.device', 'forbidden', `rm of device node ${what}`, { category: 'destruction' })); break;
        case 'critical': hits.push(hit('shell.rm.critical', 'forbidden', `rm of ${what}, without which the host cannot boot or authenticate anyone`, { category: 'lockout', irreversible: true })); break;
        case 'access': hits.push(hit('shell.rm.access', 'forbidden', `rm of ${what} removes the SSH access SupOps (and people) log in with`, { category: 'lockout', irreversible: true })); break;
        case 'audit': hits.push(hit('shell.rm.audit', 'forbidden', `rm of ${what} destroys audit evidence`, { category: 'anti-forensics', irreversible: true })); break;
        case 'protected': hits.push(recursive
          ? hit('shell.rm.protected', 'forbidden', `recursive rm of protected path ${what}`, { category: 'destruction', irreversible: true })
          : hit('shell.rm.protected-file', 'high', `rm of a protected path (${what})`, { category: 'destruction', irreversible: true })); break;
        default: break;
      }
    }
  }
  if (hits.length) {
    const w = worst(hits);
    if (w.tier === 'forbidden') return w;
    if (!recursive && !anyGlob) return w;
  }
  if (recursive) {
    return hit('shell.rm.recursive', 'high', `recursive rm (${flags.join(' ')}) of ${ops.join(', ') || '(no path)'} has unbounded blast radius`, { category: 'destruction', irreversible: true });
  }
  if (anyGlob) {
    return hit('shell.rm.glob', 'high', `rm with a glob (${ops.join(' ')}) matches an unknown set of files`, { category: 'destruction', irreversible: true });
  }
  if (allScratch && !unknownPath) {
    return hit('shell.rm.scratch', 'medium', `rm of specific files under a scratch path (${ops.join(' ')})`, { category: 'destruction' });
  }
  return hit('shell.rm.file', 'high', `rm of ${ops.join(' ') || '(no path)'}${force ? ' with -f' : ''}`, { category: 'destruction', irreversible: true });
}

/** Tokens that narrow which files `find` selects. */
const FIND_FILTERS = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-mtime', '-mmin',
  '-ctime', '-cmin', '-atime', '-amin', '-size', '-newer', '-user', '-group', '-perm', '-empty', '-links', '-inum',
  '-lname', '-ilname', '-samefile', '-uid', '-gid', '-nouser', '-nogroup',
]);
const AUDIT_NAMES = /auth\.log|secure|wtmp|btmp|lastlog|faillog|audit|_history|journal/i;

export function classifyFind(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const firstExpr = cmd.args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!' || a === '\\(');
  const starts = (firstExpr < 0 ? cmd.args : cmd.args.slice(0, firstExpr)).filter((a) => !/^-[HLP]$/.test(a));
  const roots = starts.length ? starts : ['.'];
  const expr = firstExpr < 0 ? [] : cmd.args.slice(firstExpr);
  const filtered = expr.some((a) => FIND_FILTERS.has(a));
  const namesAudit = expr.some((a, i) => ['-name', '-iname', '-path', '-ipath', '-regex'].includes(expr[i - 1] ?? '') && AUDIT_NAMES.test(a));
  const resolved = roots.flatMap((r) => resolvePaths(r, ctxOf(cmd, target)).paths);
  const hits: RuleHit[] = [];

  if (expr.includes('-delete')) {
    if (namesAudit) {
      hits.push(hit('shell.find.delete.audit', 'forbidden', 'find -delete aimed at audit logs or shell history', { category: 'anti-forensics', irreversible: true }));
    }
    for (const p of resolved) {
      const { cls, what } = classifyPath(p, target, true);
      if (!filtered && ['root', 'top', 'protected', 'critical', 'access', 'audit', 'device'].includes(cls)) {
        hits.push(hit('shell.find.delete.unbounded', 'forbidden', `find ${what} -delete with no filter deletes everything under it`, { category: 'destruction', irreversible: true }));
      } else if (['access', 'audit', 'critical'].includes(cls)) {
        hits.push(hit(`shell.find.delete.${cls}`, 'forbidden', `find -delete under ${what}`, { category: cls === 'audit' ? 'anti-forensics' : 'lockout', irreversible: true }));
      }
    }
    hits.push(hit('shell.find.delete', 'high', `find -delete removes every match${filtered ? '' : ' (no filter)'}`, { category: 'destruction', irreversible: true }));
  }

  // -exec / -execdir / -ok: classify the command it runs, with `{}` standing for the
  // matches -- the start path itself when nothing narrows the selection.
  for (let i = 0; i < expr.length; i += 1) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(expr[i]!)) continue;
    const end = expr.findIndex((a, j) => j > i && (a === ';' || a === '\\;' || a === '+'));
    const inner = expr.slice(i + 1, end < 0 ? undefined : end);
    i = end < 0 ? expr.length : end;
    if (!inner.length) { hits.push(hit('shell.find.exec', 'high', 'find -exec with an opaque command', { category: 'code-execution' })); continue; }
    for (const root of resolved.length ? resolved : ['.']) {
      const stand = filtered ? `${root.replace(/\/$/, '')}/__match__` : root;
      const argv = inner.map((a) => a.replaceAll('{}', stand));
      const innerHit = classifyCommand({ name: argv[0]!, args: argv.slice(1), redirects: [], raw: argv.join(' '), pipedInto: false, cwd: cmd.cwd ?? null }, target);
      // -exec runs the inner command once per match, so its blast radius is at least
      // as large as the inner command's and usually much larger.
      hits.push(innerHit.tier === 'read_only'
        ? { ...innerHit, reason: `find -exec: ${innerHit.reason}` }
        : atLeast({ ...innerHit, ruleId: innerHit.tier === 'forbidden' ? innerHit.ruleId : 'shell.find.exec', reason: `find -exec runs "${inner.join(' ')}" for every match: ${innerHit.reason}` }, 'high'));
    }
  }

  for (let i = 0; i < expr.length; i += 1) {
    if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(expr[i]!) && expr[i + 1]) {
      const w = classifyWrite(expr[i + 1]!, 'overwrite', cmd, target, `find ${expr[i]}`);
      if (w) hits.push(w);
    }
  }
  return hits.length ? worst(hits) : hit('shell.find.read', 'read_only', 'find without -delete or -exec only lists files');
}

// ---- move / copy / link ------------------------------------------------------

export function classifyMove(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args, ['-t', '--target-directory', '-S', '--suffix']);
  const tIdx = flags.findIndex((f) => f === '-t' || f === '--target-directory');
  const dest = tIdx >= 0 ? flags[tIdx + 1] : ops[ops.length - 1];
  const sources = tIdx >= 0 ? ops : ops.slice(0, -1);
  const hits: RuleHit[] = [];
  let sourcesSafe = true;
  for (const s of sources) {
    for (const p of resolvePaths(s, ctxOf(cmd, target)).paths) {
      const { cls, what } = classifyPath(p, target, true);
      if (cls !== 'scratch') sourcesSafe = false;
      if (cls === 'root' || cls === 'top') hits.push(hit('shell.mv.top', 'forbidden', `mv of ${what} moves a whole system directory out from under the host`, { category: 'destruction' }));
      else if (cls === 'critical') hits.push(hit('shell.mv.critical', 'forbidden', `mv of ${what} leaves the host unable to boot or authenticate`, { category: 'lockout' }));
      else if (cls === 'access') hits.push(hit('shell.mv.access', 'forbidden', `mv of ${what} removes the SSH access SupOps logs in with`, { category: 'lockout' }));
      else if (cls === 'audit') hits.push(hit('shell.mv.audit', 'forbidden', `mv of ${what} hides audit evidence`, { category: 'anti-forensics' }));
      else if (cls === 'device') hits.push(hit('shell.mv.device', 'forbidden', `mv of device node ${what}`, { category: 'destruction' }));
      else if (cls === 'protected') hits.push(hit('shell.mv.protected-source', 'high', `mv of protected path ${what}`, { category: 'integrity' }));
    }
  }
  if (dest) {
    const w = classifyWrite(dest, 'overwrite', cmd, target, 'mv');
    if (w && w.tier !== 'medium' && w.tier !== 'low') hits.push({ ...w, ruleId: w.ruleId.replace('shell.write.', 'shell.mv.') });
    const writable = resolvePaths(dest, ctxOf(cmd, target)).paths.every((p) => isWritablePath(p, target));
    if (!hits.length) {
      return writable && sourcesSafe
        ? hit('shell.mv.writable', 'low', `mv into a writable path (${dest})`, { category: 'integrity' })
        : hit('shell.mv', 'medium', `mv ${cmd.args.join(' ')} modifies the filesystem`, { category: 'integrity' });
    }
  }
  return hits.length ? worst(hits) : hit('shell.mv', 'medium', `mv ${cmd.args.join(' ')} modifies the filesystem`, { category: 'integrity' });
}

export function classifyCopy(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args, ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']);
  const name = cmd.name.split('/').pop()!;
  const tIdx = flags.findIndex((f) => f === '-t' || f === '--target-directory');
  const dest = tIdx >= 0 ? flags[tIdx + 1] : ops[ops.length - 1];
  const sources = tIdx >= 0 ? ops : ops.slice(0, -1);
  const hits: RuleHit[] = [];
  const empties = sources.some((s) => /^\/dev\/(null|zero)$/.test(s));
  const secret = sources.find((s) => isSensitiveReadPath(s));
  if (dest) {
    const w = classifyWrite(dest, 'overwrite', cmd, target, name);
    if (w) {
      // Copying /dev/null over a critical file is emptying it.
      if (empties && (w.ruleId === 'shell.write.critical-edit' || w.ruleId === 'shell.write.protected')) {
        hits.push(hit(`shell.${name}.empty-critical`, 'forbidden', `${name} of /dev/null over ${dest} empties it`, { category: 'destruction', irreversible: true }));
      }
      hits.push({ ...w, ruleId: w.ruleId.replace('shell.write.', `shell.${name}.`) });
    }
    if (secret && !resolvePaths(dest, ctxOf(cmd, target)).paths.every((p) => isProtectedPath(p, target))) {
      hits.push(hit(`shell.${name}.secret`, 'high', `${name} copies credential material (${secret}) to ${dest}, outside the protected location`, { category: 'secrets' }));
    }
  }
  if (!hits.length && dest && resolvePaths(dest, ctxOf(cmd, target)).paths.every((p) => isWritablePath(p, target))) {
    return hit(`shell.${name}.writable`, 'low', `${name} into a writable path (${dest})`, { category: 'integrity' });
  }
  return hits.length ? worst(hits) : hit(`shell.${name}`, 'medium', `${name} ${cmd.args.join(' ')} modifies the filesystem`, { category: 'integrity' });
}

export function classifyLink(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args, ['-t', '--target-directory', '-S', '--suffix']);
  const force = /f/.test(shortFlags(flags)) || flags.includes('--force');
  const link = ops.length > 1 ? ops[ops.length - 1]! : null;
  const src = ops[0] ?? '';
  if (!link) return hit('shell.ln', 'low', 'ln creates a link in the current directory', { category: 'integrity' });
  const blanking = /^\/dev\/null$/.test(src);
  for (const p of resolvePaths(link, ctxOf(cmd, target)).paths) {
    if (isAuditPath(p) && blanking) return hit('shell.ln.audit', 'forbidden', `ln -s /dev/null ${link} silently discards audit/history from now on`, { category: 'anti-forensics' });
    if ((isCriticalFile(p) || isAccessPath(p, target)) && force) {
      return blanking
        ? hit('shell.ln.critical-blank', 'forbidden', `ln -sf /dev/null over ${link} empties it`, { category: 'lockout', irreversible: true })
        : hit('shell.ln.critical', 'high', `ln -sf replaces ${link} with a link to ${src}`, { category: 'integrity' });
    }
  }
  const w = classifyWrite(link, 'overwrite', cmd, target, 'ln');
  if (w && (w.tier === 'high' || w.tier === 'forbidden')) return { ...w, ruleId: w.ruleId.replace('shell.write.', 'shell.ln.') };
  return resolvePaths(link, ctxOf(cmd, target)).paths.every((p) => isWritablePath(p, target))
    ? hit('shell.ln.writable', 'low', `ln into a writable path (${link})`, { category: 'integrity' })
    : hit('shell.ln', 'medium', `ln ${cmd.args.join(' ')} replaces or creates a link`, { category: 'integrity' });
}

// ---- permissions ------------------------------------------------------------

/** Binaries that give a root shell when setuid (GTFOBins). */
const SUID_SHELLS = /^(ba|da|z|k|c|tc|fi|a)?sh$|^(python|perl|ruby|node|php|lua|tclsh|expect|gdb|vim?|nvim|nano|less|more|man|find|awk|gawk|mawk|env|nice|timeout|stdbuf|taskset|cp|mv|tar|zip|unzip|rsync|dd|tee|docker|nmap|busybox|socat|nc|ncat|sudo|su|bash|sed|xargs|git|make|screen|tmux|openssl|curl|wget|journalctl|systemctl)\d*(\.\d+)?$/;

interface Mode { suid: boolean; worldWrite: boolean; groupWrite: boolean; none: boolean; wide: boolean }

function parseMode(mode: string): Mode {
  if (/^[0-7]{3,4}$/.test(mode)) {
    const m = mode.padStart(4, '0');
    const special = Number(m[0]);
    const o = Number(m[3]);
    const g = Number(m[2]);
    return { suid: (special & 6) !== 0, worldWrite: (o & 2) !== 0, groupWrite: (g & 2) !== 0, none: m.slice(1) === '000', wide: m.slice(1) === '777' };
  }
  const clauses = mode.split(',');
  const has = (re: RegExp) => clauses.some((c) => re.test(c));
  return {
    suid: has(/^[ugoa]*[+=][rwxXt]*s/),
    worldWrite: has(/^[oa]*[+=][^-]*w/) || has(/^[+=][^-]*w/) && has(/^a/),
    groupWrite: has(/^[ug]*g[ug]*[+=][^-]*w/),
    none: has(/^[ugoa]*-[rwx]{3}$/) || has(/^[ugoa]*=$/),
    wide: has(/^a?[+=]rwx$/),
  };
}

export function classifyChmod(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args);
  const recursive = /R/.test(shortFlags(flags)) || flags.includes('--recursive');
  const reference = flags.some((f) => f.startsWith('--reference'));
  const modeStr = reference ? '' : (ops[0] ?? '');
  const mode = parseMode(modeStr);
  const paths = reference ? ops : ops.slice(1);
  const hits: RuleHit[] = [];
  let allWritable = paths.length > 0;

  for (const raw of paths) {
    for (const p of resolvePaths(raw, ctxOf(cmd, target)).paths) {
      if (!isWritablePath(p, target)) allWritable = false;
      const { cls, what } = classifyPath(p, target, recursive);
      const base = p.split('/').pop() ?? '';
      if (mode.suid && SUID_SHELLS.test(base)) {
        hits.push(hit('shell.chmod.suid-shell', 'forbidden', `setuid on ${p} hands any user a root shell`, { category: 'privilege' }));
      } else if (mode.suid) {
        hits.push(hit('shell.chmod.suid', 'high', `setuid/setgid on ${p} lets it run with its owner's privileges`, { category: 'privilege' }));
      }
      if (cls === 'root' || cls === 'top') {
        if (recursive) hits.push(hit('shell.chmod.recursive-top', 'forbidden', `recursive chmod of ${what} rewrites permissions across a whole system directory`, { category: 'privilege', irreversible: true }));
        else if (mode.none || mode.wide || mode.worldWrite) hits.push(hit('shell.chmod.top', 'forbidden', `chmod ${modeStr} of ${what}`, { category: 'privilege' }));
      } else if (cls === 'critical' && (mode.worldWrite || mode.none || mode.groupWrite || mode.wide)) {
        hits.push(hit('shell.chmod.critical', 'forbidden', `chmod ${modeStr} on ${what} either exposes it to every user or breaks authentication`, { category: 'privilege' }));
      } else if (cls === 'access' && (mode.worldWrite || mode.groupWrite || mode.none || mode.wide)) {
        hits.push(hit('shell.chmod.access', 'forbidden', `chmod ${modeStr} on ${what}: sshd refuses keys when these are writable by others, locking SupOps out`, { category: 'lockout' }));
      } else if (cls === 'protected' && recursive) {
        hits.push(hit('shell.chmod.recursive-protected', 'forbidden', `recursive chmod of ${what}`, { category: 'privilege', irreversible: true }));
      } else if (cls === 'protected' || cls === 'critical') {
        hits.push(hit('shell.chmod.protected', 'high', `chmod of a protected path (${what})`, { category: 'privilege' }));
      }
    }
  }
  if (mode.wide) hits.push(hit('shell.chmod.777', 'high', 'chmod 777 makes a path world-writable', { category: 'privilege' }));
  if (mode.none) hits.push(hit('shell.chmod.000', 'high', 'chmod 000 removes all access', { category: 'availability' }));
  if (hits.length) return worst(hits);
  if (recursive) return hit('shell.chmod.recursive', 'high', `recursive chmod of ${paths.join(' ')}`, { category: 'privilege' });
  if (allWritable) return hit('shell.chmod.writable', 'low', `chmod within the target's writable paths (${paths.join(' ')})`, { category: 'privilege' });
  return hit('shell.chmod', 'medium', `chmod ${cmd.args.join(' ')}`, { category: 'privilege' });
}

export function classifyChown(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args);
  const name = cmd.name.split('/').pop()!;
  const recursive = /R/.test(shortFlags(flags)) || flags.includes('--recursive');
  const reference = flags.some((f) => f.startsWith('--reference'));
  const owner = reference ? '' : (ops[0] ?? '');
  const paths = reference ? ops : ops.slice(1);
  const toRoot = /^(root|0)?(:(root|0)?)?$/.test(owner);
  const hits: RuleHit[] = [];
  let allWritable = paths.length > 0;
  for (const raw of paths) {
    for (const p of resolvePaths(raw, ctxOf(cmd, target)).paths) {
      if (!isWritablePath(p, target)) allWritable = false;
      const { cls, what } = classifyPath(p, target, recursive);
      if ((cls === 'root' || cls === 'top') && recursive) hits.push(hit(`shell.${name}.recursive-top`, 'forbidden', `recursive ${name} of ${what}`, { category: 'privilege', irreversible: true }));
      else if (cls === 'critical' && !toRoot) hits.push(hit(`shell.${name}.critical`, 'forbidden', `${name} ${owner} ${what} hands a security-critical file to a non-root owner`, { category: 'privilege' }));
      else if (cls === 'access') hits.push(hit(`shell.${name}.access`, 'high', `${name} of ${what} can break the SSH access SupOps uses`, { category: 'lockout' }));
      else if (cls === 'protected' && recursive) hits.push(hit(`shell.${name}.recursive-protected`, 'forbidden', `recursive ${name} of ${what}`, { category: 'privilege', irreversible: true }));
      else if (cls === 'protected' || cls === 'critical') hits.push(hit(`shell.${name}.protected`, 'high', `${name} of a protected path (${what})`, { category: 'privilege' }));
    }
  }
  if (hits.length) return worst(hits);
  if (recursive) return hit(`shell.${name}.recursive`, 'high', `recursive ${name} of ${paths.join(' ')}`, { category: 'privilege' });
  if (allWritable) return hit(`shell.${name}.writable`, 'low', `${name} within writable paths (${paths.join(' ')})`, { category: 'privilege' });
  return hit(`shell.${name}`, 'medium', `${name} ${cmd.args.join(' ')}`, { category: 'privilege' });
}

/**
 * gzip / bzip2 / xz / zstd and friends. Listing or testing an archive is a read.
 * Compressing or decompressing in place rewrites files, so it needs a human; doing so
 * to an audit log rewrites evidence, and reading credential material to compress it is
 * a secrets read (the exfil check catches it leaving the host).
 */
export function classifyCompress(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const { flags, ops } = operands(cmd.args, []);
  const sf = shortFlags(flags);
  // The *cat variants always decompress to stdout, leaving the source in place.
  if (/^(zcat|bzcat|xzcat|zstdcat|lz4cat)$/.test(name)) {
    const secret = ops.find((o) => isSensitiveReadPath(o));
    return secret
      ? hit(`shell.${name}.secret`, 'medium', `${name} reads credential material (${secret})`, { category: 'secrets' })
      : hit(`shell.${name}`, 'read_only', `${name} decompresses to stdout`);
  }
  if (/[lt]/.test(sf) || flags.some((f) => f === '--list' || f === '--test')) {
    return hit(`shell.${name}.read`, 'read_only', `${name} lists or tests an archive without changing it`);
  }
  // Writing to stdout (`gzip -c`) leaves the source alone; the destination is judged by
  // the redirect rules. Reading a secret to stdout is still a secrets read.
  const toStdout = /c/.test(sf) || flags.includes('--stdout') || flags.includes('--to-stdout');
  const secret = ops.find((o) => isSensitiveReadPath(o));
  if (toStdout) {
    return secret
      ? hit(`shell.${name}.secret`, 'medium', `${name} reads credential material (${secret})`, { category: 'secrets' })
      : hit(`shell.${name}`, 'read_only', `${name} -c writes to stdout, leaving the source file in place`);
  }
  if (!ops.length) return hit(`shell.${name}.stdin`, 'read_only', `${name} on stdin (its output is judged where it goes)`);
  // In place, the source file is deleted and replaced by its (de)compressed form: on a
  // critical or access path that corrupts it, on an audit log that rewrites evidence.
  const hits: RuleHit[] = [];
  for (const raw of ops) {
    for (const p of resolvePaths(raw, ctxOf(cmd, target)).paths) {
      const { cls, what } = classifyPath(p, target, false);
      if (['root', 'top', 'device', 'critical', 'access'].includes(cls)) {
        hits.push(hit(`shell.${name}.${cls}`, 'forbidden', `${name} replaces ${what}, corrupting a file the host cannot boot or authenticate without`, { category: cls === 'access' ? 'lockout' : 'destruction', irreversible: true }));
      } else if (cls === 'audit') {
        hits.push(hit(`shell.${name}.audit`, 'high', `${name} rewrites audit evidence (${what})`, { category: 'anti-forensics' }));
      } else if (cls === 'protected') {
        hits.push(hit(`shell.${name}.protected`, 'high', `${name} rewrites a protected path (${what})`, { category: 'integrity' }));
      }
    }
  }
  if (secret) hits.push(hit(`shell.${name}.secret`, 'medium', `${name} reads credential material (${secret})`, { category: 'secrets' }));
  return hits.length ? worst(hits) : hit(`shell.${name}`, 'medium', `${name} replaces ${ops.join(' ')} with its (de)compressed form`, { category: 'integrity' });
}

export function classifyChattr(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { ops } = operands(cmd.args);
  const attr = ops.find((o) => /^[+-=][a-zA-Z]+$/.test(o)) ?? cmd.args.find((a) => /^[+-=][a-zA-Z]+$/.test(a)) ?? '';
  const paths = ops.filter((o) => o !== attr);
  if (/^-[a-zA-Z]*a/.test(attr) && paths.some((p) => isAuditPath(p))) {
    return hit('shell.chattr.audit', 'high', `chattr ${attr} removes append-only protection from audit logs`, { category: 'anti-forensics' });
  }
  const protectedHit = paths.some((p) => resolvePaths(p, ctxOf(cmd, target)).paths.some((x) => isProtectedPath(x, target) || isCriticalFile(x)));
  return hit('shell.chattr', 'high', `chattr ${attr} changes immutability/append-only flags${protectedHit ? ' on a protected path' : ''}`, { category: 'integrity' });
}

// ---- destroy contents -------------------------------------------------------

export function classifyShred(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { ops } = operands(cmd.args, ['-n', '--iterations', '-s', '--size', '--random-source']);
  const name = cmd.name.split('/').pop()!;
  for (const raw of ops) {
    for (const p of resolvePaths(raw, ctxOf(cmd, target)).paths) {
      const { cls, what } = classifyPath(p, target, true);
      if (['root', 'top', 'device', 'critical', 'access', 'audit', 'protected'].includes(cls)) {
        return hit(`shell.${name}.${cls}`, 'forbidden', `${name} irrecoverably overwrites ${what}`, { category: cls === 'audit' ? 'anti-forensics' : 'destruction', irreversible: true });
      }
    }
  }
  return hit(`shell.${name}`, 'high', `${name} irrecoverably overwrites ${ops.join(' ') || 'its input'}`, { category: 'destruction', irreversible: true });
}

export function classifyTruncate(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args, ['-s', '--size', '-r', '--reference']);
  const sIdx = flags.findIndex((f) => f === '-s' || f === '--size');
  const size = sIdx >= 0 ? flags[sIdx + 1] : flags.find((f) => /^(-s|--size=)/.test(f))?.replace(/^(-s|--size=)/, '');
  const shrinks = size !== undefined && /^(0+|-\d+.*|<\d+.*)$/.test(size);
  const hits: RuleHit[] = [];
  let allLogs = ops.length > 0;
  for (const raw of ops) {
    for (const p of resolvePaths(raw, ctxOf(cmd, target)).paths) {
      const { cls, what } = classifyPath(p, target, false);
      if (!(p.endsWith('.log') || /\.log\.\d+$/.test(p)) || cls === 'audit') allLogs = false;
      if (cls === 'audit') hits.push(hit('shell.truncate.audit', 'forbidden', `truncating ${what} destroys audit evidence`, { category: 'anti-forensics', irreversible: true }));
      else if (['critical', 'access', 'device', 'root', 'top'].includes(cls)) hits.push(hit(`shell.truncate.${cls}`, 'forbidden', `truncating ${what}`, { category: 'destruction', irreversible: true }));
    }
  }
  if (hits.length) return worst(hits);
  if (shrinks && allLogs) return hit('shell.truncate.log', 'low', `truncating log file(s) ${ops.join(' ')}`, { category: 'destruction' });
  return hit('shell.truncate', 'high', `truncate ${cmd.args.join(' ')} discards file contents`, { category: 'destruction', irreversible: true });
}

export function classifyTee(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { flags, ops } = operands(cmd.args);
  const append = /a/.test(shortFlags(flags)) || flags.includes('--append');
  const hits = ops.map((p) => classifyWrite(p, append ? 'append' : 'overwrite', cmd, target, append ? 'tee -a' : 'tee'))
    .filter((h): h is RuleHit => !!h)
    .map((h) => ({ ...h, ruleId: h.ruleId.replace('shell.write.', 'shell.tee.') }));
  if (hits.length) return worst(hits);
  if (!ops.length) return hit('shell.tee.stdout', 'read_only', 'tee with no file only copies to stdout');
  return ops.every((p) => resolvePaths(p, ctxOf(cmd, target)).paths.every((x) => isWritablePath(x, target)) || isHarmlessSink(p))
    ? hit('shell.tee.writable', 'low', `tee into a writable path (${ops.join(' ')})`, { category: 'integrity' })
    : hit('shell.tee', 'medium', `tee writes to ${ops.join(' ')}`, { category: 'integrity' });
}

export function classifyDd(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const opt = (k: string) => cmd.args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
  const of = opt('of');
  const input = opt('if');
  if (of) {
    for (const p of resolvePaths(of, ctxOf(cmd, target)).paths) {
      if (isDevicePath(p)) return hit('shell.dd.device', 'forbidden', `dd writing directly to block device ${p}`, { category: 'destruction', irreversible: true });
    }
    const w = classifyWrite(of, 'overwrite', cmd, target, 'dd');
    if (w && (w.tier === 'forbidden' || w.tier === 'high')) return { ...w, ruleId: w.ruleId.replace('shell.write.', 'shell.dd.') };
  }
  if (input && (isDevicePath(input) || /^\/dev\/(mem|kmem)$|^\/proc\/kcore$/.test(normalise(input)))) {
    return hit('shell.dd.read-raw', 'high', `dd reads raw disk or memory (${input}), which exposes everything on it`, { category: 'secrets' });
  }
  if (input && /^\/dev\/(zero|u?random)$/.test(input) && of) {
    return hit('shell.dd.fill', 'high', `dd from ${input} into ${of} can fill the disk`, { category: 'resource' });
  }
  return hit('shell.dd', 'high', 'dd performs raw block writes', { category: 'destruction' });
}
