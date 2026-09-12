import type { RiskTier } from '@supops/shared';
import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import { lexShell } from './shell-lex.ts';
import { hasGlob, isDevicePath, isProtectedPath, isScratchPath, isWritablePath } from './paths.ts';

export interface RuleHit {
  ruleId: string;
  tier: RiskTier;
  reason: string;
}

const hit = (ruleId: string, tier: RiskTier, reason: string): RuleHit => ({
  ruleId,
  tier,
  reason,
});

/** Commands whose tier does not depend on their arguments. */
const FLAT: Record<string, RiskTier> = {
  // --- read_only ---
  cat: 'read_only', less: 'read_only', more: 'read_only', head: 'read_only',
  tail: 'read_only', grep: 'read_only', egrep: 'read_only', fgrep: 'read_only',
  zgrep: 'read_only', ls: 'read_only', stat: 'read_only', file: 'read_only',
  wc: 'read_only', sort: 'read_only', uniq: 'read_only', cut: 'read_only',
  tr: 'read_only', df: 'read_only', du: 'read_only', free: 'read_only',
  ps: 'read_only', top: 'read_only', htop: 'read_only', vmstat: 'read_only',
  iostat: 'read_only', sar: 'read_only', uptime: 'read_only', who: 'read_only',
  whoami: 'read_only', id: 'read_only', hostname: 'read_only', date: 'read_only',
  env: 'read_only', printenv: 'read_only', pwd: 'read_only', echo: 'read_only',
  dmesg: 'read_only', lsof: 'read_only', ss: 'read_only', netstat: 'read_only',
  dig: 'read_only', nslookup: 'read_only', host: 'read_only', traceroute: 'read_only',
  lsblk: 'read_only', lscpu: 'read_only', blkid: 'read_only', mount_list: 'read_only',
  jq: 'read_only', yq: 'read_only', md5sum: 'read_only', sha256sum: 'read_only',
  diff: 'read_only', realpath: 'read_only', readlink: 'read_only', basename: 'read_only',
  dirname: 'read_only', nproc: 'read_only', arch: 'read_only', uname: 'read_only',

  // --- low ---
  mkdir: 'low', touch: 'low', sync: 'low', logrotate: 'low',

  // --- medium ---
  crontab: 'medium', apt: 'medium', 'apt-get': 'medium', yum: 'medium',
  dnf: 'medium', apk: 'medium', pip: 'medium', pip3: 'medium', npm: 'medium',

  // --- high ---
  mkfs: 'high', fdisk: 'high', parted: 'high', mount: 'high', umount: 'high',
  swapoff: 'high', swapon: 'high', lvremove: 'high', vgremove: 'high',
  pvremove: 'high', userdel: 'high', usermod: 'high', useradd: 'high',
  passwd: 'high', chpasswd: 'high', visudo: 'high', shutdown: 'high',
  reboot: 'high', halt: 'high', poweroff: 'high', init: 'high', telinit: 'high',
  insmod: 'high', rmmod: 'high', modprobe: 'high', sysctl: 'high',

  // --- forbidden ---
  eval: 'forbidden', exec: 'forbidden', source: 'forbidden',
};

/** Argument-sensitive commands get a dedicated classifier. */
const CLASSIFIERS: Record<
  string,
  (cmd: SimpleCommand, target: ResolvedTarget) => RuleHit
> = {
  rm: classifyRm,
  find: classifyFind,
  sed: classifySed,
  awk: classifyAwk,
  dd: classifyDd,
  systemctl: classifySystemctl,
  service: classifyService,
  kill: classifyKill,
  pkill: (c) => hit('shell.pkill', 'medium', `pkill ${c.args.join(' ')} terminates processes by name`),
  killall: (c) => hit('shell.killall', 'medium', `killall ${c.args.join(' ')} terminates processes by name`),
  chmod: classifyChmod,
  chown: classifyChown,
  chgrp: classifyChown,
  cp: classifyCopyMove,
  mv: classifyCopyMove,
  ln: classifyCopyMove,
  truncate: classifyTruncate,
  curl: classifyHttpClient,
  wget: classifyHttpClient,
  journalctl: classifyJournalctl,
  git: classifyGit,
  iptables: classifyIptables,
  ip6tables: classifyIptables,
  ufw: classifyIptables,
  'firewall-cmd': classifyIptables,
  tee: classifyTee,
  nginx: (c) => (c.args.includes('-t') ? hit('shell.nginx.test', 'read_only', 'nginx config test') : hit('shell.nginx.reload', 'medium', 'nginx control command')),
  apachectl: (c) => (c.args.includes('configtest') ? hit('shell.apachectl.test', 'read_only', 'apache config test') : hit('shell.apachectl', 'medium', 'apache control command')),
  mysql: classifySqlClient,
  psql: classifySqlClient,
  'ssh-keygen': (c) => hit('shell.sshkeygen', 'high', `ssh-keygen ${c.args.join(' ')} touches key material`),
  kubectl: classifyKubectl,
  oc: classifyKubectl, // OpenShift CLI: same verbs/risk shape as kubectl
  k3s: classifyK3s,
  docker: classifyDocker,
  podman: classifyDocker,
  helm: classifyHelm,
};

