import { eq } from 'drizzle-orm';
import { ciItems, settings } from '@supops/db';
import type { CiLinkKind, CiSource } from '@supops/db';
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
import { db } from '../context.ts';
import { addEvidence, findItem, projectItems, projectLinks, pruneObserved } from './store.ts';

/**
 * Live checks. The map is what your documents, diagrams and people say; these only
 * confirm it against what is running -- registered targets, connections on machines,
 * Kubernetes, metrics -- and never add a component or a connection of their own.
 * A documented connection a machine scan should have seen but did not shows as drift.
 * Everything here is read-only.
 */

export interface DiscoveryReport {
  at: number;
  sources: Record<'targets' | 'network' | 'kubernetes' | 'metrics', { checked: number; found: number; errors: string[] }>;
  archived: { items: number; links: number };
}

type Evidence = { source: CiSource; ref: string; detail?: string | null };

const SPLIT = '__SUPOPS_SPLIT__';
const KEEP_OBSERVED_MS = 15 * 86_400_000;
const DEP: CiLinkKind[] = ['depends_on', 'reads_from', 'writes_to', 'routes_to', 'replicates_to'];

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

/** What runs on a component (its `runs_on` children), optionally only what serves `port`. */
function servicesOn(projectId: string, hostId: string, port?: number): string[] {
  const links = projectLinks(projectId).filter((l) => l.kind === 'runs_on' && l.toId === hostId);
  if (!links.length) return [];
  const items = new Map(projectItems(projectId).map((i) => [i.id, i]));
  const all = links.map((l) => items.get(l.fromId)).filter((i): i is NonNullable<typeof i> => !!i);
  if (port === undefined) return all.map((i) => i.id);
  const wk = WELL_KNOWN[port]?.name;
  const exact = all.filter((i) => i.attrs.port === String(port) || (!!wk && normalizeName(i.name).includes(wk)));
  return exact.map((i) => i.id);
}

/**
 * Seen live: a goes to b. Confirms every documented connection that says so, at the
 * machine level or the service level ("web-1 depends on postgresql on db-1"). Adds
 * nothing when the map does not have it.
 */
function confirmBetween(projectId: string, aId: string, bId: string, e: Evidence, port?: number): number {
  if (aId === bId) return 0;
  const from = new Set([aId, ...servicesOn(projectId, aId)]);
  const to = new Set([bId, ...servicesOn(projectId, bId, port)]);
  let n = 0;
  for (const l of projectLinks(projectId)) {
    if (DEP.includes(l.kind) && from.has(l.fromId) && to.has(l.toId)) {
      addEvidence(projectId, { linkId: l.id }, e);
      n++;
    }
  }
  return n;
}

/** Seen live: this component exists. Only for one already on the map. */
function confirmItem(projectId: string, names: { key?: string; name: string; aliases?: string[] }, e: Evidence): string | null {
  const hit = findItem(projectId, names);
  if (!hit) return null;
  addEvidence(projectId, { itemId: hit.id }, e);
  return hit.id;
}

/** Registered machines, clusters and connections, matched to components on the map by name or address. */
export function fromTargets(projectId: string): { checked: number; found: number; errors: string[] } {
  const ts = loadTargets(db, projectId);
  let found = 0;
  for (const t of ts) {
    const cfg = t.config as { kind: string; host?: string; addresses?: string[]; via?: { alias?: string }; baseUrl?: string };
    const aliases = [
      ...(cfg.via?.alias ? [cfg.via.alias] : cfg.host ? [cfg.host] : []),
      ...(cfg.addresses ?? []),
      ...(cfg.baseUrl ? [(() => { try { return new URL(cfg.baseUrl!).hostname; } catch { return ''; } })()] : []),
    ].filter(Boolean);
    const hit = findItem(projectId, { targetId: t.id, key: t.slug, name: t.slug, aliases });
    if (!hit) continue;
    // Its health and incidents now show on the map.
    if (!hit.targetId) db.update(ciItems).set({ targetId: t.id, updatedAt: new Date() }).where(eq(ciItems.id, hit.id)).run();
    addEvidence(projectId, { itemId: hit.id }, { source: 'target', ref: t.id, detail: `registered ${t.kind} target ${t.slug}` });
    found++;
  }
  return { checked: ts.length, found, errors: [] };
}

