import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolOutput } from '@supops/db';
import type { ExecContext } from '../types.ts';
import { StreamRedactor, redactSecrets, truncateOutput } from '../output.ts';
import { lexShell } from '../../risk/shell-lex.ts';

/**
 * How SupOps reaches a cluster: an API server plus a static credential (normally a
 * service-account token). Stored encrypted as the target's `kubeconfig` credential,
 * as JSON. No exec/auth-provider plugins -- those need cloud CLIs and cloud logins
 * on the SupOps host, and a static token works identically on GKE, EKS, AKS and k3s.
 */
export interface KubeCredential {
  server: string;
  caData?: string;
  insecure?: boolean;
  token?: string;
  clientCertData?: string;
  clientKeyData?: string;
  namespace?: string;
}

export function parseKubeCredential(secret: string): KubeCredential {
  const c = JSON.parse(secret) as KubeCredential;
  if (!c.server) throw new Error('cluster credential has no API server');
  return c;
}

/** Values that must never appear in output: the token and client key/cert bodies. */
export function kubeSecretValues(c: KubeCredential): Array<{ value: string; id: string }> {
  return [
    ...(c.token ? [{ value: c.token, id: 'k8s-token' }] : []),
    ...(c.clientKeyData ? [{ value: c.clientKeyData, id: 'k8s-client-key' }] : []),
    ...(c.clientCertData ? [{ value: c.clientCertData, id: 'k8s-client-cert' }] : []),
  ];
}

/** A one-context kubeconfig in JSON (kubectl reads JSON kubeconfigs natively). */
export function kubeconfigJson(c: KubeCredential, namespace?: string): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{
      name: 'supops',
      cluster: {
        server: c.server,
        ...(c.caData ? { 'certificate-authority-data': c.caData } : {}),
        ...(c.insecure ? { 'insecure-skip-tls-verify': true } : {}),
      },
    }],
    users: [{
      name: 'supops',
      user: {
        ...(c.token ? { token: c.token } : {}),
        ...(c.clientCertData ? { 'client-certificate-data': c.clientCertData } : {}),
        ...(c.clientKeyData ? { 'client-key-data': c.clientKeyData } : {}),
      },
    }],
    contexts: [{
      name: 'supops',
      context: { cluster: 'supops', user: 'supops', ...(namespace ? { namespace } : {}) },
    }],
    'current-context': 'supops',
  });
}

// Flags that would swap the identity or cluster we connect as. The credential is the
// target's, full stop -- `--as=system:admin` or `--kubeconfig=/elsewhere` would let
// the command escape the RBAC the operator granted.
const IDENTITY_FLAGS = [
  '--kubeconfig', '--context', '--cluster', '--user', '--server', '-s', '--token',
  '--as', '--as-group', '--as-uid', '--username', '--password',
  '--certificate-authority', '--client-certificate', '--client-key',
  '--insecure-skip-tls-verify', '--tls-server-name',
];
// Flags that read files on the SupOps server itself (its data dir holds the master
// key), which `create secret --from-file` could then ship into the cluster.
const LOCAL_FILE_FLAGS = ['-f', '--filename', '-k', '--kustomize', '--from-file', '--from-env-file', '--env-file'];
// Flags that never return: the tool is one request, one response.
const STREAMING_FLAGS = ['-w', '--watch', '--watch-only', '--follow', '-i', '--stdin', '-t', '--tty', '-it', '-ti'];
// Verbs that expose the credential, touch the SupOps host, or block forever.
const BLOCKED_VERBS: Record<string, string> = {
  config: 'kubectl config would print the credential SupOps connects with',
  cp: 'kubectl cp reads and writes files on the SupOps server',
  proxy: 'kubectl proxy opens a listener on the SupOps server',
  'port-forward': 'kubectl port-forward opens a listener on the SupOps server',
  attach: 'kubectl attach is interactive',
  plugin: 'kubectl plugins run arbitrary binaries on the SupOps server',
  kustomize: 'kubectl kustomize reads files on the SupOps server',
};

const flagName = (a: string) => a.split('=')[0]!;
const matchesFlag = (a: string, list: string[]) => {
  const f = flagName(a);
  // `-n=foo` style and bare short flags; also `-fpod.yaml` style short-with-value.
  return list.includes(f) || list.some((l) => /^-[a-z]$/.test(l) && a.startsWith(l) && a.length > 2 && !a.startsWith('--'));
};