/** Paths whose contents are login/credential material -- reading them must be gated. */
const SENSITIVE_READ_PATTERNS: RegExp[] = [
  /\/\.ssh\//i, // anything under ~/.ssh
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)\b/i, // private keys by name
  /\.(pem|key|p12|pfx)$/i, // key/cert files
  /\/\.aws\//i, /\/\.azure\//i, /\/\.config\/gcloud\//i, // cloud credentials
  /\/\.kube\//i, /kubeconfig/i, // kube credentials
  /(^|\/)\.env(\.|$)/i, // .env files
  /(^|\/)\.netrc$/i, /(^|\/)\.pgpass$/i, /(^|\/)\.my\.cnf$/i, /(^|\/)\.git-credentials$/i,
  /(^|\/)\.?htpasswd$/i, /(^|\/)credentials(\.|$)/i,
  /\/etc\/(shadow|gshadow|sudoers)/i, // system secrets
  /(^|\/)secrets?\//i, /\/vault\//i,
];

function isSensitiveReadPath(arg: string): boolean {
  if (arg.startsWith('-')) return false; // a flag, not a path
  const p = arg.replace(/^['"]|['"]$/g, '');
  return SENSITIVE_READ_PATTERNS.some((re) => re.test(p));
}

export function classifySimpleCommand(
  cmd: SimpleCommand,
  target: ResolvedTarget,
): RuleHit {
  const name = cmd.name.split('/').pop() ?? cmd.name;

  // `su - user -c "<cmd>"` is a wrapper like sudo: what matters is the command it
  // runs, not the identity switch. Without this, every command an agent wraps this
  // way lands on `su` -- which is not in the ruleset, so it fails closed to `high`
  // and demands approval for `df -h`. That is how approval fatigue starts, and an
  // approver who stops reading is worse than no gate at all.
  if (name === 'su') {
    const cIdx = cmd.args.indexOf('-c');
    if (cIdx >= 0 && cmd.args[cIdx + 1]) {
      const inner = cmd.args[cIdx + 1]!;
      const innerLex = lexInner(inner);
      if (!innerLex) {
        return hit('shell.su.unreadable', 'high', `su -c "${inner}" could not be read safely`);
      }
      const worst = innerLex
        .map((c) => classifySimpleCommand(c, target))
        .reduce((a, b) => (RANK[a.tier] >= RANK[b.tier] ? a : b));
      return { ...worst, reason: `su -c: ${worst.reason}` };
    }
    // An interactive `su` opens a shell we cannot see into.
    return hit('shell.su.interactive', 'high', 'su without -c opens an unreviewable shell');
  }

  // sudo/env/nice/timeout wrap a real command; classify what they actually run.
  if (['sudo', 'doas', 'nice', 'ionice', 'timeout', 'nohup', 'stdbuf'].includes(name)) {
    const inner = stripWrapperFlags(name, cmd.args);
    if (!inner.length) {
      return hit('shell.wrapper.empty', 'high', `${name} with no command to inspect`);
    }
    const innerHit = classifySimpleCommand(
      { ...cmd, name: inner[0]!, args: inner.slice(1) },
      target,
    );
    // sudo does not itself raise the tier -- the inner command's own rule already
    // accounts for privilege. Raising here would make every read-only check on a
    // sudo-only host require approval, which is how approval fatigue starts.
    return { ...innerHit, reason: `${name}: ${innerHit.reason}` };
  }

  // Piping anything into a shell is remote code execution with extra steps.
  if (['sh', 'bash', 'zsh', 'ksh', 'dash'].includes(name)) {
    if (cmd.pipedInto || cmd.args.some((a) => a === '-c' || a === '-s')) {
      return hit(
        'shell.pipe-to-shell',
        'forbidden',
        `piping or evaluating arbitrary input through ${name} executes unreviewable code`,
      );
    }
  }
  if (name === 'base64' && cmd.pipedInto) {
    return hit('shell.base64-pipe', 'forbidden', 'base64-decoded input piped to another command');
  }

  const classifier = CLASSIFIERS[name];
  if (classifier) return classifier(cmd, target);

  const flat = FLAT[name];
  if (flat) {
    // Reading login/credential material is never a free read. Even a plain `cat` of
    // a private key or ~/.aws/credentials must pause for a human -- this is the
    // "worst case: it reads a file to log in" the operator asked to gate.
    if (flat === 'read_only') {
      const secretPath = cmd.args.find(isSensitiveReadPath);
      if (secretPath) {
        return hit(
          'shell.read.secret',
          'medium',
          `reading a credential/secret path (${secretPath}) requires approval`,
        );
      }
    }
    return hit(`shell.flat.${name}`, flat, `${name} is classified ${flat}`);
  }

  // Fail closed. An unrecognised binary could be anything, including a wrapper
  // script that does far more than its name suggests.
  return hit(
    'shell.unknown',
    'high',
    `"${name}" is not in the ruleset; unrecognised commands are treated as high risk`,
  );
}

// sudo/doas flags that take a following value. Without consuming the value too,
// `sudo -u appuser <cmd>` would leave `appuser` as the "inner command" and
// `sudo -S -p '' <cmd>` would stop stripping at the empty `-p` argument -- both
// misclassifying the real command (usually to `high`). The executor's elevation
// wrapper emits exactly these flags, so this keeps classified === executed.
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-R', '-r', '-t', '-U', '-D']);

function stripWrapperFlags(name: string, args: string[]): string[] {
  const out = [...args];
  const takesValue = name === 'sudo' || name === 'doas';
  while (out.length) {
    const a = out[0]!;
    if (name === 'timeout' && /^[0-9]+[smhd]?$/.test(a)) { out.shift(); continue; }
    if (takesValue && SUDO_VALUE_FLAGS.has(a)) { out.shift(); out.shift(); continue; }
    if (a.startsWith('-') || a.includes('=')) { out.shift(); continue; }
    break;
  }
  return out;
}

// --------------------------------------------------------------------------
// Individual classifiers
// --------------------------------------------------------------------------

function classifyRm(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const flags = cmd.args.filter((a) => a.startsWith('-')).join('');
  const paths = cmd.args.filter((a) => !a.startsWith('-'));
  const recursive = /r/i.test(flags);
  const force = /f/.test(flags);

  for (const p of paths) {
    const norm = p.replace(/\/+$/, '') || '/';
    if (norm === '/' || /^\/\*+$/.test(p)) {
      return hit('shell.rm.root', 'forbidden', `rm targeting ${p} destroys the host`);
    }
    if (recursive && isProtectedPath(p, target)) {
      return hit('shell.rm.protected', 'forbidden', `recursive rm of protected path ${p}`);
    }
  }
  if (recursive) {
    return hit(
      'shell.rm.recursive',
      'high',
      `recursive rm (${flags}) of ${paths.join(', ') || '(no path)'} has unbounded blast radius`,
    );
  }
  if (paths.some(hasGlob)) {
    return hit('shell.rm.glob', 'high', `rm with a glob (${paths.join(' ')}) matches an unknown set of files`);
  }
  if (paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.rm.protected-file', 'high', `rm of a protected path (${paths.join(' ')})`);
  }
  if (paths.length && paths.every((p) => isScratchPath(p, target))) {
    return hit('shell.rm.scratch', 'medium', `rm of specific files under a scratch path (${paths.join(' ')})`);
  }
  return hit('shell.rm.file', 'high', `rm of ${paths.join(' ') || '(no path)'}${force ? ' with -f' : ''}`);
}

function classifyFind(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  if (cmd.args.includes('-delete')) {
    return hit('shell.find.delete', 'high', 'find -delete removes every match');
  }
  const execIdx = cmd.args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
  if (execIdx >= 0) {
    const inner = cmd.args.slice(execIdx + 1).filter((a) => a !== ';' && a !== '\;' && a !== '+');
    if (!inner.length) return hit('shell.find.exec', 'high', 'find -exec with an opaque command');
    const innerHit = classifySimpleCommand(
      { name: inner[0]!, args: inner.slice(1), redirects: [], raw: inner.join(' '), pipedInto: false },
      target,
    );
    // -exec runs the inner command once per match, so its blast radius is at least
    // as large as the inner command's and usually much larger.
    return {
      ruleId: 'shell.find.exec',
      tier: innerHit.tier === 'read_only' ? 'read_only' : 'high',
      reason: `find -exec runs "${inner.join(' ')}" for every match: ${innerHit.reason}`,
    };
  }
  return hit('shell.find.read', 'read_only', 'find without -delete or -exec only lists files');
}

function classifySed(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const inPlace = cmd.args.some((a) => a === '-i' || a.startsWith('-i.') || (a.startsWith('-') && !a.startsWith('--') && a.includes('i')));
  if (!inPlace) return hit('shell.sed.read', 'read_only', 'sed without -i only writes to stdout');
  const files = cmd.args.filter((a) => !a.startsWith('-') && !a.includes('s/') && !a.startsWith('/'));
  const targets = cmd.args.filter((a) => a.startsWith('/'));
  if (targets.some((p) => isProtectedPath(p, target))) {
    return hit('shell.sed.protected', 'high', `sed -i edits a protected file (${targets.join(' ')})`);
  }
  return hit('shell.sed.inplace', 'medium', `sed -i rewrites ${[...files, ...targets].join(' ') || 'a file'} in place`);
}

function classifyAwk(cmd: SimpleCommand): RuleHit {
  if (cmd.args.some((a) => a.startsWith('-i') || a.includes('system('))) {
    return hit('shell.awk.system', 'high', 'awk invoking system() or editing in place');
  }
  return hit('shell.awk.read', 'read_only', 'awk reading and formatting text');
}

function classifyDd(cmd: SimpleCommand): RuleHit {
  const of = cmd.args.find((a) => a.startsWith('of='))?.slice(3);
  if (of && isDevicePath(of)) {
    return hit('shell.dd.device', 'forbidden', `dd writing directly to block device ${of}`);
  }
  return hit('shell.dd', 'high', 'dd performs raw block writes');
}

const SYSTEMCTL_READ = new Set(['status', 'show', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'is-failed', 'cat', 'list-timers', 'list-sockets']);
const SYSTEMCTL_HIGH = new Set(['disable', 'mask', 'unmask', 'isolate', 'set-default', 'daemon-reexec']);

function classifySystemctl(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const verb = cmd.args.find((a) => !a.startsWith('-'));
  if (!verb) return hit('shell.systemctl.list', 'read_only', 'systemctl with no verb lists units');
  if (SYSTEMCTL_READ.has(verb)) {
    return hit(`shell.systemctl.${verb}`, 'read_only', `systemctl ${verb} only reads unit state`);
  }
  if (SYSTEMCTL_HIGH.has(verb)) {
    return hit(`shell.systemctl.${verb}`, 'high', `systemctl ${verb} changes boot-time behaviour`);
  }
  if (['poweroff', 'reboot', 'halt', 'kexec', 'suspend'].includes(verb)) {
    return hit(`shell.systemctl.${verb}`, 'high', `systemctl ${verb} takes the host down`);
  }

  const unit = cmd.args.find((a) => a !== verb && !a.startsWith('-'));
  const allowed = target.unitAllowlist;
  const unitAllowed = !!unit && !!allowed && allowed.includes(unit);

  if (verb === 'reload' || verb === 'reload-or-restart') {
    return unitAllowed
      ? hit('shell.systemctl.reload.allowlisted', 'low', `reload of allowlisted unit ${unit}`)
      : hit('shell.systemctl.reload', 'medium', `systemctl reload ${unit ?? ''} re-reads config`);
  }
  if (['restart', 'start', 'stop', 'try-restart', 'enable'].includes(verb)) {
    return hit(
      `shell.systemctl.${verb}`,
      'medium',
      `systemctl ${verb} ${unit ?? ''} interrupts or changes a running service`,
    );
  }
  return hit('shell.systemctl.other', 'high', `unrecognised systemctl verb "${verb}"`);
}

function classifyService(cmd: SimpleCommand): RuleHit {
  const verb = cmd.args[1];
  if (verb === 'status') return hit('shell.service.status', 'read_only', 'service status only reads');
  return hit('shell.service', 'medium', `service ${cmd.args.join(' ')} changes a running service`);
}

function classifyKill(cmd: SimpleCommand): RuleHit {
  const sig = cmd.args.find((a) => a.startsWith('-'));
  if (!sig || /^-(15|TERM|SIGTERM|1|HUP|SIGHUP)$/i.test(sig)) {
    return hit('shell.kill.term', 'low', `kill ${sig ?? '-TERM'} asks a process to stop gracefully`);
  }
  if (/^-(9|KILL|SIGKILL)$/i.test(sig)) {
    return hit('shell.kill.force', 'medium', 'kill -9 terminates without cleanup, risking data loss');
  }
  return hit('shell.kill', 'medium', `kill ${sig} signals a process`);
}

function classifyChmod(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const recursive = cmd.args.some((a) => a === '-R' || a === '--recursive');
  const mode = cmd.args.find((a) => /^[0-7]{3,4}$/.test(a) || /^[ugoa]*[+-=]/.test(a));
  const paths = cmd.args.filter((a) => !a.startsWith('-') && a !== mode);

  if (mode === '777' || mode === '0777') {
    return hit('shell.chmod.777', 'high', 'chmod 777 makes a path world-writable');
  }
  if (mode === '000' || mode === '0000') {
    return hit('shell.chmod.000', 'high', 'chmod 000 removes all access');
  }
  if (recursive && paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.chmod.recursive-protected', 'forbidden', `recursive chmod of ${paths.join(' ')}`);
  }
  if (recursive) return hit('shell.chmod.recursive', 'high', `recursive chmod of ${paths.join(' ')}`);
  if (paths.length && paths.every((p) => isWritablePath(p, target))) {
    return hit('shell.chmod.writable', 'low', `chmod within the target's writable paths (${paths.join(' ')})`);
  }
  if (paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.chmod.protected', 'high', `chmod of a protected path (${paths.join(' ')})`);
  }
  return hit('shell.chmod', 'medium', `chmod ${cmd.args.join(' ')}`);
}

function classifyChown(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const recursive = cmd.args.some((a) => a === '-R' || a === '--recursive');
  const paths = cmd.args.filter((a) => !a.startsWith('-')).slice(1);
  if (recursive && paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.chown.recursive-protected', 'forbidden', `recursive chown of ${paths.join(' ')}`);
  }
  if (recursive) return hit('shell.chown.recursive', 'high', `recursive chown of ${paths.join(' ')}`);
  if (paths.length && paths.every((p) => isWritablePath(p, target))) {
    return hit('shell.chown.writable', 'low', `chown within writable paths (${paths.join(' ')})`);
  }
  return hit('shell.chown', 'medium', `chown ${cmd.args.join(' ')}`);
}

function classifyCopyMove(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const paths = cmd.args.filter((a) => !a.startsWith('-'));
  const dest = paths[paths.length - 1];
  if (dest && isProtectedPath(dest, target)) {
    return hit(`shell.${cmd.name}.protected`, 'high', `${cmd.name} writing into protected path ${dest}`);
  }
  if (dest && isWritablePath(dest, target)) {
    return hit(`shell.${cmd.name}.writable`, 'low', `${cmd.name} into a writable path (${dest})`);
  }
  return hit(`shell.${cmd.name}`, 'medium', `${cmd.name} ${cmd.args.join(' ')} modifies the filesystem`);
}

function classifyTruncate(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const zero = cmd.args.some((a) => a === '-s' || a.startsWith('--size')) &&
    cmd.args.some((a) => a === '0' || a === '-s0');
  const paths = cmd.args.filter((a) => !a.startsWith('-') && a !== '0');
  if (zero && paths.every((p) => p.endsWith('.log') || isScratchPath(p, target))) {
    return hit('shell.truncate.log', 'low', `truncating log file(s) ${paths.join(' ')}`);
  }
  return hit('shell.truncate', 'high', `truncate ${cmd.args.join(' ')} discards file contents`);
}

function classifyHttpClient(cmd: SimpleCommand): RuleHit {
  if (cmd.pipedInto) {
    return hit(
      'shell.curl.pipe',
      'forbidden',
      `${cmd.name} piped into another command downloads and runs unreviewed code`,
    );
  }
  const method = cmd.args.find((a, i) => (a === '-X' || a === '--request') && cmd.args[i + 1])
    ? cmd.args[cmd.args.findIndex((a) => a === '-X' || a === '--request') + 1]
    : null;
  if (cmd.args.some((a) => a === '-I' || a === '--head')) {
    return hit('shell.curl.head', 'read_only', `${cmd.name} HEAD request`);
  }
  if (!method || method.toUpperCase() === 'GET') {
    return hit('shell.curl.get', 'read_only', `${cmd.name} GET request`);
  }
  if (method.toUpperCase() === 'DELETE') {
    return hit('shell.curl.delete', 'high', `${cmd.name} -X DELETE`);
  }
  return hit('shell.curl.write', 'medium', `${cmd.name} -X ${method} sends a mutating request`);
}

function classifyJournalctl(cmd: SimpleCommand): RuleHit {
  if (cmd.args.some((a) => a.startsWith('--vacuum') || a === '--rotate' || a === '--flush')) {
    return hit('shell.journalctl.vacuum', 'medium', 'journalctl vacuum/rotate discards logs');
  }
  return hit('shell.journalctl.read', 'read_only', 'journalctl reads the journal');
}

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'describe', 'blame', 'rev-parse', 'ls-files']);

