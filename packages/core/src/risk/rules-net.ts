import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import type { RuleHit } from './rule-kit.ts';
import { atLeast, classifyArgv, hit, worst } from './rule-kit.ts';
import { classifyPath, resolvePaths } from './paths.ts';
import { classifyWrite, ctxOf, isSensitiveReadPath, operands } from './rules-files.ts';

/*
 * Network clients. Two questions matter: does the command send local data somewhere
 * (exfiltration), and does it write what it fetched somewhere that matters (a
 * download over /etc/passwd, or a payload that is then executed)?
 */

const CURL_VALUE = new Set([
  '-o', '--output', '-X', '--request', '-d', '--data', '--data-binary', '--data-raw', '--data-ascii', '--data-urlencode',
  '-F', '--form', '--form-string', '-T', '--upload-file', '-H', '--header', '-u', '--user', '-A', '--user-agent',
  '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-K', '--config', '-x', '--proxy', '--json', '-w',
  '--write-out', '--connect-timeout', '-m', '--max-time', '--retry', '--cacert', '--cert', '--key', '-E',
  '--resolve', '--unix-socket', '--abstract-unix-socket', '-r', '--range', '-D', '--dump-header', '--output-dir',
  '--create-dirs', '--limit-rate', '-Y', '-y', '-z', '--time-cond', '-P', '--ftp-port', '-Q', '--quote',
]);
const CURL_DATA = new Set(['-d', '--data', '--data-binary', '--data-raw', '--data-ascii', '--data-urlencode', '-F', '--form', '--form-string', '--json', '-T', '--upload-file']);

interface CurlParse { method: string | null; data: string[]; outputs: string[]; remoteName: boolean; head: boolean; urls: string[]; config: boolean; unixSocket: string | null }

function parseCurl(args: string[]): CurlParse {
  const out: CurlParse = { method: null, data: [], outputs: [], remoteName: false, head: false, urls: [], config: false, unixSocket: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const takes = CURL_VALUE.has(flag);
    const val = takes ? (inline ?? args[++i]) : undefined;
    if (flag === '-X' || flag === '--request') out.method = (val ?? '').toUpperCase();
    else if (CURL_DATA.has(flag)) out.data.push(val ?? '');
    else if (flag === '-o' || flag === '--output') out.outputs.push(val ?? '');
    else if (flag === '-O' || flag === '--remote-name' || flag === '--remote-name-all' || /^-[a-zA-Z]*O/.test(flag) && !flag.startsWith('--')) out.remoteName = true;
    else if (flag === '-I' || flag === '--head') out.head = true;
    else if (flag === '-K' || flag === '--config') out.config = true;
    else if (flag === '--unix-socket' || flag === '--abstract-unix-socket') out.unixSocket = val ?? '';
    else if (!a.startsWith('-')) out.urls.push(a);
  }
  return out;
}

/** The local files a curl/wget invocation uploads (`-d @file`, `-F x=@file`, `-T file`). */
function uploadedFiles(values: string[], flagIsUpload = false): string[] {
  return values.flatMap((v) => {
    if (flagIsUpload) return [v];
    const m = v.match(/(?:^|=)@([^;]+)/) ?? v.match(/^<(.+)$/);
    return m ? [m[1]!] : [];
  }).filter((f) => f && f !== '-');
}