export interface KubectlPlan {
  ok: true;
  argv: string[];
}
export interface KubectlRefusal {
  ok: false;
  reason: string;
}

/**
 * Turn the model's `args` into a vetted argv, or say why not. Pure: the risk stage
 * and the executor both call it, so what is refused at classification is refused at
 * dispatch too.
 */
export function planKubectl(
  args: string,
  cfg: { allowedNamespaces?: string[]; defaultNamespace?: string },
): KubectlPlan | KubectlRefusal {
  const trimmed = args.trim().replace(/^kubectl\s+/, '');
  if (!trimmed) return { ok: false, reason: 'no kubectl arguments given' };
  const lexed = lexShell(`kubectl ${trimmed}`);
  if (!lexed.ok) return { ok: false, reason: `could not read the arguments safely (${lexed.reason})` };
  if (lexed.commands.length !== 1) {
    return { ok: false, reason: 'one kubectl command per call: no pipes, ;, && or ||' };
  }
  const cmd = lexed.commands[0]!;
  if (cmd.name !== 'kubectl') return { ok: false, reason: 'only kubectl can run on a cluster target' };
  if (cmd.redirects.length) return { ok: false, reason: 'redirects are not supported on a cluster target' };
  const argv = cmd.args;

  // `exec pod -- cmd`: everything after `--` belongs to the container, not kubectl.
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;

  const verb = own.find((a) => !a.startsWith('-'));
  if (verb && BLOCKED_VERBS[verb]) return { ok: false, reason: BLOCKED_VERBS[verb]! };

  for (const a of own) {
    if (verb === 'logs' && a === '-f') return { ok: false, reason: '-f (follow) never returns; use logs --tail=200 or --since=10m' };
    if (matchesFlag(a, IDENTITY_FLAGS)) return { ok: false, reason: `${flagName(a)} is not allowed: the target's own credential is always used` };
    if (matchesFlag(a, LOCAL_FILE_FLAGS)) return { ok: false, reason: `${flagName(a)} reads files on the SupOps server; use patch/set/scale/rollout instead` };
    if (STREAMING_FLAGS.includes(flagName(a))) return { ok: false, reason: `${flagName(a)} never returns; take a snapshot instead (e.g. logs --tail=200, get without -w)` };
  }

  const allowed = (cfg.allowedNamespaces ?? []).filter(Boolean);
  if (allowed.length) {
    if (own.some((a) => a === '-A' || a === '--all-namespaces' || a.startsWith('--all-namespaces='))) {
      return { ok: false, reason: `this cluster is limited to namespaces ${allowed.join(', ')}; name one with -n` };
    }
    const named: string[] = [];
    own.forEach((a, i) => {
      if (a === '-n' || a === '--namespace') { if (own[i + 1]) named.push(own[i + 1]!); }
      else if (a.startsWith('--namespace=')) named.push(a.slice('--namespace='.length));
      else if (a.startsWith('-n=')) named.push(a.slice(3));
      else if (/^-n[^-=]/.test(a)) named.push(a.slice(2));
    });
    const outside = named.filter((n) => !allowed.includes(n));
    if (outside.length) {
      return { ok: false, reason: `namespace ${outside.join(', ')} is outside this target's allowed namespaces (${allowed.join(', ')})` };
    }
  }
  return { ok: true, argv };
}

/** A plain-language pointer for common cluster connection failures. */
export function kubectlErrorHint(text: string): string {
  if (/x509|certificate signed by unknown authority|tls:/i.test(text)) return 'TLS failed: the CA certificate does not match this API server';
  if (/Unauthorized|401/.test(text)) return 'the token was rejected: it may be expired or deleted; recreate it';
  if (/forbidden|cannot (get|list|watch|create|delete|patch|update)/i.test(text)) return 'connected, but the service account lacks RBAC permission for this';
  if (/no such host|lookup .* on/i.test(text)) return 'the API server hostname does not resolve from the SupOps server';
  if (/i\/o timeout|refused|dial tcp|Unable to connect to the server/i.test(text)) return 'the API server is not reachable from the SupOps server (network, firewall or authorized networks)';
  return '';
}