function classifyGit(cmd: SimpleCommand): RuleHit {
  const verb = cmd.args.find((a) => !a.startsWith('-'));
  if (!verb) return hit('shell.git', 'read_only', 'git with no subcommand');
  if (GIT_READ.has(verb)) return hit(`shell.git.${verb}`, 'read_only', `git ${verb} only reads`);
  if (verb === 'push' && cmd.args.some((a) => a === '--force' || a === '-f')) {
    return hit('shell.git.force-push', 'high', 'git push --force can destroy remote history');
  }
  if (verb === 'reset' && cmd.args.includes('--hard')) {
    return hit('shell.git.reset-hard', 'high', 'git reset --hard discards uncommitted work');
  }
  if (verb === 'clean' && cmd.args.some((a) => a.includes('f'))) {
    return hit('shell.git.clean', 'high', 'git clean -f deletes untracked files');
  }
  return hit(`shell.git.${verb}`, 'medium', `git ${verb} modifies the working tree`);
}

function classifyIptables(cmd: SimpleCommand): RuleHit {
  if (cmd.args.some((a) => a === '-L' || a === '--list' || a === '-S' || a === 'status')) {
    return hit('shell.firewall.list', 'read_only', 'listing firewall rules');
  }
  if (cmd.args.some((a) => ['-F', '-X', '-P', '--flush', 'disable', 'stop'].includes(a))) {
    return hit(
      'shell.firewall.flush',
      'high',
      'flushing or disabling firewall rules can expose the host and lock you out',
    );
  }
  return hit('shell.firewall.modify', 'high', `${cmd.name} ${cmd.args.join(' ')} changes firewall rules`);
}

