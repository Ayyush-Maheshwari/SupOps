import type { ResolvedTarget } from '../tools/types.ts';

export const DEFAULT_PROTECTED_PATHS = [
  '/etc',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/var/lib',
  '/var/spool/cron',
  '/var/log/audit',
  '/root',
  '/home/*/.ssh',
  '/proc',
  '/sys',
  '/dev',
];

/**
 * Directories whose removal (or move, or recursive chmod/chown) takes the whole host
 * with it. Distinct from "protected": `/etc/nginx` is protected, but `/var` or `/home`
 * are catastrophic as a unit even though most of what is under them is not.
 */
export const TOP_LEVEL_DIRS = [
  '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/opt',
  '/proc', '/root', '/sbin', '/srv', '/sys', '/usr', '/var', '/snap', '/mnt', '/media',
  '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/local', '/var/lib', '/var/log',
];

/**
 * Files whose loss or corruption stops a Linux host from booting or anyone from
 * logging in. Deleting or emptying one is never a repair.
 */
const CRITICAL_FILES = [
  '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow', '/etc/sudoers',
  '/etc/sudoers.d/*', '/etc/fstab', '/etc/crypttab', '/etc/pam.d', '/etc/pam.d/*',
  '/etc/ssh/sshd_config', '/etc/ssh/sshd_config.d/*', '/etc/ld.so.preload', '/etc/ld.so.conf',
  '/etc/nsswitch.conf', '/etc/login.defs', '/etc/security/*', '/etc/default/grub',
  '/boot', '/boot/*', '/etc/inittab', '/etc/systemd/system.conf',
  '/bin/sh', '/bin/bash', '/usr/bin/sudo', '/usr/bin/bash', '/sbin/init', '/lib/systemd/systemd',
];

/** Evidence of who did what. Destroying it is anti-forensics, whatever the stated intent. */
const AUDIT_PATTERNS: RegExp[] = [
  /^\/var\/log\/(auth\.log|secure|audit|wtmp|btmp|lastlog|faillog|journal)(\.|\/|$)/,
  /^\/run\/log\/journal(\/|$)/,
  /(^|\/)\.(bash|zsh|sh|ash|python|mysql|psql)_history$/,
  /(^|\/)\.histfile$/,
];

/** Devices are not merely protected -- writing to one is unrecoverable. */
const DEVICE_PATHS = [
  /^\/dev\/(sd|nvme|vd|hd|mmcblk|xvd|md|dm-|nbd|rbd|zd|loop)/,
  /^\/dev\/(disk|mapper)\//,
  /^\/dev\/(mem|kmem|port)$/,
];

export const isDevicePath = (p: string): boolean => DEVICE_PATHS.some((r) => r.test(normalise(p)));

/** Sinks that discard or duplicate output rather than write a file. */
export const isHarmlessSink = (p: string): boolean =>
  /^\/dev\/(null|stdout|stderr|tty|fd\/[0-2])$/.test(p) || /^&?[0-9-]$/.test(p);

/** Network pseudo-devices: bash opens a socket for these. */
export const isNetworkDevice = (p: string): boolean => /^\/dev\/(tcp|udp)\//.test(p);

export function normalise(p: string): string {
  // Resolve `.` / `..` / `//` conservatively: we are deciding whether to trust this
  // path, so a traversal that escapes its prefix must be judged on where it lands.
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/') || (p.startsWith('/') ? '/' : '.');
}

// ---- resolving what a path argument really means ---------------------------

export interface PathContext {
  /** Working directory, when a preceding `cd` in the same line made it knowable. */
  cwd?: string | null;
  target: ResolvedTarget;
}

/** The account a command effectively runs as (after the target's elevation). */
export function effectiveUser(target: ResolvedTarget): string {
  const cfg = target.config;
  if (cfg.kind !== 'ssh') return 'root';
  const become = cfg.become;
  if (become && become.method !== 'none' && !become.template) return become.user || 'root';
  return cfg.user;
}

/** Accounts SupOps logs in or elevates through on this target: locking them locks SupOps out. */
export function accessAccounts(target: ResolvedTarget): string[] {
  const cfg = target.config;
  if (cfg.kind !== 'ssh') return [];
  const out = new Set<string>([cfg.user]);
  if (cfg.become && cfg.become.method !== 'none') out.add(cfg.become.user || 'root');
  if (cfg.via?.become) out.add(cfg.via.become.user || 'root');
  return [...out];
}

const homeOf = (user: string) => (user === 'root' ? '/root' : `/home/${user}`);

