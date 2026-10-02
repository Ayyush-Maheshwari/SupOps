import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import type { RuleHit } from './rule-kit.ts';
import { atLeast, catastrophic, classifyArgv, hit, isProdTarget, worst } from './rule-kit.ts';
import { accessAccounts, isDevicePath, sshPort } from './paths.ts';
import { classifyWrite, operands } from './rules-files.ts';

/*
 * Rules for administering the host itself: services, accounts, firewall, disks,
 * packages, kernel and power.
 *
 * The recurring question is "does this cut SupOps off from the host?" A stopped
 * sshd, a locked login account or a default-drop firewall is not merely risky: once
 * it runs, nobody can connect to undo it, so no approval makes it safe. Those are
 * forbidden. Everything else that changes the host needs a human; reads are free.
 */

const verbOf = (args: string[]): string | undefined => args.find((a) => !a.startsWith('-'));

// ---- services --------------------------------------------------------------

/** Units whose loss severs remote access to the host. */
const ACCESS_UNITS = /^(ssh|sshd|openssh-server|dropbear|networking|network|NetworkManager|systemd-networkd|systemd-resolved|wpa_supplicant|openvpn(@.*|-client@.*)?|wg-quick@.*|tailscaled)(\.service|\.socket)?$/;

/** The audit daemon. Stopping or disabling it blinds the host, like `auditctl -D`. */
const AUDIT_UNITS = /^(auditd|audit|systemd-journald)(\.service|\.socket)?$/;

const SYSTEMCTL_READ = new Set([
  'status', 'show', 'list-units', 'list-unit-files', 'list-dependencies', 'list-jobs', 'list-machines',
  'is-active', 'is-enabled', 'is-failed', 'is-system-running', 'cat', 'list-timers', 'list-sockets',
  'get-default', 'show-environment', 'help',
]);
const SYSTEMCTL_CHANGE = new Set(['start', 'restart', 'try-restart', 'reload', 'reload-or-restart', 'try-reload-or-restart', 'enable', 'reenable', 'preset']);
const SYSTEMCTL_BOOT = new Set(['disable', 'mask', 'unmask', 'set-default', 'daemon-reexec', 'edit', 'set-property', 'revert', 'link', 'set-environment', 'unset-environment']);
const SYSTEMCTL_POWER = new Set(['poweroff', 'reboot', 'halt', 'kexec', 'suspend', 'hibernate', 'hybrid-sleep', 'soft-reboot']);
/** These drop the host to a mode without networking. */
const SYSTEMCTL_SEVER = new Set(['rescue', 'emergency', 'isolate']);

function unitsOf(args: string[], verb: string): string[] {
  const i = args.indexOf(verb);
  return args.slice(i + 1).filter((a) => !a.startsWith('-'));
}

export function classifySystemctl(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const verb = verbOf(cmd.args);
  if (!verb) return hit('shell.systemctl.list', 'read_only', 'systemctl with no verb lists units');
  if (SYSTEMCTL_READ.has(verb)) return hit(`shell.systemctl.${verb}`, 'read_only', `systemctl ${verb} only reads unit state`);
  if (verb === 'daemon-reload') return hit('shell.systemctl.daemon-reload', 'low', 'systemctl daemon-reload re-reads unit files');

  const units = unitsOf(cmd.args, verb);
  const access = units.find((u) => ACCESS_UNITS.test(u));

  if (SYSTEMCTL_POWER.has(verb)) {
    return hit(`shell.systemctl.${verb}`, 'high', `systemctl ${verb} takes the host down`, { category: 'availability' });
  }
  if (SYSTEMCTL_SEVER.has(verb) && (verb !== 'isolate' || !/^(multi-user|graphical)\.target$/.test(units[0] ?? ''))) {
    return hit(`shell.systemctl.${verb}`, 'forbidden', `systemctl ${verb} ${units.join(' ')} drops the host into a mode without remote access`, { category: 'lockout' });
  }
  if (['stop', 'kill', 'disable', 'mask', 'freeze'].includes(verb) && access) {
    return hit(`shell.systemctl.${verb}.access`, 'forbidden', `systemctl ${verb} ${access} cuts the connection SupOps and everyone else use to reach this host`, { category: 'lockout' });
  }
  if (['stop', 'kill', 'disable', 'mask', 'freeze'].includes(verb) && units.some((u) => AUDIT_UNITS.test(u))) {
    return hit(`shell.systemctl.${verb}.audit`, 'forbidden', `systemctl ${verb} ${units.join(' ')} switches off the host's audit logging, the same as disabling auditing directly`, { category: 'anti-forensics' });
  }
  if (verb === 'stop' || verb === 'kill' || verb === 'freeze') {
    return hit(`shell.systemctl.${verb}`, 'medium', `systemctl ${verb} ${units.join(' ')} takes a service offline`, { category: 'availability' });
  }
  if (SYSTEMCTL_CHANGE.has(verb)) {
    const allowed = target.unitAllowlist ?? [];
    if ((verb === 'reload' || verb === 'reload-or-restart') && units.length && units.every((u) => allowed.includes(u))) {
      return hit('shell.systemctl.reload.allowlisted', 'low', `reload of allowlisted unit ${units.join(' ')}`);
    }
    return hit(`shell.systemctl.${verb}`, 'medium', `systemctl ${verb} ${units.join(' ')} interrupts or changes a running service`, { category: 'availability' });
  }
  if (SYSTEMCTL_BOOT.has(verb)) {
    return hit(`shell.systemctl.${verb}`, 'high', `systemctl ${verb} changes how the host boots or runs services`, { category: 'integrity' });
  }
  return hit('shell.systemctl.other', 'high', `unrecognised systemctl verb "${verb}"`);
}

/** `service <name> <action>` */
export function classifyService(cmd: SimpleCommand): RuleHit {
  const [unit = '', action = ''] = cmd.args.filter((a) => !a.startsWith('-'));
  if (cmd.args.includes('--status-all') || action === 'status') return hit('shell.service.status', 'read_only', 'service status only reads');
  if (['stop', 'force-stop'].includes(action) && ACCESS_UNITS.test(unit)) {
    return hit('shell.service.stop.access', 'forbidden', `service ${unit} stop cuts remote access to this host`, { category: 'lockout' });
  }
  if (['stop', 'force-stop'].includes(action) && AUDIT_UNITS.test(unit)) {
    return hit('shell.service.stop.audit', 'forbidden', `service ${unit} stop switches off the host's audit logging`, { category: 'anti-forensics' });
  }
  return hit('shell.service', 'medium', `service ${unit} ${action} changes a running service`, { category: 'availability' });
}