function classifyTee(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const paths = cmd.args.filter((a) => !a.startsWith('-'));
  if (paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.tee.protected', 'high', `tee writing into a protected path (${paths.join(' ')})`);
  }
  return hit('shell.tee', 'medium', `tee writes to ${paths.join(' ') || 'a file'}`);
}

function classifySqlClient(cmd: SimpleCommand): RuleHit {
  const sql = cmd.args.join(' ');
  if (/\b(DROP|TRUNCATE|ALTER)\b/i.test(sql)) {
    return hit('shell.sql.ddl', 'high', 'SQL containing DROP/TRUNCATE/ALTER');
  }
  if (/\b(DELETE|UPDATE)\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) {
    return hit('shell.sql.unqualified', 'high', 'DELETE/UPDATE without a WHERE clause affects every row');
  }
  if (/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    return hit('shell.sql.dml', 'medium', 'SQL that modifies rows');
  }
  return hit('shell.sql.read', 'read_only', 'read-only SQL');
}

/** Redirections write files regardless of what the command itself does. */
export function classifyRedirects(cmd: SimpleCommand, target: ResolvedTarget): RuleHit | null {
  for (const r of cmd.redirects) {
    if (r.op === '<') continue;
    if (isDevicePath(r.path)) {
      return hit('shell.redirect.device', 'forbidden', `redirecting output to device ${r.path}`);
    }
    if (isProtectedPath(r.path, target)) {
      return hit('shell.redirect.protected', 'high', `redirecting output into protected path ${r.path}`);
    }
    if (!isWritablePath(r.path, target)) {
      return hit('shell.redirect', 'medium', `redirecting output to ${r.path} writes a file`);
    }
  }
  return null;
}