/** The SSH port SupOps connects on (22 unless configured). */
export const sshPort = (target: ResolvedTarget): number =>
  target.config.kind === 'ssh' ? target.config.port : 22;

/**
 * Expand `{a,b}` and `{1..3}` the way bash would, so `/{etc,usr}` is judged as
 * `/etc` and `/usr`. Capped: a pathological pattern is treated as a glob instead.
 */
export function expandBraces(word: string, limit = 64): string[] {
  const m = word.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [word];
  const [, pre, body, post] = m as unknown as [string, string, string, string];
  let items: string[];
  const range = body.match(/^(-?\d+)\.\.(-?\d+)$/);
  if (range) {
    const a = Number(range[1]); const b = Number(range[2]);
    if (Math.abs(b - a) > limit) return [word];
    items = [];
    for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) items.push(String(i));
  } else if (body.includes(',')) {
    items = body.split(',');
  } else {
    return [word]; // not an expansion (e.g. a literal `{}` from find -exec)
  }
  const out: string[] = [];
  for (const it of items) {
    for (const e of expandBraces(`${pre}${it}${post}`, limit)) {
      out.push(e);
      if (out.length > limit) return [word];
    }
  }
  return out;
}

/**
 * Turn one path argument into the absolute path(s) it can refer to. Relative paths
 * resolve against a known cwd; `~` against the effective user's home. Returns
 * `unknown: true` when the location cannot be known from the command alone.
 */
export function resolvePaths(arg: string, ctx: PathContext): { paths: string[]; unknown: boolean } {
  const out: string[] = [];
  let unknown = false;
  for (let p of expandBraces(arg)) {
    if (p === '~' || p.startsWith('~/')) p = homeOf(effectiveUser(ctx.target)) + p.slice(1);
    else if (/^~[a-z_][a-z0-9_-]*(\/|$)/i.test(p)) p = `/home/${p.slice(1)}`;
    // `$HOME` is the one variable whose value we can know.
    p = p.replace(/^\$HOME(?=\/|$)/, homeOf(effectiveUser(ctx.target)));
    if (p.startsWith('$')) { unknown = true; out.push(p); continue; }
    if (!p.startsWith('/')) {
      if (ctx.cwd) p = `${ctx.cwd.replace(/\/$/, '')}/${p}`;
      else { unknown = true; out.push(p); continue; }
    }
    out.push(normalise(p));
  }
  return { paths: out, unknown };
}

// ---- matching ------------------------------------------------------------

function matchesGlobPrefix(path: string, pattern: string): boolean {
  const pathParts = normalise(path).split('/').filter(Boolean);
  const patParts = normalise(pattern).split('/').filter(Boolean);
  if (pathParts.length < patParts.length) {
    // `/etc` itself counts as inside `/etc`.
    return patParts.slice(0, pathParts.length).every((p, i) => p === '*' || p === pathParts[i])
      && pathParts.length === patParts.length;
  }
  return patParts.every((p, i) => p === '*' || p === pathParts[i]);
}

/** A shell glob as a regex over one path. */
function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Globs and wildcards make blast radius unknowable from the string alone. */
export const hasGlob = (s: string): boolean => /[*?[\]]/.test(s);

/**
 * Could this glob match any of these concrete paths? `/e*` matches `/etc`, `/*`
 * matches everything at the top. A glob is judged by the worst thing it can hit.
 */
export function globCouldMatch(glob: string, candidates: string[]): string | null {
  if (!hasGlob(glob)) return null;
  const re = globToRegex(normalise(glob));
  for (const c of candidates) if (!hasGlob(c) && re.test(c)) return c;
  return null;
}

export const isRootPath = (p: string): boolean => normalise(p) === '/' || /^\/+\*+$/.test(p);

/**
 * The fixed leading part of a glob path -- everything up to the first segment that
 * contains a wildcard. `/home/*` -> `/home`, `/var/log/*.gz` -> `/var/log`. This is
 * the directory a glob operation is rooted in, so it can be judged like a recursive
 * target: `rm -rf /home/*` reaches whatever lives directly under `/home`.
 */
export function fixedGlobPrefix(p: string): string {
  const out: string[] = [];
  for (const part of normalise(p).split('/')) {
    if (part && hasGlob(part)) break;
    out.push(part);
  }
  return out.join('/') || '/';
}

/** A top-level system directory, or a glob that could hit one. */
export function topLevelHit(p: string): string | null {
  const n = normalise(p);
  if (TOP_LEVEL_DIRS.includes(n)) return n;
  return globCouldMatch(n, TOP_LEVEL_DIRS);
}