// ---- processes -------------------------------------------------------------

/** Processes whose death takes the host or remote access with it. */
const VITAL_PROCESSES = /^(init|systemd|sshd|dbus-daemon|dbus-broker|systemd-journald|systemd-logind|kubelet|containerd|dockerd)$/;

export function classifyKill(cmd: SimpleCommand): RuleHit {
  const { flags, ops } = operands(cmd.args, ['-s', '-n']);
  if (flags.some((f) => f === '-l' || f === '-L' || f === '--list' || f === '--table')) {
    return hit('shell.kill.list', 'read_only', 'kill -l lists signal names');
  }
  const sig = flags.find((f) => f !== '-s' && f !== '-n' && f !== '--') ?? (flags.includes('-s') ? flags[flags.indexOf('-s') + 1] : undefined);
  if (sig === '-0') return hit('shell.kill.probe', 'read_only', 'kill -0 only checks that a process exists');
  // `kill -9 -1`: the second dash-number is a PID (-1 = every process), not a flag.
  const pids = [...ops, ...flags.slice(1).filter((f) => /^-\d+$/.test(f))];
  if (pids.some((p) => p === '1' || p === '-1')) {
    return hit('shell.kill.init', 'forbidden', pids.includes('-1')
      ? 'kill -1 signals every process the account can reach'
      : 'killing PID 1 (init) halts or panics the host', { category: 'availability' });
  }
  if (!sig || /^-(15|TERM|SIGTERM|1|HUP|SIGHUP)$/i.test(sig)) {
    // The rule can't know which process this PID is -- it could be the database. A
    // graceful signal still needs a human, since stopping the wrong process is an outage.
    return hit('shell.kill.term', 'medium', `kill ${sig ?? '-TERM'} stops a process by PID; which process a PID is cannot be known from the command`, { category: 'availability' });
  }
  if (/^-(9|KILL|SIGKILL)$/i.test(sig)) {
    return hit('shell.kill.force', 'medium', 'kill -9 terminates without cleanup, risking data loss', { category: 'availability' });
  }
  return hit('shell.kill', 'medium', `kill ${sig} signals a process`, { category: 'availability' });
}

/** pkill / killall / killall5 */
export function classifyKillByName(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  if (name === 'killall5') return hit('shell.killall5', 'forbidden', 'killall5 signals every process on the host', { category: 'availability' });
  const { flags, ops } = operands(cmd.args, ['-s', '--signal', '-u', '--user', '-g', '-P', '-t', '-U', '-G']);
  if (flags.includes('-l') || flags.includes('--list')) return hit(`shell.${name}.list`, 'read_only', `${name} -l lists signals`);
  const vital = ops.find((p) => VITAL_PROCESSES.test(p.replace(/^\^|\$$/g, '')));
  if (vital) {
    return hit(`shell.${name}.vital`, 'forbidden', `${name} ${vital} kills a process the host or remote access depends on`, { category: 'availability' });
  }
  if (!ops.length && flags.some((f) => /^-(u|U|-user)$/.test(f))) {
    return hit(`shell.${name}.user`, 'high', `${name} ${cmd.args.join(' ')} kills every process of an account`, { category: 'availability' });
  }
  return hit(`shell.${name}`, 'medium', `${name} ${cmd.args.join(' ')} terminates processes by name`, { category: 'availability' });
}

// ---- scheduled jobs --------------------------------------------------------

export function classifyCrontab(cmd: SimpleCommand): RuleHit {
  const { flags, ops } = operands(cmd.args, ['-u']);
  if (flags.includes('-l')) return hit('shell.crontab.list', 'read_only', 'crontab -l lists scheduled jobs');
  if (flags.includes('-r')) {
    return hit('shell.crontab.remove', 'high', 'crontab -r deletes every scheduled job of the account, with no backup', { category: 'destruction', irreversible: true });
  }
  return hit('shell.crontab.install', 'high', `crontab ${ops[0] ?? '-'} replaces the account's scheduled jobs, code that runs later unattended`, { category: 'persistence' });
}

// ---- accounts --------------------------------------------------------------

const PRIV_GROUPS = /(^|,)(sudo|wheel|root|admin|adm|docker|lxd|disk|shadow|kvm)(,|$)/;

function touchesAccess(ops: string[], target: ResolvedTarget): string | undefined {
  const accts = accessAccounts(target);
  return ops.find((o) => accts.includes(o));
}

