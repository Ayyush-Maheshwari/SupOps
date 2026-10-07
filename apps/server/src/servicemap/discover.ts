import { eq } from 'drizzle-orm';
import { ciItems, settings } from '@supops/db';
import type { CiType } from '@supops/db';
import type { ResolvedTarget } from '@supops/core';
import {
  IGNORED_PORTS,
  WELL_KNOWN,
  kubectlExec,
  loadTargets,
  normalizeName,
  parseConnections,
  parseKubernetes,
  parseListening,
  pinHostKey,
  promInstant,
  resolveSecret,
  sshExec,
} from '@supops/core';
import { isObservabilityKind } from '@supops/shared';
import { db } from '../context.ts';
import { findItem, projectItems, pruneObserved, upsertItem, upsertLink } from './store.ts';

/**
 * Discovery: what is actually there, from every live source SupOps can read. Each
 * source is independent -- a project with no documents, or machines that are not
 * registered, still gets a map from what the others can see -- and each fact it adds
 * carries its own evidence. Everything here is read-only.
 */

export interface DiscoveryReport {
  at: number;
  sources: Record<'targets' | 'network' | 'kubernetes' | 'metrics', { checked: number; found: number; errors: string[] }>;
  archived: { items: number; links: number };
}

const SPLIT = '__SUPOPS_SPLIT__';
const KEEP_OBSERVED_MS = 15 * 86_400_000;

function withSecret(t: ResolvedTarget): ResolvedTarget {
  const s = resolveSecret(db, t);
  return s ? { ...t, secret: s.value } : t;
}

const ctxFor = (t: ResolvedTarget, timeoutMs = 25_000) => ({
  runId: 'service-map',
  toolCallId: 'service-map',
  target: withSecret(t),
  timeoutMs,
  maxOutputBytes: 4_000_000,
  signal: AbortSignal.timeout(timeoutMs * 2),
  onNewHostKey: (fp: string) => pinHostKey(db, t.id, fp),
});

/** Every registered machine, cluster and connection is a component. */
export function fromTargets(projectId: string): { checked: number; found: number; errors: string[] } {
  const ts = loadTargets(db, projectId);
  for (const t of ts) {
    const cfg = t.config as { kind: string; host?: string; addresses?: string[]; via?: { alias?: string }; baseUrl?: string };
    const type: CiType = t.kind === 'ssh' ? 'host' : t.kind === 'k8s' ? 'cluster' : isObservabilityKind(t.kind) ? 'monitoring' : 'service';
    const aliases = [
      ...(cfg.via?.alias ? [cfg.via.alias] : cfg.host ? [cfg.host] : []),
      ...(cfg.addresses ?? []),
      ...(cfg.baseUrl ? [(() => { try { return new URL(cfg.baseUrl!).hostname; } catch { return ''; } })()] : []),
    ].filter(Boolean);
    upsertItem(projectId, { key: t.slug, name: t.slug, type, env: t.env, description: t.description, aliases, targetId: t.id }, { source: 'target', ref: t.id, detail: `registered ${t.kind} target ${t.slug}` });
  }
  return { checked: ts.length, found: ts.length, errors: [] };
}

/** The service a port is, on a host: typed when the port is well known. */
function serviceOn(projectId: string, hostKey: string, hostName: string, port: number, process: string | null, ref: string, detail: string) {
  const wk = WELL_KNOWN[port];
  const svcName = wk?.name ?? process ?? `port ${port}`;
  // One component per port on a host, whichever side saw it and whether or not it knew the process.
  const key = `${port}@${hostKey}`;
  const item = upsertItem(projectId, { key, name: `${svcName} on ${hostName}`, type: wk?.type ?? 'service', attrs: { port: String(port), ...(process ? { process } : {}) } }, { source: 'network', ref, detail });
  if (item.name.startsWith(`port ${port} on `) && svcName !== `port ${port}` && !item.locked) {
    return db.update(ciItems).set({ name: `${svcName} on ${hostName}`, updatedAt: new Date() }).where(eq(ciItems.id, item.id)).returning().get();
  }
  return item;
}