const isUnder = (path: string, pattern: string) => matchesGlobPrefix(path, pattern);

export function isProtectedPath(path: string, target: ResolvedTarget): boolean {
  if (!path.startsWith('/')) return false; // relative paths are judged by the command, not here
  const patterns = target.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const n = normalise(path);
  if (patterns.some((pat) => isUnder(n, pat))) return true;
  // A glob is protected if what it can match is.
  return hasGlob(n) && !!globCouldMatch(n, patterns.filter((p) => !p.includes('*')));
}

export function isCriticalFile(path: string): boolean {
  const n = normalise(path);
  return CRITICAL_FILES.some((pat) => pat.endsWith('*')
    ? isUnder(n, pat.replace(/\/\*$/, '')) && n !== pat.replace(/\/\*$/, '')
    : n === pat)
    || (hasGlob(n) && !!globCouldMatch(n, CRITICAL_FILES.filter((p) => !p.includes('*'))));
}

export const isAuditPath = (path: string): boolean => AUDIT_PATTERNS.some((re) => re.test(normalise(path)));

/** The SSH files that let SupOps in (for each account it uses). */
export function accessPaths(target: ResolvedTarget): string[] {
  return accessAccounts(target).flatMap((u) => [
    homeOf(u), `${homeOf(u)}/.ssh`, `${homeOf(u)}/.ssh/authorized_keys`, `${homeOf(u)}/.ssh/authorized_keys2`,
  ]);
}

export function isAccessPath(path: string, target: ResolvedTarget): boolean {
  const n = normalise(path);
  return accessPaths(target).some((p) => n === p) || /^\/etc\/ssh(\/|$)/.test(n);
}

/** True when a recursive operation on `dir` reaches `inner` (dir is an ancestor or equal). */
export const contains = (dir: string, inner: string): boolean => {
  const d = normalise(dir); const i = normalise(inner);
  return d === '/' || i === d || i.startsWith(`${d}/`);
};

export function isWritablePath(path: string, target: ResolvedTarget): boolean {
  const patterns = target.writablePaths ?? ['/tmp', '/var/tmp'];
  return patterns.some((pat) => isUnder(path, pat));
}

/** A path that is safe to delete a specific file from at `medium` rather than `high`. */
export function isScratchPath(path: string, target: ResolvedTarget): boolean {
  if (isWritablePath(path, target)) return true;
  return ['/tmp', '/var/tmp', '/var/log', '/var/cache'].some((p) => isUnder(path, p)) && !isAuditPath(path);
}

/**
 * The most severe thing a destructive operation on `path` can hit, for rules that
 * delete, move, overwrite or recursively re-permission. `recursive` means the
 * operation reaches everything underneath, so a parent is judged by its contents.
 */
export type PathClass = 'root' | 'top' | 'device' | 'critical' | 'access' | 'audit' | 'protected' | 'scratch' | 'other' | 'unknown';

export function classifyPath(path: string, target: ResolvedTarget, recursive: boolean): { cls: PathClass; what: string } {
  if (path.startsWith('$') || !path.startsWith('/')) return { cls: 'unknown', what: path };
  const n = normalise(path);
  if (isRootPath(path) || isRootPath(n)) return { cls: 'root', what: '/' };
  if (isDevicePath(n)) return { cls: 'device', what: n };
  const top = topLevelHit(n);
  if (top) return { cls: top === '/' ? 'root' : 'top', what: top };
  if (isCriticalFile(n)) return { cls: 'critical', what: n };
  if (isAccessPath(n, target)) return { cls: 'access', what: n };
  if (isAuditPath(n)) return { cls: 'audit', what: n };
  if (recursive || hasGlob(n)) {
    // A recursive op reaches everything under the path, and a glob can match any of
    // it, so both are judged by the directory they are rooted in. `rm -rf /home/*`
    // takes the SupOps account's home (and its .ssh) with it just as `rm -rf /home`
    // would; matching the fixed prefix is what makes the glob spelling read the same.
    const scope = hasGlob(n) ? fixedGlobPrefix(n) : n;
    const inside = [...accessPaths(target), '/etc/ssh'].find((p) => contains(scope, p));
    if (inside) return { cls: 'access', what: inside };
    if (/^\/var\/log(\/|$)/.test(scope) && contains(scope, '/var/log/auth.log')) return { cls: 'audit', what: scope };
  }
  if (isProtectedPath(n, target)) return { cls: 'protected', what: n };
  if (isScratchPath(n, target)) return { cls: 'scratch', what: n };
  return { cls: 'other', what: n };
}