export function classifyAccount(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const { flags, ops } = operands(cmd.args, ['-G', '-g', '-s', '-e', '-d', '-u', '-c', '-l', '-p', '-f', '-k', '-K', '-M', '-m', '-x', '-n', '-w', '-i', '-E', '-I', '-W', '--groups', '--shell', '--expiredate', '--home']);
  const access = touchesAccess(ops, target);
  const joined = flags.join(' ');

  switch (name) {
    case 'passwd': {
      // passwd's -l/-d/-e are switches, not value flags, so read its operands afresh.
      const own = operands(cmd.args, ['-n', '-x', '-w', '-i', '-r', '-R', '-P']);
      const locked = touchesAccess(own.ops, target);
      if (own.flags.some((f) => f === '-S' || f === '--status')) return hit('shell.passwd.status', 'read_only', 'passwd -S shows account status');
      if (locked && own.flags.some((f) => /^-(l|d|e|-lock|-delete|-expire)$/.test(f))) {
        return hit('shell.passwd.lock-access', 'forbidden', `passwd ${own.flags.join(' ')} ${locked} locks the account SupOps signs in with`, { category: 'lockout' });
      }
      return hit('shell.passwd', 'high', `passwd changes an account's password or lock state`, { category: 'privilege' });
    }
    case 'chage':
      if (flags.includes('-l') || flags.includes('--list')) return hit('shell.chage.list', 'read_only', 'chage -l shows password ageing');
      if (access) return hit('shell.chage.access', 'forbidden', `chage on ${access} can expire the account SupOps signs in with`, { category: 'lockout' });
      return hit('shell.chage', 'high', 'chage changes password expiry', { category: 'privilege' });
    case 'userdel': case 'deluser':
      if (access) return hit(`shell.${name}.access`, 'forbidden', `${name} ${access} deletes the account SupOps signs in with`, { category: 'lockout', irreversible: true });
      return hit(`shell.${name}`, 'high', `${name} ${ops.join(' ')} deletes an account${flags.some((f) => /^-(r|-remove)/.test(f)) ? ' and its home directory' : ''}`, { category: 'destruction', irreversible: true });
    case 'usermod': {
      if (access && flags.some((f) => /^-(L|e|-lock|-expiredate)$/.test(f) || f === '-s' || f === '--shell')) {
        const shell = cmd.args[cmd.args.findIndex((a) => a === '-s' || a === '--shell') + 1] ?? '';
        const locks = flags.some((f) => /^-(L|e|-lock|-expiredate)$/.test(f)) || /nologin|false/.test(shell);
        if (locks) return hit('shell.usermod.lock-access', 'forbidden', `usermod ${joined} ${access} locks out the account SupOps signs in with`, { category: 'lockout' });
      }
      const groups = cmd.args[cmd.args.findIndex((a) => a === '-G' || a === '--groups' || a === '-aG') + 1] ?? '';
      if (PRIV_GROUPS.test(groups) || cmd.args.some((a) => /^-a?G$/.test(a) && PRIV_GROUPS.test(cmd.args[cmd.args.indexOf(a) + 1] ?? ''))) {
        return hit('shell.usermod.privilege', 'high', `usermod adds ${ops.join(' ')} to a privileged group (${groups})`, { category: 'privilege' });
      }
      return hit('shell.usermod', 'high', `usermod ${joined} changes an account`, { category: 'privilege' });
    }
    case 'useradd': case 'adduser': case 'groupadd': case 'addgroup': case 'newusers':
      return hit(`shell.${name}`, 'high', `${name} creates new accounts or groups`, { category: 'privilege' });
    case 'groupdel': case 'delgroup':
      return hit(`shell.${name}`, 'high', `${name} deletes a group`, { category: 'privilege' });
    case 'gpasswd': case 'groupmod':
      return hit(`shell.${name}`, 'high', `${name} changes group membership`, { category: 'privilege' });
    case 'chpasswd':
      return hit('shell.chpasswd', 'high', 'chpasswd sets passwords in bulk', { category: 'privilege' });
    case 'visudo':
      if (flags.includes('-c') || flags.includes('--check')) return hit('shell.visudo.check', 'read_only', 'visudo -c validates sudoers');
      return hit('shell.visudo', 'high', 'visudo edits sudo rights', { category: 'privilege' });
    case 'chsh':
      if (access) return hit('shell.chsh.access', 'high', `chsh changes the login shell of ${access}`, { category: 'lockout' });
      return hit('shell.chsh', 'high', 'chsh changes a login shell', { category: 'privilege' });
    default:
      return hit(`shell.${name}`, 'high', `${name} changes accounts`, { category: 'privilege' });
  }
}

// ---- firewall --------------------------------------------------------------

const IPT_LIST = new Set(['-L', '--list', '-S', '--list-rules', '-n', '--numeric', '-v', '--verbose', '-x', '--exact', '--line-numbers', '-t', '--table', '-w', '--wait', '-4', '-6']);
const IPT_FLUSH = new Set(['-F', '--flush', '-X', '--delete-chain', '-Z', '--zero']);

function mentionsAccessPort(args: string[], target: ResolvedTarget): boolean {
  const port = String(sshPort(target));
  return args.some((a, i) => (['--dport', '--dports', '--destination-port'].includes(args[i - 1] ?? '') && a.split(/[,:]/).includes(port)) || a === 'ssh' || a === 'OpenSSH' || a === port || a === `${port}/tcp`);
}

export function classifyIptables(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const args = cmd.args;
  if (/-save$/.test(name)) return hit(`shell.${name}`, 'read_only', `${name} prints the current rules`);
  if (/-restore$/.test(name)) return hit(`shell.${name}`, 'high', `${name} replaces the whole rule set`, { category: 'lockout' });

  const table = args[args.findIndex((a) => a === '-t' || a === '--table') + 1];
  const onlyListing = args.every((a, i) => IPT_LIST.has(a) || (['-t', '--table'].includes(args[i - 1] ?? '')) || (!a.startsWith('-') && ['-L', '--list', '-S', '--list-rules'].includes(args[i - 1] ?? '')));
  if (onlyListing && args.some((a) => ['-L', '--list', '-S', '--list-rules'].includes(a))) {
    return hit('shell.firewall.list', 'read_only', 'listing firewall rules');
  }
  const policy = args.findIndex((a) => a === '-P' || a === '--policy');
  if (policy >= 0 && /^(DROP|REJECT)$/i.test(args[policy + 2] ?? '') && /^(INPUT|OUTPUT)$/i.test(args[policy + 1] ?? '')) {
    return hit('shell.firewall.default-drop', 'forbidden', `${name} -P ${args[policy + 1]} ${args[policy + 2]} drops every connection not explicitly allowed, including SupOps's`, { category: 'lockout' });
  }
  if (args.some((a) => IPT_FLUSH.has(a)) && (!table || table === 'filter')) {
    return hit('shell.firewall.flush', 'high', `${name} flushing rules removes the host's protection and any rule that keeps access open`, { category: 'lockout' });
  }
  const jump = args[args.findIndex((a) => a === '-j' || a === '--jump') + 1] ?? '';
  const inbound = args.some((a, i) => ['-A', '-I', '--append', '--insert'].includes(args[i - 1] ?? '') && /^INPUT$/i.test(a));
  if (/^(DROP|REJECT)$/i.test(jump) && inbound) {
    const scoped = args.some((a) => ['-s', '--source', '-i', '--in-interface'].includes(a));
    if (mentionsAccessPort(args, target) || (!scoped && !args.some((a) => ['--dport', '--dports', '-p'].includes(a)))) {
      return hit('shell.firewall.block-access', 'forbidden', `${name} ${args.join(' ')} blocks inbound traffic SupOps needs to reach this host`, { category: 'lockout' });
    }
  }
  return hit('shell.firewall.modify', 'high', `${name} ${args.join(' ')} changes firewall rules`, { category: 'lockout' });
}