/**
 * Run one kubectl command against the target's cluster.
 *
 * No shell is involved: argv goes straight to the binary, so there is nothing for a
 * pipe or `$(...)` to mean. The kubeconfig lives in a private temp dir for the
 * duration of the call and is always removed.
 */
export async function kubectlExec(args: string, ctx: ExecContext): Promise<ToolOutput> {
  const cfg = ctx.target.config;
  if (cfg.kind !== 'k8s') throw new Error(`Target ${ctx.target.slug} is not a Kubernetes target`);
  if (!ctx.target.secret) {
    return { ok: false, text: `Cluster target ${ctx.target.slug} has no credential; add a kubeconfig/token on the Targets page.`, exitCode: -1 };
  }
  const plan = planKubectl(args, cfg);
  if (!plan.ok) return { ok: false, text: `Refused: ${plan.reason}`, exitCode: -1 };

  const cred = parseKubeCredential(ctx.target.secret);
  const secrets = kubeSecretValues(cred);
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'supops-kube-'));
  const file = join(dir, 'config.json');
  try {
    await writeFile(file, kubeconfigJson(cred, cfg.defaultNamespace || cred.namespace), { mode: 0o600 });
    return await new Promise<ToolOutput>((resolve) => {
      let out = '';
      let settled = false;
      const live = ctx.onChunk ? new StreamRedactor(secrets) : null;
      const emit = (t: string) => {
        if (!live || !ctx.onChunk) return;
        const safe = live.push(t);
        if (safe) ctx.onChunk(safe);
      };
      const child = spawn('kubectl', ['--kubeconfig', file, '--request-timeout=30s', ...plan.argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KUBECONFIG: file, KUBECACHEDIR: join(dir, 'cache') },
      });
      const finish = (o: ToolOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        if (live && ctx.onChunk) { const rest = live.flush(); if (rest) ctx.onChunk(rest); }
        resolve({ ...o, text: redactSecrets(o.text, secrets), durationMs: Date.now() - started });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, text: `kubectl timed out after ${ctx.timeoutMs}ms. Partial output:\n${truncateOutput(out, ctx.maxOutputBytes).text}`, exitCode: -1 });
      }, ctx.timeoutMs);
      const onAbort = () => { child.kill('SIGKILL'); finish({ ok: false, text: 'Run was cancelled; kubectl was terminated.', exitCode: -1 }); };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d: Buffer) => { const t = d.toString('utf8'); out += t; emit(t); });
      child.stderr.on('data', (d: Buffer) => { const t = d.toString('utf8'); out += t; emit(t); });
      child.on('error', (err) => {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        finish({ ok: false, text: missing ? 'kubectl is not installed on the SupOps server.' : `kubectl failed to start: ${err.message}`, exitCode: -1 });
      });
      child.on('close', (code) => {
        const t = truncateOutput(out, ctx.maxOutputBytes);
        const hint = code === 0 ? '' : kubectlErrorHint(out);
        finish({
          ok: code === 0,
          text: (t.text || (code === 0 ? '(no output)' : `kubectl exited ${code}`)) + (hint ? `\n(${hint})` : ''),
          exitCode: code ?? -1,
          truncated: t.truncated,
        });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Connectivity + permission check for the Targets "Test" button. */
export async function kubectlPing(ctx: ExecContext): Promise<ToolOutput> {
  // `get --raw /version` asks only the server (no client-version noise on failure).
  const version = await kubectlExec('get --raw /version', ctx);
  if (!version.ok) return version;
  let server = '';
  try {
    server = (JSON.parse(version.text) as { gitVersion?: string }).gitVersion ?? '';
  } catch { /* non-JSON output: fall through */ }
  const canList = await kubectlExec('auth can-i list pods', ctx);
  const canPatch = await kubectlExec('auth can-i patch deployments', ctx);
  const yes = (o: ToolOutput) => o.text.trim().startsWith('yes');
  return {
    ok: true,
    text: `supops-ok · Kubernetes ${server || 'reachable'} · read pods: ${yes(canList) ? 'yes' : 'no'} · change deployments: ${yes(canPatch) ? 'yes' : 'no'}`,
    exitCode: 0,
  };
}