/** What each registered machine listens on and talks to (`ss`, read-only). */
export async function fromNetwork(projectId: string): Promise<{ checked: number; found: number; errors: string[] }> {
  const hosts = loadTargets(db, projectId).filter((t) => t.kind === 'ssh');
  const errors: string[] = [];
  let found = 0;
  for (const t of hosts) {
    const out = await sshExec(`ss -tlnpH 2>/dev/null || ss -tlnH; echo ${SPLIT}; ss -tnpH state established 2>/dev/null || ss -tnH state established`, ctxFor(t)).catch((e: Error) => ({ ok: false, text: e.message }));
    if (!out.ok || !out.text.includes(SPLIT)) {
      errors.push(`${t.slug}: ${out.text.split('\n')[0]?.slice(0, 160) ?? 'no answer'}`);
      continue;
    }
    const [listenText, connText] = out.text.split(SPLIT);
    const host = findItem(projectId, { targetId: t.id, name: t.slug })!;
    // The scan itself: a documented connection from here that it does not see is drift.
    upsertItem(projectId, { key: host.key, name: host.name, type: 'host', targetId: t.id }, { source: 'network', ref: `scan:${t.id}`, detail: 'connections checked' });

    const listening = parseListening(listenText ?? '');
    const listenPorts = new Set(listening.map((l) => l.port));
    for (const l of listening) {
      if (IGNORED_PORTS.has(l.port)) continue;
      const interesting = WELL_KNOWN[l.port] || [80, 443, 8080, 8443].includes(l.port) || (l.process && l.port >= 1024 && l.port < 10_000);
      if (!interesting) continue;
      const svc = serviceOn(projectId, host.key, host.name, l.port, l.process, `${t.id}:listen:${l.port}`, `listening on ${l.port}${l.process ? ` (${l.process})` : ''}`);
      upsertLink(projectId, svc.id, host.id, 'runs_on', { source: 'network', ref: `${t.id}:listen:${l.port}`, detail: `seen on ${t.slug}` });
      found++;
    }

    for (const c of parseConnections(connText ?? '').slice(0, 300)) {
      const outbound = !listenPorts.has(c.localPort) && c.peerPort < 32_768 && !IGNORED_PORTS.has(c.peerPort);
      if (outbound) {
        const known = findItem(projectId, { name: c.peer });
        const wk = WELL_KNOWN[c.peerPort];
        const peer = known ?? upsertItem(projectId, { name: c.peer, type: wk ? 'host' : 'external', aliases: [] }, { source: 'network', ref: `${t.id}:peer:${c.peer}`, detail: `connected to from ${t.slug}` });
        const target = wk || known?.type === 'host' ? serviceOn(projectId, peer.key, peer.name, c.peerPort, null, `${t.id}:out:${c.peer}:${c.peerPort}`, `${t.slug} connects to ${c.peer}:${c.peerPort}`) : peer;
        if (target.id !== peer.id) upsertLink(projectId, target.id, peer.id, 'runs_on', { source: 'network', ref: `${t.id}:out:${c.peer}:${c.peerPort}`, detail: `${c.peer}:${c.peerPort}` });
        upsertLink(projectId, host.id, target.id, 'depends_on', { source: 'network', ref: `${t.id}:out:${c.peer}:${c.peerPort}`, detail: `${t.slug}${c.process ? ` (${c.process})` : ''} -> ${c.peer}:${c.peerPort}` }, { detail: `tcp/${c.peerPort}` });
        found++;
      } else if (listenPorts.has(c.localPort) && !IGNORED_PORTS.has(c.localPort)) {
        // Someone we know connects to a service here: they depend on it.
        const client = findItem(projectId, { name: c.peer });
        if (!client || client.id === host.id) continue;
        const svc = serviceOn(projectId, host.key, host.name, c.localPort, null, `${t.id}:in:${c.peer}:${c.localPort}`, `${client.name} connects in on ${c.localPort}`);
        upsertLink(projectId, svc.id, host.id, 'runs_on', { source: 'network', ref: `${t.id}:listen:${c.localPort}`, detail: `seen on ${t.slug}` });
        upsertLink(projectId, client.id, svc.id, 'depends_on', { source: 'network', ref: `${t.id}:in:${c.peer}:${c.localPort}`, detail: `${c.peer} -> ${t.slug}:${c.localPort}` }, { detail: `tcp/${c.localPort}` });
        found++;
      }
    }
  }
  return { checked: hosts.length, found, errors };
}