export function classifyNft(cmd: SimpleCommand): RuleHit {
  const words = cmd.args.filter((a) => !a.startsWith('-'));
  if (words[0] === 'list' || cmd.args.includes('--check') || cmd.args.includes('-c')) return hit('shell.nft.list', 'read_only', 'nft list reads rules');
  if (words[0] === 'flush' && words[1] === 'ruleset') {
    return hit('shell.nft.flush-ruleset', 'high', 'nft flush ruleset removes every firewall rule', { category: 'lockout' });
  }
  if (cmd.args.includes('-f')) return hit('shell.nft.file', 'high', 'nft -f loads a whole rule set from a file', { category: 'lockout' });
  return hit('shell.nft', 'high', `nft ${cmd.args.join(' ')} changes firewall rules`, { category: 'lockout' });
}

export function classifyUfw(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const words = cmd.args.filter((a) => !a.startsWith('-'));
  const verb = words[0] ?? '';
  if (['status', 'show', 'version'].includes(verb) || (verb === 'app' && ['list', 'info'].includes(words[1] ?? ''))) {
    return hit('shell.ufw.status', 'read_only', `ufw ${verb} reads firewall state`);
  }
  if (verb === 'reset') return hit('shell.ufw.reset', 'high', 'ufw reset deletes every rule', { category: 'lockout' });
  if (verb === 'default' && /deny|reject/.test(words[1] ?? '') && !/outgoing|routed/.test(words[2] ?? '')) {
    return hit('shell.ufw.default-deny', 'high', 'ufw default deny incoming blocks every port not explicitly allowed', { category: 'lockout' });
  }
  if (['deny', 'reject', 'limit'].includes(verb) && mentionsAccessPort(words, target)) {
    return hit('shell.ufw.block-access', 'forbidden', `ufw ${words.join(' ')} blocks the port SupOps connects on`, { category: 'lockout' });
  }
  if (verb === 'delete' && mentionsAccessPort(words, target)) {
    return hit('shell.ufw.delete-access', 'high', `ufw ${words.join(' ')} removes the rule that lets SSH in`, { category: 'lockout' });
  }
  return hit('shell.ufw', 'high', `ufw ${words.join(' ')} changes firewall rules`, { category: 'lockout' });
}

export function classifyFirewallCmd(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const a = cmd.args;
  if (a.length && a.every((x) => /^--(list|get|query|state|info)/.test(x) || /^--(zone|permanent)(=|$)/.test(x))) {
    return hit('shell.firewall-cmd.read', 'read_only', 'firewall-cmd reads configuration');
  }
  if (a.includes('--panic-on')) return hit('shell.firewall-cmd.panic', 'forbidden', 'firewall-cmd --panic-on drops all traffic, including SupOps\'s', { category: 'lockout' });
  const port = String(sshPort(target));
  if (a.some((x) => /^--remove-(service=ssh|port=)/.test(x) && (x.includes('ssh') || x.includes(`=${port}/`)))) {
    return hit('shell.firewall-cmd.remove-access', 'forbidden', 'firewall-cmd removes the rule that lets SSH in', { category: 'lockout' });
  }
  return hit('shell.firewall-cmd', 'high', `firewall-cmd ${a.join(' ')} changes firewall rules`, { category: 'lockout' });
}

// ---- network configuration -------------------------------------------------

const IP_OBJECTS = /^(a|addr|address|l|link|r|route|n|neigh|neighbour|rule|maddr|mroute|tunnel|tuntap|netns|monitor|-?s|stats|vrf|xfrm|ntable|netconf)$/;

export function classifyIp(cmd: SimpleCommand): RuleHit {
  const words = cmd.args.filter((a) => !a.startsWith('-'));
  const [obj = '', verb = 'show'] = words;
  if (!words.length || (IP_OBJECTS.test(obj) && /^(show|list|lst|get|sh|ls)$/.test(verb)) || (IP_OBJECTS.test(obj) && words.length === 1) || obj === 'monitor') {
    return hit('shell.ip.show', 'read_only', 'ip reading network state');
  }
  if (/^(r|route)$/.test(obj) && (verb === 'flush' || (/^(del|delete)$/.test(verb) && words[2] === 'default'))) {
    return hit('shell.ip.route-default', 'forbidden', `ip ${words.join(' ')} removes the route SupOps's connection travels over`, { category: 'lockout' });
  }
  if (/^(a|addr|address)$/.test(obj) && verb === 'flush') {
    return hit('shell.ip.addr-flush', 'forbidden', `ip ${words.join(' ')} strips the host's addresses, dropping every connection`, { category: 'lockout' });
  }
  if (/^(l|link)$/.test(obj) && verb === 'set' && words.includes('down')) {
    return hit('shell.ip.link-down', 'high', `ip ${words.join(' ')} takes an interface down; if it carries SupOps's connection, access is lost`, { category: 'lockout' });
  }
  return hit('shell.ip.change', 'high', `ip ${words.join(' ')} changes network configuration`, { category: 'lockout' });
}

export function classifyIfupdown(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  if (name === 'ifconfig') {
    const words = cmd.args.filter((a) => !a.startsWith('-'));
    if (words.length <= 1) return hit('shell.ifconfig.show', 'read_only', 'ifconfig lists interfaces');
    if (words.includes('down')) return hit('shell.ifconfig.down', 'high', `ifconfig ${words.join(' ')} takes an interface down`, { category: 'lockout' });
    return hit('shell.ifconfig', 'high', `ifconfig ${words.join(' ')} changes an interface`, { category: 'lockout' });
  }
  if (cmd.args.some((a) => a === '-a' || a === '--all')) {
    return hit(`shell.${name}.all`, 'forbidden', `${name} -a brings every interface ${name === 'ifdown' ? 'down' : 'up'}, dropping remote access`, { category: 'lockout' });
  }
  return hit(`shell.${name}`, 'high', `${name} ${cmd.args.join(' ')} reconfigures an interface`, { category: 'lockout' });
}

export function classifyNmcli(cmd: SimpleCommand): RuleHit {
  const words = cmd.args.filter((a) => !a.startsWith('-'));
  const [obj = '', verb = ''] = words;
  if (!words.length || /^(g|general|help)/.test(obj) || verb === '' || /^(s|show|status|list|l|monitor)/.test(verb)) {
    return hit('shell.nmcli.show', 'read_only', 'nmcli reading network state');
  }
  if (/^(n|networking)/.test(obj) && verb === 'off') {
    return hit('shell.nmcli.off', 'forbidden', 'nmcli networking off disables networking entirely', { category: 'lockout' });
  }
  return hit('shell.nmcli', 'high', `nmcli ${words.join(' ')} changes network configuration`, { category: 'lockout' });
}