/** Whole-line patterns that no per-command rule would catch. */
export function classifyWholeLine(command: string): RuleHit | null {
  if (/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/.test(command)) {
    return hit('shell.forkbomb', 'forbidden', 'fork bomb');
  }
  if (/\bhistory\s+-c\b/.test(command)) {
    return hit('shell.history-clear', 'forbidden', 'clearing shell history destroys audit evidence');
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(command)) {
    return hit('shell.embedded-key', 'high', 'command contains an embedded private key');
  }
  if (/\bAKIA[0-9A-Z]{16}\b/.test(command)) {
    return hit('shell.embedded-credential', 'high', 'command contains what looks like an AWS access key');
  }
  return null;
}

const RANK: Record<RiskTier, number> = {
  read_only: 0, low: 1, medium: 2, high: 3, forbidden: 4,
};

/** Read a nested command string, returning null when it cannot be read safely. */
function lexInner(inner: string): SimpleCommand[] | null {
  const lexed = lexShell(inner);
  return lexed.ok ? lexed.commands : null;
}

// --------------------------------------------------------------------------
// Container and cluster tooling
//
// Absent from the ruleset until now, which meant every `kubectl` and `docker`
// invocation fell through to `shell.unknown` and failed closed at `high`. On a
// Kubernetes host that made `kubectl get pods` indistinguishable from
// `kubectl delete namespace` -- both red, both approval-gated -- which is precisely
// the approval fatigue the risk model exists to avoid.
// --------------------------------------------------------------------------