export function classifyCurl(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const c = parseCurl(cmd.args);
  const hits: RuleHit[] = [];
  if (c.config) hits.push(hit('shell.curl.config', 'high', 'curl -K reads its options from a file SupOps cannot see', { category: 'code-execution' }));
  if (c.unixSocket && /docker\.sock|containerd|kubelet/.test(c.unixSocket)) {
    hits.push(hit('shell.curl.docker-socket', 'high', `curl over ${c.unixSocket} talks to the container runtime API directly, which is root on the host`, { category: 'privilege' }));
  }
  for (const u of c.urls) {
    if (/^file:\/\//i.test(u) && isSensitiveReadPath(u)) hits.push(hit('shell.curl.file-secret', 'medium', `curl reading credential material via ${u}`, { category: 'secrets' }));
  }
  const uploads = [
    ...uploadedFiles(c.data.filter((_, i) => !['-T', '--upload-file'].includes(String(i)))),
  ];
  // -T takes a bare path; re-scan for it explicitly.
  for (let i = 0; i < cmd.args.length; i += 1) if (cmd.args[i] === '-T' || cmd.args[i] === '--upload-file') uploads.push(cmd.args[i + 1] ?? '');
  for (const f of uploads) {
    if (isSensitiveReadPath(f)) {
      hits.push(hit('shell.curl.exfil', 'forbidden', `curl uploads credential material (${f}) to a remote server`, { category: 'exfiltration' }));
    } else if (f) {
      hits.push(hit('shell.curl.upload', 'high', `curl uploads local file ${f} to ${c.urls.join(' ') || 'a remote server'}`, { category: 'exfiltration' }));
    }
  }
  for (const o of c.outputs) {
    if (o === '-' || o === '/dev/null') continue;
    const w = classifyWrite(o, 'overwrite', cmd, target, 'curl -o');
    if (w) hits.push(w.tier === 'medium' ? { ...w, tier: 'low', reason: `curl downloads to ${o}` } : { ...w, ruleId: w.ruleId.replace('shell.write.', 'shell.curl.') });
    else hits.push(hit('shell.curl.download', 'low', `curl downloads to ${o}`, { category: 'integrity' }));
  }
  if (c.remoteName) hits.push(hit('shell.curl.download', 'low', 'curl -O saves the download in the working directory', { category: 'integrity' }));

  const method = c.method ?? (c.data.length ? 'POST' : c.head ? 'HEAD' : 'GET');
  if (method === 'DELETE') hits.push(hit('shell.curl.delete', 'high', `${cmd.name} -X DELETE`, { category: 'destruction' }));
  else if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) hits.push(hit('shell.curl.write', 'medium', `${cmd.name} ${method} sends a mutating request`, { category: 'integrity' }));

  if (hits.length) return worst(hits);
  return c.head ? hit('shell.curl.head', 'read_only', `${cmd.name} HEAD request`) : hit('shell.curl.get', 'read_only', `${cmd.name} GET request`);
}

export function classifyWget(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const hits: RuleHit[] = [];
  let toStdout = false;
  let spider = false;
  let output: string | null = null;
  let prefix: string | null = null;
  let post = false;
  for (let i = 0; i < cmd.args.length; i += 1) {
    const a = cmd.args[i]!;
    if (a === '--spider') spider = true;
    else if (a === '-O' || a === '--output-document') { output = cmd.args[++i] ?? ''; }
    else if (a.startsWith('--output-document=')) output = a.slice(18);
    else if (/^-[a-zA-Z]*O(-|$)/.test(a) && !a.startsWith('--')) { output = a.endsWith('O') ? (cmd.args[++i] ?? '') : a.slice(a.indexOf('O') + 1); }
    else if (a === '-P' || a === '--directory-prefix') prefix = cmd.args[++i] ?? '';
    else if (a.startsWith('--post-file=') || a === '--post-file' || a.startsWith('--body-file')) {
      const f = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (cmd.args[++i] ?? '');
      post = true;
      hits.push(isSensitiveReadPath(f)
        ? hit('shell.wget.exfil', 'forbidden', `wget uploads credential material (${f})`, { category: 'exfiltration' })
        : hit('shell.wget.upload', 'high', `wget uploads local file ${f}`, { category: 'exfiltration' }));
    } else if (a.startsWith('--post-data') || a.startsWith('--method')) post = true;
    else if (a === '-r' || a === '--recursive' || a === '-m' || a === '--mirror') hits.push(hit('shell.wget.recursive', 'medium', 'wget -r mirrors a whole site to disk', { category: 'resource' }));
  }
  if (output === '-') toStdout = true;
  if (post) hits.push(hit('shell.wget.post', 'medium', 'wget sends a POST request', { category: 'integrity' }));
  if (output && !toStdout) {
    const w = classifyWrite(output, 'overwrite', cmd, target, 'wget -O');
    hits.push(w && w.tier !== 'medium' ? { ...w, ruleId: w.ruleId.replace('shell.write.', 'shell.wget.') } : hit('shell.wget.download', 'low', `wget downloads to ${output}`, { category: 'integrity' }));
  } else if (!toStdout && !spider) {
    const where = prefix ?? cmd.cwd ?? 'the working directory';
    const w = prefix ? classifyWrite(`${prefix}/x`, 'overwrite', cmd, target, 'wget -P') : null;
    hits.push(w && w.tier !== 'medium' ? w : hit('shell.wget.download', 'low', `wget saves the download into ${where}`, { category: 'integrity' }));
  }
  if (hits.length) return worst(hits);
  return hit('shell.wget.get', 'read_only', `wget ${spider ? '--spider' : 'to stdout'}`);
}