/** hostnamectl / timedatectl / localectl */
export function classifyCtl(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const verb = verbOf(cmd.args) ?? 'status';
  if (/^(status|show|list-|timesync-status|show-timesync)/.test(verb)) return hit(`shell.${name}.status`, 'read_only', `${name} ${verb} reads settings`);
  return hit(`shell.${name}.set`, 'high', `${name} ${verb} changes host identity or clock`, { category: 'integrity' });
}

export function classifyDate(cmd: SimpleCommand): RuleHit {
  const sets = cmd.args.some((a) => a === '-s' || a.startsWith('--set') || /^-[a-zA-Z]*s/.test(a)) || cmd.args.some((a) => /^[0-9]{8,12}(\.[0-9]{2})?$/.test(a));
  if (sets) return hit('shell.date.set', 'high', 'date -s changes the system clock, which breaks TLS, logs and schedules', { category: 'integrity' });
  return hit('shell.date', 'read_only', 'date prints the time');
}

export function classifyHostname(cmd: SimpleCommand): RuleHit {
  const { flags, ops } = operands(cmd.args, ['-F', '--file']);
  if (!ops.length && !flags.some((f) => f === '-F' || f === '--file' || f === '-b' || f === '--boot')) {
    return hit('shell.hostname', 'read_only', 'hostname prints the host name');
  }
  return hit('shell.hostname.set', 'high', `hostname ${cmd.args.join(' ')} renames the host`, { category: 'integrity' });
}

// ---- disks and filesystems -------------------------------------------------