/** Verbs that only read cluster state. */
const KUBECTL_READ = new Set([
  'get', 'describe', 'logs', 'top', 'events', 'explain', 'version', 'api-resources',
  'api-versions', 'cluster-info', 'config', 'auth', 'diff', 'wait',
]);

/** Deleting these takes out far more than the object named. */
const K8S_FORBIDDEN_RESOURCES = new Set([
  'namespace', 'namespaces', 'ns',
  'crd', 'crds', 'customresourcedefinition', 'customresourcedefinitions',
  'clusterrole', 'clusterroles', 'clusterrolebinding', 'clusterrolebindings',
  'node', 'nodes', 'storageclass', 'storageclasses', 'pv', 'persistentvolume',
]);

const K8S_POD_RESOURCES = new Set(['pod', 'pods', 'po']);

function classifyKubectl(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const args = cmd.args.filter((a) => !a.startsWith('-'));
  const verb = args[0];
  if (!verb) return hit('shell.kubectl', 'read_only', 'kubectl with no subcommand prints help');

  // `kubectl exec pod -- <cmd>` runs an arbitrary command inside a container. Without
  // recursion this is a universal bypass, so the inner command decides the tier.
  if (verb === 'exec' || verb === 'run') {
    const sep = cmd.args.indexOf('--');
    const inner = sep >= 0 ? cmd.args.slice(sep + 1) : [];
    if (verb === 'run' && sep < 0) {
      return hit('shell.kubectl.run', 'medium', 'kubectl run creates a new workload');
    }
    if (inner.length === 0) {
      return hit('shell.kubectl.exec', 'high', 'kubectl exec opens an unreviewable shell in a container');
    }
    const worst = classifyNested(inner, target);
    if (!worst) {
      return hit('shell.kubectl.exec', 'high', `kubectl exec -- "${inner.join(' ')}" could not be read safely`);
    }
    return { ...worst, reason: `kubectl exec: ${worst.reason}` };
  }

  if (KUBECTL_READ.has(verb)) {
    return hit(`shell.kubectl.${verb}`, 'read_only', `kubectl ${verb} only reads cluster state`);
  }

  if (verb === 'rollout') {
    const sub = args[1];
    if (sub === 'status' || sub === 'history') {
      return hit('shell.kubectl.rollout.read', 'read_only', `kubectl rollout ${sub} only reads`);
    }
    return hit('shell.kubectl.rollout', 'medium', `kubectl rollout ${sub ?? ''} restarts workloads`);
  }

  if (verb === 'scale') {
    const zero = cmd.args.some((a) => a === '--replicas=0' || a === '0');
    return zero
      ? hit('shell.kubectl.scale.zero', 'high', 'scaling to zero replicas takes the workload offline')
      : hit('shell.kubectl.scale', 'medium', 'kubectl scale changes replica count');
  }

  if (verb === 'delete') {
    const resource = args[1]?.split('/')[0]?.toLowerCase();
    if (resource && K8S_FORBIDDEN_RESOURCES.has(resource)) {
      return hit(
        'shell.kubectl.delete.cluster',
        'forbidden',
        `deleting a ${resource} destroys everything inside it`,
      );
    }
    // A sweep across every namespace has an unknowable blast radius.
    if (cmd.args.some((a) => a === '--all-namespaces' || a === '-A' || a === '--all')) {
      return hit('shell.kubectl.delete.all', 'high', 'kubectl delete across all namespaces or all objects');
    }
    if (resource && K8S_POD_RESOURCES.has(resource)) {
      return hit('shell.kubectl.delete.pod', 'medium', 'deleting a pod; the controller should recreate it');
    }
    return hit('shell.kubectl.delete', 'high', `kubectl delete ${resource ?? ''} removes a cluster object`);
  }

  if (['drain', 'taint', 'apply', 'patch', 'replace', 'edit'].includes(verb)) {
    return hit(`shell.kubectl.${verb}`, 'high', `kubectl ${verb} changes cluster state directly`);
  }
  if (['cordon', 'uncordon', 'annotate', 'label', 'set', 'expose', 'autoscale'].includes(verb)) {
    return hit(`shell.kubectl.${verb}`, 'medium', `kubectl ${verb} modifies an object`);
  }
  if (verb === 'port-forward' || verb === 'proxy' || verb === 'cp') {
    return hit(`shell.kubectl.${verb}`, 'medium', `kubectl ${verb} opens a channel into the cluster`);
  }

  return hit('shell.kubectl.other', 'high', `unrecognised kubectl verb "${verb}"`);
}