/** netcat and friends. `-z` is a port probe; `-e` is a shell handed to the network. */
export function classifyNetcat(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const args = cmd.args;
  const short = args.filter((a) => /^-[^-]/.test(a)).join('');
  if (args.some((a) => ['-e', '-c', '--exec', '--sh-exec', '--lua-exec'].includes(a)) || /e/.test(short.replace(/[^a-zA-Z]/g, '')) && args.some((a) => /^-[a-zA-Z]*e/.test(a))) {
    return hit('shell.nc.exec', 'forbidden', `${cmd.name} -e connects a shell to the network (a bind or reverse shell)`, { category: 'code-execution' });
  }
  const input = cmd.redirects.find((r) => r.op === '<');
  if (input && isSensitiveReadPath(input.path)) {
    return hit('shell.nc.exfil', 'forbidden', `${cmd.name} sends credential material (${input.path}) over the network`, { category: 'exfiltration' });
  }
  if (/z/.test(short)) return hit('shell.nc.probe', 'read_only', `${cmd.name} -z only checks whether a port is open`);
  if (/l/.test(short) || args.includes('--listen')) return hit('shell.nc.listen', 'high', `${cmd.name} -l opens a network listener on the host`, { category: 'exfiltration' });
  if (input) return hit('shell.nc.send-file', 'high', `${cmd.name} sends ${input.path} over the network`, { category: 'exfiltration' });
  void target;
  return hit('shell.nc', 'medium', `${cmd.name} opens a raw network connection`, { category: 'exfiltration' });
}

export function classifySocat(cmd: SimpleCommand): RuleHit {
  const joined = cmd.args.join(' ');
  if (/\b(EXEC|SYSTEM):/i.test(joined)) return hit('shell.socat.exec', 'forbidden', 'socat EXEC:/SYSTEM: wires a program to a network socket (a remote shell)', { category: 'code-execution' });
  if (/-LISTEN/i.test(joined)) return hit('shell.socat.listen', 'high', 'socat opens a network listener', { category: 'exfiltration' });
  return hit('shell.socat', 'high', 'socat relays data between arbitrary endpoints', { category: 'exfiltration' });
}

const SSH_VALUE = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B']);

/**
 * `ssh host cmd` run BY the agent (not SupOps's own transport) reaches a machine
 * outside the registered target list, so neither scope nor per-target policy applies
 * there. The remote command is still read, and decides the floor.
 */
export function classifySsh(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const hits: RuleHit[] = [];
  let i = 0;
  const opts: string[] = [];
  for (; i < cmd.args.length; i += 1) {
    const a = cmd.args[i]!;
    if (!a.startsWith('-')) break;
    opts.push(a);
    if (SSH_VALUE.has(a)) opts.push(cmd.args[++i] ?? '');
  }
  const host = cmd.args[i];
  const remote = cmd.args.slice(i + 1);
  const optStr = opts.join(' ');
  if (/ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand/i.test(optStr)) {
    hits.push(hit('shell.ssh.proxycommand', 'high', 'ssh -o ProxyCommand/LocalCommand runs a local command', { category: 'code-execution' }));
  }
  if (opts.some((o) => ['-L', '-R', '-D', '-W'].includes(o))) {
    hits.push(hit('shell.ssh.tunnel', 'high', 'ssh port forwarding opens a tunnel through the host', { category: 'exfiltration' }));
  }
  if (!host) return hits.length ? worst(hits) : hit('shell.ssh', 'read_only', 'ssh with no host prints usage');
  if (!remote.length) {
    if (cmd.pipedFrom) hits.push(hit('shell.ssh.piped-script', 'forbidden', `piping input into ssh ${host} runs it as a remote shell script`, { category: 'code-execution' }));
    hits.push(hit('shell.ssh.interactive', 'high', `ssh ${host} opens a remote shell outside SupOps's target scope`, { category: 'code-execution' }));
    return worst(hits);
  }
  const inner = classifyArgv(remote, target, `ssh ${host}`, true);
  hits.push(atLeast(inner, 'high', `ssh to ${host} (outside SupOps's target scope)`));
  return worst(hits);
}