/** On each registered machine that is on the map: what it listens on and talks to (`ss`, read-only). */
export async function fromNetwork(projectId: string): Promise<{ checked: number; found: number; errors: string[] }> {
  const hosts = loadTargets(db, projectId).filter((t) => t.kind === 'ssh');
  const errors: string[] = [];
  let found = 0;
  let checked = 0;
  for (const t of hosts) {
    const host = findItem(projectId, { targetId: t.id, name: t.slug });
    if (!host || host.targetId !== t.id) continue;
    checked++;
    const out = await sshExec(`ss -tlnpH 2>/dev/null || ss -tlnH; echo ${SPLIT}; ss -tnpH state established 2>/dev/null || ss -tnH state established`, ctxFor(t)).catch((e: Error) => ({ ok: false, text: e.message }));
    if (!out.ok || !out.text.includes(SPLIT)) {
      errors.push(`${t.slug}: ${out.text.split('\n')[0]?.slice(0, 160) ?? 'no answer'}`);
      continue;
    }
    const [listenText, connText] = out.text.split(SPLIT);
    // The scan itself: a documented connection from here that it does not see is drift.
    addEvidence(projectId, { itemId: host.id }, { source: 'network', ref: `scan:${t.id}`, detail: 'connections checked' });

    const listening = parseListening(listenText ?? '');
    const listenPorts = new Set(listening.map((l) => l.port));
    for (const l of listening) {
      if (IGNORED_PORTS.has(l.port)) continue;
      for (const svc of servicesOn(projectId, host.id, l.port)) {
        addEvidence(projectId, { itemId: svc }, { source: 'network', ref: `${t.id}:listen:${l.port}`, detail: `listening on ${l.port}${l.process ? ` (${l.process})` : ''}` });
        found++;
      }
    }
    for (const c of parseConnections(connText ?? '').slice(0, 300)) {
      const outbound = !listenPorts.has(c.localPort) && c.peerPort < 32_768 && !IGNORED_PORTS.has(c.peerPort);
      const peer = findItem(projectId, { name: c.peer });
      if (!peer || peer.id === host.id) continue;
      if (outbound) {
        found += confirmBetween(projectId, host.id, peer.id, { source: 'network', ref: `${t.id}:out:${c.peer}:${c.peerPort}`, detail: `${t.slug}${c.process ? ` (${c.process})` : ''} -> ${c.peer}:${c.peerPort}` }, c.peerPort);
      } else if (listenPorts.has(c.localPort) && !IGNORED_PORTS.has(c.localPort)) {
        found += confirmBetween(projectId, peer.id, host.id, { source: 'network', ref: `${t.id}:in:${c.peer}:${c.localPort}`, detail: `${c.peer} -> ${t.slug}:${c.localPort}` }, c.localPort);
      }
    }
  }
  return { checked, found, errors };
}

/** Workloads and the connections in their settings, from each cluster: confirming what the map has. */
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
    const parsed = parseKubernetes({ items: objects as never }, t.slug);
    const ids = new Map<string, string>();
    for (const it of parsed.items) {
      const id = confirmItem(projectId, it, { source: 'kubernetes', ref: `${t.id}:${it.key}`, detail: it.attrs.kubernetes ?? null });
      if (id) {
        ids.set(it.key, id);
        found++;
      }
    }
    for (const l of parsed.links) {
      const from = ids.get(l.from) ?? findItem(projectId, { key: l.from, name: l.from })?.id;
      const to = (l.toIsKey ? ids.get(l.to) : undefined) ?? findItem(projectId, { key: l.to, name: l.to })?.id;
      if (from && to) found += confirmBetween(projectId, from, to, { source: 'kubernetes', ref: `${t.id}:${l.from}:${l.to}:${l.kind}`, detail: l.detail });
    }
  }
  return { checked: clusters.length, found, errors };
}

const EXPORTERS: Array<{ metric: string; name: string }> = [
  { metric: 'pg_up', name: 'postgresql' },
  { metric: 'mysql_up', name: 'mysql' },
  { metric: 'mongodb_up', name: 'mongodb' },
  { metric: 'redis_up', name: 'redis' },
  { metric: 'memcached_up', name: 'memcached' },
  { metric: 'rabbitmq_identity_info', name: 'rabbitmq' },
  { metric: 'kafka_brokers', name: 'kafka' },
  { metric: 'elasticsearch_cluster_health_status', name: 'elasticsearch' },
  { metric: 'nginx_up', name: 'nginx' },
  { metric: 'haproxy_up', name: 'haproxy' },
];

/** What metrics show about components on the map: scraped machines, exporters on them, traced traffic. */
export async function fromMetrics(projectId: string): Promise<{ checked: number; found: number; errors: string[] }> {
  const conns = loadTargets(db, projectId).filter((t) => t.kind === 'prometheus' || t.kind === 'grafana').map(withSecret);
  const errors: string[] = [];
  let found = 0;
  for (const c of conns) {
    const up = await promInstant(c, 'count by (job, instance) (up)');
    if ('error' in up) {
      errors.push(`${c.slug}: ${up.error.slice(0, 160)}`);
      continue;
    }
    for (const s of up.samples.slice(0, 1000)) {
      const job = s.metric.job ?? '';
      const instance = s.metric.instance ?? '';
      if (!instance) continue;
      // A per-machine job ("billing-node-metrics") names the machine; otherwise the instance does.
      if (confirmItem(projectId, { name: instance, aliases: job ? [job] : [] }, { source: 'metrics', ref: `${c.id}:up:${job}:${instance}`, detail: `scraped by ${c.slug} as job ${job}` })) found++;
    }
    for (const ex of EXPORTERS) {
      const r = await promInstant(c, `count by (instance, job) (${ex.metric})`);
      if ('error' in r) continue;
      for (const s of r.samples.slice(0, 200)) {
        const host = findItem(projectId, { name: s.metric.instance ?? '', aliases: s.metric.job ? [s.metric.job] : [] });
        if (!host) continue;
        const items = new Map(projectItems(projectId).map((i) => [i.id, i]));
        for (const id of servicesOn(projectId, host.id)) {
          if (!normalizeName(items.get(id)?.name ?? '').includes(ex.name)) continue;
          addEvidence(projectId, { itemId: id }, { source: 'metrics', ref: `${c.id}:${ex.metric}:${s.metric.instance}`, detail: `${ex.metric} exported by ${s.metric.instance}` });
          found++;
        }
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
        const a = findItem(projectId, { name: g.from(s.metric) });
        const b = findItem(projectId, { name: g.to(s.metric) });
        if (a && b) found += confirmBetween(projectId, a.id, b.id, { source: 'metrics', ref: `${c.id}:${g.label}:${a.key}:${b.key}`, detail: `${g.label}: ${s.value.toFixed(2)}/s` });
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

/** Forget the last live check (when the map is deleted). */
export function clearDiscovery(projectId: string): void {
  db.delete(settings).where(eq(settings.key, key(projectId))).run();
}

export const projectHasMap = (projectId: string) => projectItems(projectId).length > 0;