/** Workloads, services, ingresses and configured connections, from each cluster. */
export async function fromKubernetes(projectId: string): Promise<{ checked: number; found: number; errors: string[] }> {
  const clusters = loadTargets(db, projectId).filter((t) => t.kind === 'k8s');
  const errors: string[] = [];
  let found = 0;
  for (const t of clusters) {
    const what = 'get deployments,statefulsets,daemonsets,services,ingresses -o json';
    const allowed = ((t.config as { allowedNamespaces?: string[] }).allowedNamespaces ?? []).filter(Boolean);
    const runs = allowed.length ? allowed.map((ns) => `${what} -n ${ns}`) : [`${what} -A`];
    const objects: unknown[] = [];
    for (const args of runs) {
      const out = await kubectlExec(args, ctxFor(t, 40_000));
      if (!out.ok) {
        errors.push(`${t.slug}: ${out.text.split('\n')[0]?.slice(0, 160)}`);
        continue;
      }
      try {
        objects.push(...((JSON.parse(out.text) as { items?: unknown[] }).items ?? []));
      } catch {
        errors.push(`${t.slug}: the cluster's answer was too large or not JSON`);
      }
    }
    const cluster = findItem(projectId, { targetId: t.id, name: t.slug });
    const parsed = parseKubernetes({ items: objects as never }, t.slug);
    for (const it of parsed.items) {
      const row = upsertItem(projectId, it, { source: 'kubernetes', ref: `${t.id}:${it.key}`, detail: it.attrs.kubernetes ?? null });
      if (cluster) upsertLink(projectId, row.id, cluster.id, 'runs_on', { source: 'kubernetes', ref: `${t.id}:${it.key}`, detail: `in cluster ${t.slug}` });
      found++;
    }
    for (const l of parsed.links) {
      const from = findItem(projectId, { key: l.from, name: l.from });
      if (!from) continue;
      const to = (l.toIsKey ? findItem(projectId, { key: l.to, name: l.to }) : findItem(projectId, { name: l.to })) ??
        upsertItem(projectId, { name: l.to, type: 'external' }, { source: 'kubernetes', ref: `${t.id}:host:${l.to}`, detail: `named in ${from.name}'s settings` });
      upsertLink(projectId, from.id, to.id, l.kind, { source: 'kubernetes', ref: `${t.id}:${l.from}:${l.to}:${l.kind}`, detail: l.detail }, { detail: l.detail });
      found++;
    }
  }
  return { checked: clusters.length, found, errors };
}

const GENERIC_JOB = /^(node|nodes|node[-_]exporter|prometheus|kubelet|cadvisor|kube[-_].*|kubernetes[-_].*|apiserver|blackbox|serviceMonitor\/.*)$/i;
const EXPORTERS: Array<{ metric: string; name: string; type: CiType }> = [
  { metric: 'pg_up', name: 'postgresql', type: 'database' },
  { metric: 'mysql_up', name: 'mysql', type: 'database' },
  { metric: 'mongodb_up', name: 'mongodb', type: 'database' },
  { metric: 'redis_up', name: 'redis', type: 'cache' },
  { metric: 'memcached_up', name: 'memcached', type: 'cache' },
  { metric: 'rabbitmq_identity_info', name: 'rabbitmq', type: 'queue' },
  { metric: 'kafka_brokers', name: 'kafka', type: 'queue' },
  { metric: 'elasticsearch_cluster_health_status', name: 'elasticsearch', type: 'database' },
  { metric: 'nginx_up', name: 'nginx', type: 'load_balancer' },
  { metric: 'haproxy_up', name: 'haproxy', type: 'load_balancer' },
];