const isRemoteSpec = (s: string) => /^([\w.-]+@)?[\w.-]+:/.test(s) && !/^[a-zA-Z]:\\/.test(s) || /^(rsync|scp|sftp|s3|gs|az):\/\//.test(s);

/** scp/rsync: judged by direction -- sending local data out, or writing received data locally. */
export function classifyTransfer(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const name = cmd.name.split('/').pop()!;
  const { flags, ops } = operands(cmd.args, ['-P', '-i', '-o', '-F', '-l', '-c', '-S', '-J', '-e', '--rsh', '--rsync-path', '--exclude', '--include', '--filter', '-f', '--files-from', '--password-file', '--port', '--timeout', '--bwlimit', '--chown', '--chmod', '--backup-dir', '--suffix', '--log-file']);
  const hits: RuleHit[] = [];
  const optStr = flags.join(' ');
  if (/ProxyCommand|LocalCommand/i.test(optStr)) hits.push(hit(`shell.${name}.proxycommand`, 'high', `${name} -o ProxyCommand runs a local command`, { category: 'code-execution' }));
  const dest = ops[ops.length - 1];
  const sources = ops.slice(0, -1);
  if (!dest) return hit(`shell.${name}`, 'medium', `${name} ${cmd.args.join(' ')}`, { category: 'exfiltration' });
  const remoteDest = isRemoteSpec(dest);
  const deletes = flags.some((f) => /^--(delete|del|remove-source-files)/.test(f));

  if (remoteDest) {
    for (const s of sources.filter((x) => !isRemoteSpec(x))) {
      for (const p of resolvePaths(s, ctxOf(cmd, target)).paths) {
        const { cls } = classifyPath(p, target, true);
        if (isSensitiveReadPath(p) || isSensitiveReadPath(s)) hits.push(hit(`shell.${name}.exfil`, 'forbidden', `${name} sends credential material (${s}) to ${dest}`, { category: 'exfiltration' }));
        else if (cls === 'root' || cls === 'top' || cls === 'protected') hits.push(hit(`shell.${name}.exfil-system`, 'forbidden', `${name} copies ${s} (a whole system tree) off the host to ${dest}`, { category: 'exfiltration' }));
      }
    }
    hits.push(hit(`shell.${name}.upload`, 'medium', `${name} copies local data to ${dest}`, { category: 'exfiltration' }));
  } else {
    for (const p of resolvePaths(dest, ctxOf(cmd, target)).paths) {
      const { cls, what } = classifyPath(p, target, true);
      if (deletes && ['root', 'top', 'protected', 'critical', 'access', 'audit'].includes(cls)) {
        hits.push(hit(`shell.${name}.delete-system`, 'forbidden', `${name} --delete into ${what} removes whatever the source lacks`, { category: 'destruction', irreversible: true }));
      }
    }
    const w = classifyWrite(dest, 'overwrite', cmd, target, name);
    if (w && (w.tier === 'high' || w.tier === 'forbidden')) hits.push({ ...w, ruleId: w.ruleId.replace('shell.write.', `shell.${name}.`) });
    hits.push(hit(`shell.${name}.copy`, sources.some(isRemoteSpec) ? 'medium' : 'low', `${name} writes into ${dest}`, { category: 'integrity' }));
  }
  if (deletes) hits.push(hit(`shell.${name}.delete`, 'high', `${name} with --delete/--remove-source-files removes files`, { category: 'destruction', irreversible: true }));
  return worst(hits);
}