const deviceOps = (args: string[]) => args.filter((a) => !a.startsWith('-') && (isDevicePath(a) || /^\/dev\//.test(a)));

export function classifyDisk(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const a = cmd.args;
  const devs = deviceOps(a);
  const on = devs.length ? devs.join(' ') : 'a disk';

  if (/^mkfs(\..+)?$|^mke2fs$|^mkswap$|^mkdosfs$|^mkntfs$/.test(name)) {
    return catastrophic(target, `shell.${name}`, `${name} formats ${on}, erasing everything on it`);
  }
  switch (name) {
    case 'wipefs':
      if (a.some((x) => /^-(a|-all|o|-offset)$/.test(x) || /^-[a-z]*a/.test(x)) && !a.includes('-n') && !a.includes('--no-act')) {
        return catastrophic(target, 'shell.wipefs', `wipefs erases the filesystem signatures on ${on}`);
      }
      return hit('shell.wipefs.list', 'read_only', 'wipefs without -a only lists signatures');
    case 'blkdiscard':
      return catastrophic(target, 'shell.blkdiscard', `blkdiscard discards every block on ${on}`);
    case 'fdisk': case 'sfdisk': case 'gdisk': case 'sgdisk': case 'cfdisk':
      if (a.some((x) => /^-(l|-list|s|-show-size|d|-dump|V|-verify|p|-print)$/.test(x)) && name !== 'cfdisk') {
        return hit(`shell.${name}.list`, 'read_only', `${name} listing partitions`);
      }
      if (name === 'sgdisk' && a.some((x) => /^-(Z|o|-zap)/.test(x))) return catastrophic(target, 'shell.sgdisk.zap', `sgdisk wipes the partition table of ${on}`);
      return hit(`shell.${name}`, 'high', `${name} edits the partition table of ${on}`, { category: 'destruction', irreversible: true });
    case 'parted': {
      const script = a.filter((x) => !x.startsWith('-') && !x.startsWith('/dev/'));
      if (a.includes('-l') || a.includes('--list') || (script.length && script.every((w) => w === 'print' || w === 'unit' || /^(s|b|kb|mb|gb|tb|%|cyl|chs|compact)$/i.test(w)))) {
        return hit('shell.parted.list', 'read_only', 'parted printing partitions');
      }
      if (script.some((w) => /^(mklabel|mktable|rm)$/.test(w))) return catastrophic(target, 'shell.parted.destroy', `parted ${script.join(' ')} destroys partitions on ${on}`);
      return hit('shell.parted', 'high', `parted ${script.join(' ')} edits partitions on ${on}`, { category: 'destruction', irreversible: true });
    }
    case 'lvremove': case 'vgremove': case 'pvremove':
      return catastrophic(target, `shell.${name}`, `${name} ${a.join(' ')} deletes LVM storage and the data on it`);
    case 'lvreduce':
      return catastrophic(target, 'shell.lvreduce', 'lvreduce shrinks a volume, destroying data past the new end');
    case 'cryptsetup': {
      const verb = verbOf(a) ?? '';
      if (/^(status|luksDump|isLuks|luksUUID|benchmark|--help)$/.test(verb)) return hit('shell.cryptsetup.read', 'read_only', `cryptsetup ${verb} reads`);
      if (/^(luksFormat|erase|luksErase|reencrypt)$/.test(verb)) return catastrophic(target, 'shell.cryptsetup.format', `cryptsetup ${verb} makes the data on ${on} unrecoverable`);
      if (/^(luksKillSlot|luksRemoveKey)$/.test(verb)) return hit('shell.cryptsetup.killslot', 'high', `cryptsetup ${verb} removes a key; removing the last one loses the data`, { category: 'destruction', irreversible: true });
      return hit('shell.cryptsetup', 'high', `cryptsetup ${verb} changes an encrypted volume`, { category: 'integrity' });
    }
    case 'zpool': case 'zfs': {
      const verb = verbOf(a) ?? '';
      if (/^(list|status|get|iostat|history|events|holds|diff)$/.test(verb)) return hit(`shell.${name}.read`, 'read_only', `${name} ${verb} reads`);
      if (/^(destroy|labelclear)$/.test(verb)) return catastrophic(target, `shell.${name}.destroy`, `${name} ${verb} ${a.slice(1).join(' ')} destroys the pool or dataset`);
      if (verb === 'rollback') return hit('shell.zfs.rollback', 'high', 'zfs rollback discards everything written since the snapshot', { category: 'destruction', irreversible: true });
      return hit(`shell.${name}`, 'high', `${name} ${verb} changes storage`, { category: 'integrity' });
    }
    case 'mount': {
      const ops = a.filter((x) => !x.startsWith('-'));
      if (!a.length || (a.every((x) => /^-(l|t|v|-show-labels|-types|-verbose)$/.test(x) || !x.startsWith('-')) && !ops.length)) {
        return hit('shell.mount.list', 'read_only', 'mount with no target lists mounts');
      }
      return hit('shell.mount', 'high', `mount ${a.join(' ')} changes what is mounted where`, { category: 'integrity' });
    }
    case 'umount':
      if (a.some((x) => x === '-a' || x === '--all') || a.some((x) => /^\/(boot|usr|var|home|etc)?\/?$/.test(x))) {
        return hit('shell.umount.system', 'high', `umount ${a.join(' ')} unmounts a filesystem the system runs from`, { category: 'availability' });
      }
      return hit('shell.umount', 'high', `umount ${a.join(' ')} detaches a filesystem`, { category: 'availability' });
    case 'swapoff': case 'swapon':
      return hit(`shell.${name}`, 'high', `${name} changes swap, which can trigger the OOM killer`, { category: 'availability' });
    case 'lvs': case 'vgs': case 'pvs': case 'lvdisplay': case 'vgdisplay': case 'pvdisplay': case 'lvscan': case 'vgscan': case 'pvscan':
      return hit(`shell.${name}`, 'read_only', `${name} lists LVM state`);
    default:
      return hit(`shell.${name}`, 'high', `${name} ${a.join(' ')} changes storage`, { category: 'integrity' });
  }
}

// ---- packages --------------------------------------------------------------

/** Removing any of these can leave the host unbootable or unreachable. */
const ESSENTIAL_PACKAGES = /^(openssh-server|openssh|ssh|sshd|sudo|systemd|systemd-sysv|libc6|glibc|coreutils|bash|dash|apt|dpkg|rpm|dnf|yum|python3|linux-image.*|linux-generic.*|kernel(-core)?|grub.*|util-linux|login|passwd|libpam.*|pam|init|base-files|network-manager|netplan\.io|iproute2|ca-certificates|openssl|libssl.*)(:.*)?$/;

interface PkgVerbs { read: RegExp; install: RegExp; upgradeAll?: RegExp; remove: RegExp }

const PKG: Record<string, PkgVerbs> = {
  apt: { read: /^(list|show|search|policy|depends|rdepends|changelog|showsrc|madison|help|moo)$/, install: /^(install|reinstall|download|source|build-dep|satisfy)$/, upgradeAll: /^(upgrade|full-upgrade|dist-upgrade)$/, remove: /^(remove|purge|autoremove|autopurge)$/ },
  dnf: { read: /^(list|info|search|provides|whatprovides|repolist|repoquery|history|check-update|check|deplist|help|updateinfo|makecache)$/, install: /^(install|reinstall|downgrade|localinstall|groupinstall|download)$/, upgradeAll: /^(upgrade|update|distro-sync|dsync|upgrade-minimal)$/, remove: /^(remove|erase|autoremove|groupremove|swap)$/ },
  apk: { read: /^(info|search|list|policy|dot|stats|audit|version|verify)$/, install: /^(add|fetch|fix)$/, upgradeAll: /^(upgrade)$/, remove: /^(del|delete)$/ },
  pip: { read: /^(list|show|freeze|check|help|search|config|inspect|debug|index|cache)$/, install: /^(install|download|wheel)$/, remove: /^(uninstall)$/ },
  npm: { read: /^(ls|list|ll|la|view|v|info|show|outdated|search|help|doctor|config|root|prefix|bin|explain|why|fund|ping|whoami)$/, install: /^(install|i|add|ci|update|up|upgrade|link|rebuild|dedupe)$/, remove: /^(uninstall|remove|rm|un|unlink|r|prune)$/ },
  snap: { read: /^(list|info|find|search|changes|change|services|logs|connections|version|known|model)$/, install: /^(install|refresh|revert|enable|start|restart)$/, remove: /^(remove|disable|stop)$/ },
  brew: { read: /^(list|ls|info|search|outdated|deps|uses|config|doctor|leaves)$/, install: /^(install|reinstall|upgrade|tap)$/, remove: /^(uninstall|remove|rm|untap|cleanup)$/ },
  gem: { read: /^(list|query|search|info|specification|contents|dependency|environment|which|outdated)$/, install: /^(install|update)$/, remove: /^(uninstall|cleanup)$/ },
};
const PKG_ALIAS: Record<string, string> = {
  'apt-get': 'apt', 'apt-cache': 'apt', aptitude: 'apt', yum: 'dnf', microdnf: 'dnf', zypper: 'dnf',
  pip3: 'pip', pipx: 'pip', pnpm: 'npm', yarn: 'npm',
};

export function classifyPackage(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const family = PKG[PKG_ALIAS[name] ?? name] ?? PKG.apt!;
  const words = cmd.args.filter((a) => !a.startsWith('-'));
  // pip -m style and `python -m pip` land here with the verb first.
  const verb = words[0] ?? '';
  const pkgs = words.slice(1);

  if (name === 'apt-cache' || !verb || family.read.test(verb)) {
    return hit(`shell.pkg.${name}.read`, 'read_only', `${name} ${verb || ''} only queries packages`.replace(/\s+/g, ' '));
  }
  if (verb === 'update' && (name === 'apt' || name === 'apt-get' || name === 'apk' || name === 'aptitude')) {
    return hit(`shell.pkg.${name}.refresh`, 'low', `${name} update refreshes package lists`);
  }
  if (family.remove.test(verb)) {
    const essential = pkgs.find((p) => ESSENTIAL_PACKAGES.test(p));
    if (essential) {
      return hit(`shell.pkg.${name}.remove-essential`, 'forbidden', `${name} ${verb} ${essential} removes a package the host needs to boot or be reached`, { category: 'lockout' });
    }
    return hit(`shell.pkg.${name}.remove`, 'high', `${name} ${verb} ${pkgs.join(' ')} removes software${verb.includes('purge') ? ' and its configuration' : ''}`, { category: 'availability' });
  }
  if (family.upgradeAll?.test(verb) && !pkgs.length) {
    return hit(`shell.pkg.${name}.upgrade-all`, 'high', `${name} ${verb} upgrades every package on the host at once`, { category: 'availability' });
  }
  if (family.install.test(verb) || family.upgradeAll?.test(verb)) {
    const remote = pkgs.find((p) => /^(https?|git\+|ftp):\/\//.test(p) || /\.(deb|rpm|whl|tgz|tar\.gz)$/.test(p));
    if (remote) {
      return hit(`shell.pkg.${name}.install-file`, 'high', `${name} ${verb} ${remote} installs software from outside the configured repositories`, { category: 'code-execution' });
    }
    return hit(`shell.pkg.${name}.install`, 'medium', `${name} ${verb} ${pkgs.join(' ')} installs or changes software`, { category: 'integrity' });
  }
  if (name === 'npm' && /^(exec|x|run|run-script|start|test|restart|stop)$/.test(verb)) {
    return hit('shell.pkg.npm.run', 'high', `npm ${verb} runs package scripts`, { category: 'code-execution' });
  }
  return hit(`shell.pkg.${name}`, 'high', `unrecognised ${name} verb "${verb}"`);
}

export function classifyDpkgRpm(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const a = cmd.args;
  const ops = a.filter((x) => !x.startsWith('-'));
  if (name === 'dpkg-query' || a.some((x) => /^-(l|L|s|S|p|c|-list|-listfiles|-status|-search|-print-avail|-contents|-get-selections|-print-architecture|-audit|-verify|V)$/.test(x))) {
    return hit(`shell.${name}.query`, 'read_only', `${name} querying packages`);
  }
  if (name === 'rpm' && a.some((x) => /^-q|^--query|^-V|^--verify/.test(x))) return hit('shell.rpm.query', 'read_only', 'rpm query');
  if (a.some((x) => /^-(r|P|e|-remove|-purge|-erase)$/.test(x))) {
    const essential = ops.find((p) => ESSENTIAL_PACKAGES.test(p));
    if (essential) return hit(`shell.${name}.remove-essential`, 'forbidden', `${name} removes ${essential}, which the host needs to boot or be reached`, { category: 'lockout' });
    return hit(`shell.${name}.remove`, 'high', `${name} removes ${ops.join(' ')}`, { category: 'availability' });
  }
  if (a.some((x) => /--force|--nodeps/.test(x))) return hit(`shell.${name}.force`, 'high', `${name} with --force/--nodeps can break the package database`, { category: 'integrity' });
  return hit(`shell.${name}.install`, 'medium', `${name} ${a.join(' ')} installs a package file`, { category: 'integrity' });
}

// ---- kernel and power ------------------------------------------------------

export function classifySysctl(cmd: SimpleCommand): RuleHit {
  const a = cmd.args;
  const writes = a.some((x) => x === '-w' || x === '--write' || x === '-p' || x === '--load' || x === '--system' || /^-[a-zA-Z]*[wp]/.test(x) || (!x.startsWith('-') && x.includes('=')));
  if (!writes) return hit('shell.sysctl.read', 'read_only', 'sysctl reading kernel settings');
  const risky = a.find((x) => /^(kernel\.(sysrq|panic|modules_disabled)|net\.ipv4\.ip_forward|net\.ipv4\.conf\..*\.(rp_filter|forwarding)|vm\.(overcommit|panic_on_oom))/.test(x));
  return hit('shell.sysctl.write', 'high', `sysctl ${a.join(' ')} changes live kernel behaviour${risky ? ` (${risky.split('=')[0]})` : ''}`, { category: 'integrity' });
}

export function classifyModules(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const a = cmd.args;
  if (name === 'modinfo' || name === 'lsmod' || (name === 'modprobe' && a.some((x) => /^-(n|-dry-run|c|-showconfig|D|-show-depends)$/.test(x)))) {
    return hit(`shell.${name}.read`, 'read_only', `${name} reading module information`);
  }
  if (name === 'rmmod' || (name === 'modprobe' && a.some((x) => x === '-r' || x === '--remove'))) {
    return hit(`shell.${name}.remove`, 'high', `${name} unloads a kernel module; unloading a storage or network driver takes that device away`, { category: 'availability' });
  }
  return hit(`shell.${name}`, 'high', `${name} loads code into the running kernel`, { category: 'integrity' });
}

export function classifyPower(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = cmd.name.split('/').pop()!;
  if (name === 'shutdown' && cmd.args.some((a) => a === '-c' || a === '--show')) {
    return hit('shell.shutdown.cancel', 'low', 'shutdown -c cancels a pending shutdown');
  }
  if (name === 'init' || name === 'telinit') {
    const level = cmd.args.find((x) => !x.startsWith('-')) ?? '';
    if (/^[1sS]$/.test(level)) {
      return hit(`shell.${name}.single`, 'forbidden', `${name} ${level} drops to single-user mode, which has no network`, { category: 'lockout' });
    }
    if (/^[qQuU]$/.test(level)) return hit(`shell.${name}.reload`, 'low', `${name} ${level} re-reads its configuration`);
  }
  const why = `${name} ${cmd.args.join(' ')} takes the host down`.trim();
  return hit(`shell.${name}`, 'high', isProdTarget(target) ? `${why}; this is a production host` : why, { category: 'availability' });
}

// ---- security controls -----------------------------------------------------

export function classifySecurityControl(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const a = cmd.args;
  switch (name) {
    case 'getenforce': case 'sestatus': case 'aa-status': case 'apparmor_status':
      return hit(`shell.${name}`, 'read_only', `${name} reads security module state`);
    case 'setenforce':
      return /^(0|permissive)$/i.test(a[0] ?? '')
        ? hit('shell.setenforce.off', 'high', 'setenforce 0 switches SELinux to permissive, disabling enforcement', { category: 'integrity' })
        : hit('shell.setenforce', 'medium', 'setenforce changes SELinux mode', { category: 'integrity' });
    case 'auditctl':
      if (a.every((x) => /^-(l|s|-list|-status)$/.test(x)) && a.length) return hit('shell.auditctl.list', 'read_only', 'auditctl listing audit rules');
      if (a.includes('-D') || (a.includes('-e') && a[a.indexOf('-e') + 1] === '0')) {
        return hit('shell.auditctl.disable', 'forbidden', `auditctl ${a.join(' ')} disables or erases audit rules, blinding the record of what happens next`, { category: 'anti-forensics' });
      }
      return hit('shell.auditctl', 'high', `auditctl ${a.join(' ')} changes what is audited`, { category: 'anti-forensics' });
    case 'aa-disable': case 'aa-complain': case 'aa-teardown':
      return hit(`shell.${name}`, 'high', `${name} relaxes AppArmor confinement`, { category: 'integrity' });
    default:
      return hit(`shell.${name}`, 'high', `${name} changes a security control`, { category: 'integrity' });
  }
}

// ---- wrappers that run another command -------------------------------------

/** `env [-i] [-u NAME] [NAME=value]... [cmd [args]]` */
export function classifyEnv(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const a = cmd.args;
  let i = 0;
  for (; i < a.length; i += 1) {
    const x = a[i]!;
    if (x === '-S' || x === '--split-string' || x.startsWith('--split-string=') || /^-[a-zA-Z]*S/.test(x)) {
      const rest = x.includes('=') ? [x.slice(x.indexOf('=') + 1), ...a.slice(i + 1)] : a.slice(i + 1);
      return classifyArgv(rest, target, 'env -S', true);
    }
    if (x === '-u' || x === '--unset' || x === '-C' || x === '--chdir') { i += 1; continue; }
    if (x.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) continue;
    break;
  }
  const inner = a.slice(i);
  if (!inner.length) return hit('shell.env.print', 'read_only', 'env with no command prints the environment');
  if (inner.some((x) => /^LD_(PRELOAD|LIBRARY_PATH|AUDIT)=/.test(x)) || a.slice(0, i).some((x) => /^LD_(PRELOAD|AUDIT)=/.test(x))) {
    return hit('shell.env.preload', 'high', 'env LD_PRELOAD injects a library into the command', { category: 'code-execution' });
  }
  return classifyArgv(inner, target, 'env', false);
}

/** xargs runs its command once per input item it has not seen yet. */
export function classifyXargs(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { ops } = operands(cmd.args, ['-I', '-i', '-n', '-P', '-L', '-d', '-E', '-a', '-s', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace']);
  if (!ops.length) return hit('shell.xargs.echo', 'read_only', 'xargs with no command echoes its input');
  const inner = classifyArgv(ops, target, 'xargs', false);
  if (inner.tier === 'read_only') return inner;
  return atLeast(inner, 'high', `xargs runs "${ops.join(' ')}" on inputs that are not visible in the command`);
}

/** `watch` hands its argument to `sh -c`, so it reads as a line. */
export function classifyWatch(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const { ops } = operands(cmd.args, ['-n', '--interval', '-d', '--differences', '-g', '-e', '-c', '-q']);
  if (!ops.length) return hit('shell.watch.empty', 'high', 'watch with no command to inspect');
  return classifyArgv(ops, target, 'watch', true);
}

/** Commands that run something detached or later, where no one will be watching. */
export function classifyDeferred(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = cmd.name.split('/').pop()!;
  if (name === 'atq' || (name === 'at' && cmd.args.includes('-l'))) return hit('shell.at.list', 'read_only', 'listing scheduled at jobs');
  if (name === 'atrm') return hit('shell.atrm', 'medium', 'atrm deletes a scheduled job', { category: 'availability' });
  if (name === 'setsid' || name === 'disown') {
    const inner = cmd.args.filter((a, i) => !(a.startsWith('-') && i === 0));
    if (!inner.length) return hit(`shell.${name}`, 'medium', `${name} detaches jobs from the run`, { category: 'persistence' });
    return atLeast(classifyArgv(inner, target, name, false), 'medium', `${name} detaches the command, so it outlives this run`);
  }
  if (name === 'systemd-run') {
    return hit('shell.systemd-run', 'high', `systemd-run ${cmd.args.join(' ')} starts a transient service outside this run`, { category: 'persistence' });
  }
  return hit(`shell.${name}`, 'high', `${name} schedules a command to run later, unattended`, { category: 'persistence' });
}

/** Commands that change the root, namespace or identity a command runs under. */
export function classifyIsolation(cmd: SimpleCommand): RuleHit {
  const name = cmd.name.split('/').pop()!;
  return hit(`shell.${name}`, 'high', `${name} runs a command in another root, namespace or identity, outside what the rules can see`, { category: 'privilege' });
}

// ---- in-place editors ------------------------------------------------------

/** GNU sed: `-i` edits files, and the `e` command / `s///e` / `w file` run or write. */
export function classifySed(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const a = cmd.args;
  const inPlace = a.some((x) => x === '-i' || x.startsWith('-i') || x === '--in-place' || x.startsWith('--in-place=') || (/^-[a-zA-Z]+$/.test(x) && x.includes('i')));
  const scriptIdx = a.findIndex((x) => x === '-e' || x === '--expression');
  const scripts = scriptIdx >= 0
    ? a.filter((_, i) => a[i - 1] === '-e' || a[i - 1] === '--expression')
    : [a.find((x) => !x.startsWith('-')) ?? ''];
  const hits: RuleHit[] = [];

  for (const s of scripts) {
    // `e` as a command (start of a script or after ; { } or an address), or as a flag of `s`.
    if (/(^|[;{}\n]|^\s*[0-9$,/]*\s*)e(\s|$|;)/.test(s) || /^s(.).*\1.*\1[gpIiMm0-9]*e[gpIiMm0-9]*$/.test(s.trim())) {
      hits.push(hit('shell.sed.exec', 'high', `sed script "${s}" uses the e command, which runs its pattern space as a shell command`, { category: 'code-execution' }));
    }
    // `w file` as a command, or the `w` flag of `s///` -- both write the named file.
    const wCmd = /(?:^|[;\n}])\s*[0-9$,/]*[wW]\s+(\S+)/.exec(s);
    const wFlag = /^s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpIiMm0-9e]*w\s*(\S+)/.exec(s.trim());
    const wPath = wFlag?.[2] ?? wCmd?.[1];
    if (wPath && wPath.length > 1) {
      const h = classifyWrite(wPath, 'overwrite', cmd, target, 'sed w');
      if (h) hits.push(h);
    }
  }
  if (a.some((x) => x === '--file' || x === '-f' || x.startsWith('--file='))) {
    hits.push(hit('shell.sed.scriptfile', 'medium', 'sed -f runs a script file whose contents are not visible here', { category: 'code-execution' }));
  }

  if (inPlace) {
    const files = a.filter((x, i) => !x.startsWith('-') && x !== scripts[0] && !['-e', '--expression', '-f', '--file'].includes(a[i - 1] ?? ''));
    for (const f of files) {
      const h = classifyWrite(f, 'edit', cmd, target, 'sed -i');
      if (h) hits.push(h);
    }
    if (!files.length) hits.push(hit('shell.sed.inplace', 'medium', 'sed -i rewrites a file in place', { category: 'integrity' }));
    else if (!hits.length) hits.push(hit('shell.sed.inplace', 'medium', `sed -i rewrites ${files.join(' ')} in place`, { category: 'integrity' }));
    // A plain in-place edit is medium at least: it changes a file.
    return atLeast(worst(hits), 'medium');
  }
  return hits.length ? worst(hits) : hit('shell.sed.read', 'read_only', 'sed without -i only writes to stdout');
}