/** k3s wraps kubectl; classify what follows. */
function classifyK3s(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  if (cmd.args[0] === 'kubectl') {
    return classifyKubectl({ ...cmd, name: 'kubectl', args: cmd.args.slice(1) }, target);
  }
  return hit('shell.k3s', 'high', `k3s ${cmd.args.join(' ')} manages the cluster itself`);
}

const DOCKER_READ = new Set([
  'ps', 'logs', 'inspect', 'stats', 'images', 'version', 'info', 'top', 'port',
  'diff', 'history', 'events', 'search',
]);

function classifyDocker(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const args = cmd.args.filter((a) => !a.startsWith('-'));
  const verb = args[0];
  if (!verb) return hit('shell.docker', 'read_only', 'docker with no subcommand prints help');

  // Flags that hand the container the host. These are not recoverable mistakes, so
  // they are checked before the verb -- `docker run --privileged` is forbidden
  // regardless of how benign the rest of the line looks.
  if (hasHostEscape(cmd.args)) {
    return hit(
      'shell.docker.escape',
      'forbidden',
      'this container would have host-level access (privileged, a host namespace, the docker socket, or / mounted in)',
    );
  }

  if (DOCKER_READ.has(verb)) {
    return hit(`shell.docker.${verb}`, 'read_only', `docker ${verb} only reads`);
  }

  if (verb === 'exec') {
    // Same bypass as kubectl exec: the inner command is what matters.
    const rest = cmd.args.filter((a) => !a.startsWith('-'));
    const inner = rest.slice(2);
    if (inner.length === 0) {
      return hit('shell.docker.exec', 'high', 'docker exec opens an unreviewable shell in a container');
    }
    const worst = classifyNested(inner, target);
    if (!worst) {
      return hit('shell.docker.exec', 'high', `docker exec "${inner.join(' ')}" could not be read safely`);
    }
    return { ...worst, reason: `docker exec: ${worst.reason}` };
  }

  if (verb === 'prune' || cmd.args.includes('prune')) {
    return hit('shell.docker.prune', 'high', 'docker prune deletes unused objects in bulk');
  }
  if (['rm', 'rmi', 'kill'].includes(verb)) {
    return hit(`shell.docker.${verb}`, 'high', `docker ${verb} destroys a container or image`);
  }
  if (['volume', 'network', 'system'].includes(verb)) {
    const sub = args[1];
    if (sub === 'ls' || sub === 'inspect') {
      return hit(`shell.docker.${verb}.read`, 'read_only', `docker ${verb} ${sub} only reads`);
    }
    return hit(`shell.docker.${verb}`, 'high', `docker ${verb} ${sub ?? ''} changes shared infrastructure`);
  }
  if (['start', 'restart', 'stop', 'pause', 'unpause', 'cp', 'update', 'rename', 'run', 'create'].includes(verb)) {
    return hit(`shell.docker.${verb}`, 'medium', `docker ${verb} changes what is running`);
  }
  if (verb === 'compose' || verb === 'stack') {
    const sub = args[1];
    if (sub === 'ps' || sub === 'logs' || sub === 'config') {
      return hit('shell.docker.compose.read', 'read_only', `docker ${verb} ${sub} only reads`);
    }
    if (sub === 'down') {
      return hit('shell.docker.compose.down', 'high', 'docker compose down stops and removes the stack');
    }
    return hit('shell.docker.compose', 'medium', `docker ${verb} ${sub ?? ''} changes the stack`);
  }

  return hit('shell.docker.other', 'high', `unrecognised docker verb "${verb}"`);
}