export function classifyPing(cmd: SimpleCommand): RuleHit {
  if (cmd.args.some((a) => /^-[a-zA-Z]*f/.test(a) && !a.startsWith('--'))) return hit('shell.ping.flood', 'medium', 'ping -f floods the network', { category: 'resource' });
  return hit('shell.ping', 'read_only', 'ping only checks reachability');
}

// ---- line-level helpers ----------------------------------------------------

const EGRESS_ALWAYS = new Set(['nc', 'ncat', 'netcat', 'nc.openbsd', 'nc.traditional', 'socat', 'telnet', 'scp', 'sftp', 'ftp', 'tftp', 'lftp', 'mail', 'mailx', 'sendmail', 'mutt', 'ssh']);

/**
 * Can this command carry data off the host? Used with "does anything in the line read
 * secrets" to spot exfiltration split across a pipe or `&&`.
 */
export function isEgress(cmd: SimpleCommand): boolean {
  const name = cmd.name.split('/').pop()!;
  if (EGRESS_ALWAYS.has(name)) return !(name.startsWith('nc') && cmd.args.some((a) => /^-[a-zA-Z]*z/.test(a)));
  if (cmd.redirects.some((r) => /^\/dev\/(tcp|udp)\//.test(r.path))) return true;
  if (name === 'curl' || name === 'wget') {
    const c = name === 'curl' ? parseCurl(cmd.args) : null;
    return !!cmd.pipedFrom || cmd.args.some((a) => a.includes('$')) || (c ? c.data.length > 0 || (c.method !== null && c.method !== 'GET') : cmd.args.some((a) => a.startsWith('--post')));
  }
  if (name === 'rsync') return cmd.args.some(isRemoteSpec);
  if (name === 'aws') return /\bs3\b/.test(cmd.args.join(' ')) && cmd.args.some((a) => /^s3:\/\//.test(a)) && cmd.args.some((a) => ['cp', 'sync', 'mv'].includes(a));
  if (name === 'gsutil' || name === 'rclone') return cmd.args.some((a) => ['cp', 'rsync', 'copy', 'sync', 'move'].includes(a));
  if (/^(python\d*(\.\d+)?|perl|ruby|node|php)$/.test(name)) return /socket|urllib|requests|http\.client|fetch\(|Net::|IO::Socket|TCPSocket|http\.request|fsockopen/.test(cmd.args.join(' '));
  return false;
}

/** Where a download lands, so a later `chmod +x`/execution of it can be caught. */
export function downloadTargets(cmd: SimpleCommand): string[] {
  const name = cmd.name.split('/').pop()!;
  const out: string[] = [];
  if (name === 'curl') {
    const c = parseCurl(cmd.args);
    out.push(...c.outputs.filter((o) => o && o !== '-'));
    if (c.remoteName) for (const u of c.urls) out.push(u.split('?')[0]!.split('/').pop() ?? '');
  } else if (name === 'wget') {
    const i = cmd.args.findIndex((a) => a === '-O' || a === '--output-document');
    const inline = cmd.args.find((a) => a.startsWith('--output-document='))?.slice(18);
    const o = inline ?? (i >= 0 ? cmd.args[i + 1] : undefined);
    if (o && o !== '-') out.push(o);
    else if (!o) for (const u of cmd.args.filter((a) => /^(https?|ftp):\/\//.test(a))) out.push(u.split('?')[0]!.split('/').pop() ?? '');
  } else if (name === 'scp' || name === 'rsync') {
    const ops = cmd.args.filter((a) => !a.startsWith('-'));
    if (ops.length > 1 && ops.slice(0, -1).some(isRemoteSpec) && !isRemoteSpec(ops[ops.length - 1]!)) out.push(ops[ops.length - 1]!);
  }
  return out.filter(Boolean).map((p) => (cmd.cwd && !p.startsWith('/') ? `${cmd.cwd.replace(/\/$/, '')}/${p}` : p));
}