/** What metrics reveal: scraped machines, exporters (= services) on them, and service-to-service traffic. */
export async function fromMetrics(projectId: string): Promise<{ checked: number; found: number; errors: string[] }> {
  const conns = loadTargets(db, projectId).filter((t) => t.kind === 'prometheus' || t.kind === 'grafana').map(withSecret);
  const errors: string[] = [];
  let found = 0;
  for (const c of conns) {
    const self = findItem(projectId, { targetId: c.id, name: c.slug });
    const up = await promInstant(c, 'count by (job, instance) (up)');
    if ('error' in up) {
      errors.push(`${c.slug}: ${up.error.slice(0, 160)}`);
      continue;
    }
    const hostByInstance = new Map<string, string>();
    for (const s of up.samples.slice(0, 1000)) {
      const job = s.metric.job ?? '';
      const instance = s.metric.instance ?? '';
      if (!instance) continue;
      const perVmJob = job && !GENERIC_JOB.test(job);
      const name = perVmJob ? normalizeName(job) : normalizeName(instance);
      const nodeLike = /node|windows/i.test(job);
      const row = upsertItem(projectId, { name, type: nodeLike ? 'host' : 'service', aliases: [instance, ...(perVmJob ? [job] : [])] }, { source: 'metrics', ref: `${c.id}:up:${job}:${instance}`, detail: `scraped by ${c.slug} as job ${job}` });
      hostByInstance.set(instance, row.id);
      if (self) upsertLink(projectId, self.id, row.id, 'monitors', { source: 'metrics', ref: `${c.id}:up:${job}:${instance}` });
      found++;
    }
    for (const ex of EXPORTERS) {
      const r = await promInstant(c, `count by (instance, job) (${ex.metric})`);
      if ('error' in r) continue;
      for (const s of r.samples.slice(0, 200)) {
        const instance = s.metric.instance ?? '';
        const host = findItem(projectId, { name: instance }) ?? findItem(projectId, { name: s.metric.job ?? '' });
        const hostKey = host?.key ?? normalizeName(instance);
        const port = Object.entries(WELL_KNOWN).find(([, v]) => v.name === ex.name)?.[0];
        const svc = upsertItem(projectId, { key: port ? `${port}@${hostKey}` : `${ex.name}@${hostKey}`, name: `${ex.name} on ${host?.name ?? hostKey}`, type: ex.type, aliases: [] }, { source: 'metrics', ref: `${c.id}:${ex.metric}:${instance}`, detail: `${ex.metric} exported by ${instance}` });
        if (host) upsertLink(projectId, svc.id, host.id, 'runs_on', { source: 'metrics', ref: `${c.id}:${ex.metric}:${instance}` });
        found++;
      }
    }
    // Traffic between services, where tracing or a mesh records it.
    const graphs: Array<{ q: string; from: (m: Record<string, string>) => string; to: (m: Record<string, string>) => string; label: string }> = [
      { q: 'sum by (client, server) (rate(traces_service_graph_request_total[1h])) > 0', from: (m) => m.client ?? '', to: (m) => m.server ?? '', label: 'traced requests' },
      { q: 'sum by (source_workload, destination_workload) (rate(istio_requests_total[1h])) > 0', from: (m) => m.source_workload ?? '', to: (m) => m.destination_workload ?? '', label: 'mesh requests' },
    ];
    for (const g of graphs) {
      const r = await promInstant(c, g.q);
      if ('error' in r) continue;
      for (const s of r.samples.slice(0, 500)) {
        const a = g.from(s.metric);
        const b = g.to(s.metric);
        if (!a || !b || a === b || a === 'unknown' || b === 'unknown') continue;
        const ia = findItem(projectId, { name: a }) ?? upsertItem(projectId, { name: a, type: 'service' }, { source: 'metrics', ref: `${c.id}:svc:${a}`, detail: g.label });
        const ib = findItem(projectId, { name: b }) ?? upsertItem(projectId, { name: b, type: 'service' }, { source: 'metrics', ref: `${c.id}:svc:${b}`, detail: g.label });
        upsertLink(projectId, ia.id, ib.id, 'depends_on', { source: 'metrics', ref: `${c.id}:${g.label}:${a}:${b}`, detail: `${g.label}: ${s.value.toFixed(2)}/s` });
        found++;
      }
    }
  }
  return { checked: conns.length, found, errors };
}

// ---- the job --------------------------------------------------------------------------

const key = (projectId: string) => `servicemap.discovery.${projectId}`;
const running = new Set<string>();

export function lastDiscovery(projectId: string): DiscoveryReport | null {
  return (db.select().from(settings).where(eq(settings.key, key(projectId))).get()?.value as DiscoveryReport | undefined) ?? null;
}

export async function runDiscovery(projectId: string): Promise<DiscoveryReport | { busy: true }> {
  if (running.has(projectId)) return { busy: true };
  running.add(projectId);
  try {
    const empty = { checked: 0, found: 0, errors: [] as string[] };
    const report: DiscoveryReport = { at: Date.now(), sources: { targets: empty, network: empty, kubernetes: empty, metrics: empty }, archived: { items: 0, links: 0 } };
    report.sources.targets = fromTargets(projectId);
    // Each source on its own: one failing never stops the others.
    for (const [name, fn] of [['network', fromNetwork], ['kubernetes', fromKubernetes], ['metrics', fromMetrics]] as const) {
      try {
        report.sources[name] = await fn(projectId);
      } catch (err) {
        report.sources[name] = { checked: 0, found: 0, errors: [err instanceof Error ? err.message : String(err)] };
      }
    }
    const pruned = pruneObserved(projectId, KEEP_OBSERVED_MS);
    report.archived = { items: pruned.archivedItems, links: pruned.archivedLinks };
    db.insert(settings).values({ key: key(projectId), value: report, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: report, updatedAt: new Date() } }).run();
    return report;
  } finally {
    running.delete(projectId);
  }
}

export const projectHasMap = (projectId: string) => projectItems(projectId).length > 0;