/** Container-escape flags, checked as whole tokens rather than substrings. */
function hasHostEscape(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--privileged') return true;
    if (/^--(pid|net|network|ipc|uts)=host$/.test(a)) return true;
    if (/^--cap-add(=|$)/.test(a)) {
      const cap = a.includes('=') ? a.split('=')[1] : args[i + 1];
      if (cap && /SYS_ADMIN|ALL/i.test(cap)) return true;
    }
    // The docker socket is a root shell on the host by another name.
    if (a.includes('/var/run/docker.sock')) return true;

    // Host root mounted into the container: `-v /:/host` or `--volume=/:/host`.
    const mount = a === '-v' || a === '--volume' ? args[i + 1] : /^--volume=/.test(a) ? a.slice(9) : null;
    if (mount && /^\/:/.test(mount)) return true;
  }
  return false;
}

const HELM_READ = new Set(['list', 'ls', 'status', 'get', 'history', 'show', 'version', 'search', 'template', 'lint']);

function classifyHelm(cmd: SimpleCommand): RuleHit {
  const args = cmd.args.filter((a) => !a.startsWith('-'));
  const verb = args[0];
  if (!verb) return hit('shell.helm', 'read_only', 'helm with no subcommand prints help');
  if (verb === 'repo') {
    const sub = args[1];
    return sub === 'list'
      ? hit('shell.helm.repo.list', 'read_only', 'helm repo list only reads')
      : hit('shell.helm.repo', 'low', `helm repo ${sub ?? ''} changes local repo config`);
  }
  if (HELM_READ.has(verb)) return hit(`shell.helm.${verb}`, 'read_only', `helm ${verb} only reads`);
  if (['uninstall', 'delete', 'rollback'].includes(verb)) {
    return hit(`shell.helm.${verb}`, 'high', `helm ${verb} tears down or reverts a release`);
  }
  if (['install', 'upgrade'].includes(verb)) {
    return hit(`shell.helm.${verb}`, 'medium', `helm ${verb} deploys a release`);
  }
  return hit('shell.helm.other', 'high', `unrecognised helm verb "${verb}"`);
}

/**
 * Classify a nested argv (the tail of `kubectl exec -- …` or `docker exec …`),
 * returning the worst tier found, or null when it cannot be read safely.
 */
function classifyNested(inner: string[], target: ResolvedTarget): RuleHit | null {
  const joined = inner.join(' ');
  const lexed = lexInner(joined);
  if (!lexed || lexed.length === 0) return null;
  return lexed
    .map((c) => classifySimpleCommand(c, target))
    .reduce((a, b) => (RANK[a.tier] >= RANK[b.tier] ? a : b));
}
