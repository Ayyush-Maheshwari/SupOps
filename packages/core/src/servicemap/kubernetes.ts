import type { CiLinkKind, CiType } from '@supops/db';

/**
 * A cluster's own description of itself, read into the map: each workload
 * (Deployment, StatefulSet, DaemonSet) is a component known also by the Services that
 * select it; Ingresses route to them; and connection settings in a workload's
 * environment (DB_HOST, REDIS_URL...) say what it depends on. Read-only `kubectl get`
 * output; values from Secrets are never visible and never needed.
 */

export interface K8sItem {
  key: string;
  name: string;
  type: CiType;
  env: string;
  aliases: string[];
  attrs: Record<string, string>;
}

export interface K8sLink {
  from: string;
  /** A component key from this cluster, or a host name to resolve against the map. */
  to: string;
  toIsKey: boolean;
  kind: CiLinkKind;
  detail: string;
}

interface Obj {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
}

const IMAGE_TYPES: Array<[RegExp, CiType]> = [
  [/postgres|mysql|mariadb|mongo|cockroach|clickhouse|cassandra|elasticsearch|opensearch|influx/i, 'database'],
  [/redis|memcached|valkey|keydb/i, 'cache'],
  [/rabbitmq|kafka|nats|pulsar|activemq|emqx/i, 'queue'],
  [/minio|ceph/i, 'storage'],
  [/prometheus|grafana|loki|alertmanager|victoria|tempo|jaeger|otel/i, 'monitoring'],
  [/haproxy|envoy|traefik|ingress-nginx|kong/i, 'gateway'],
];

const ENV_HINT = /(HOST|URL|URI|ADDR|ADDRESS|DSN|ENDPOINT|SERVER|BROKERS?)$/i;

/** Host names in a connection setting: URLs, host:port lists, plain hosts. */
export function hostsInValue(value: string): string[] {
  const out = new Set<string>();
  for (const part of value.split(/[,\s;]+/)) {
    if (!part) continue;
    let h = part;
    const url = part.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i);
    // In a URL or as host:port, even a one-word name is a host.
    const clearlyHost = !!url || /^[^@/]*@?[a-z0-9.-]+:\d+(\/|$)/i.test(part);
    if (url) h = url[1]!;
    else h = part.replace(/^[^@]*@/, '').split('/')[0]!.replace(/:\d+$/, '');
    if (/^(localhost|127\.|0\.0\.0\.0)/.test(h)) continue;
    // A host name or an IP, not a word, a path or a number.
    if (
      /^(\d{1,3}\.){3}\d{1,3}$/.test(h) ||
      /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i.test(h) ||
      /^[a-z0-9]+(-[a-z0-9]+)+$/i.test(h) ||
      (clearlyHost && /^[a-z][a-z0-9-]*$/i.test(h))
    ) out.add(h.toLowerCase());
  }
  return [...out];
}

export function parseKubernetes(list: { items?: Obj[] }, cluster: string): { items: K8sItem[]; links: K8sLink[] } {
  const objs = list.items ?? [];
  const items: K8sItem[] = [];
  const links: K8sLink[] = [];
  const keyOf = (ns: string, name: string) => `${cluster}/${ns}/${name}`;

  const workloads = objs.filter((o) => ['Deployment', 'StatefulSet', 'DaemonSet'].includes(o.kind));
  const tplLabels = (o: Obj) => (((o.spec?.template as { metadata?: { labels?: Record<string, string> } })?.metadata?.labels) ?? {});
  const containers = (o: Obj) => (((o.spec?.template as { spec?: { containers?: Array<{ image?: string; env?: Array<{ name: string; value?: string }> }> } })?.spec?.containers) ?? []);

  for (const w of workloads) {
    const ns = w.metadata.namespace ?? 'default';
    const image = containers(w).map((c) => c.image ?? '').join(' ');
    const type = IMAGE_TYPES.find(([re]) => re.test(image))?.[1] ?? 'service';
    items.push({
      key: keyOf(ns, w.metadata.name),
      name: w.metadata.name,
      type,
      env: ns,
      aliases: [`${w.metadata.name}.${ns}`],
      attrs: { kubernetes: `${w.kind} ${ns}/${w.metadata.name}`, ...(image ? { image: image.split(' ')[0]!.slice(0, 120) } : {}) },
    });
  }

  // A Service is another name for the workload(s) it selects.
  const serviceTo = new Map<string, string[]>();
  for (const s of objs.filter((o) => o.kind === 'Service')) {
    const ns = s.metadata.namespace ?? 'default';
    const sel = (s.spec?.selector as Record<string, string> | undefined) ?? {};
    const matched = Object.keys(sel).length
      ? workloads.filter((w) => (w.metadata.namespace ?? 'default') === ns && Object.entries(sel).every(([k, v]) => tplLabels(w)[k] === v))
      : [];
    const names = [s.metadata.name, `${s.metadata.name}.${ns}`, `${s.metadata.name}.${ns}.svc`, `${s.metadata.name}.${ns}.svc.cluster.local`];
    if (matched.length) {
      serviceTo.set(`${ns}/${s.metadata.name}`, matched.map((w) => keyOf(ns, w.metadata.name)));
      for (const w of matched) {
        const it = items.find((i) => i.key === keyOf(ns, w.metadata.name))!;
        for (const n of names) if (!it.aliases.includes(n) && n !== it.name) it.aliases.push(n);
      }
    } else if (s.spec?.type === 'ExternalName' && typeof s.spec.externalName === 'string') {
      items.push({ key: keyOf(ns, s.metadata.name), name: s.metadata.name, type: 'external', env: ns, aliases: [...names.slice(1), s.spec.externalName], attrs: { kubernetes: `Service ${ns}/${s.metadata.name} -> ${s.spec.externalName}` } });
      serviceTo.set(`${ns}/${s.metadata.name}`, [keyOf(ns, s.metadata.name)]);
    }
  }

  for (const ing of objs.filter((o) => o.kind === 'Ingress')) {
    const ns = ing.metadata.namespace ?? 'default';
    const rules = (ing.spec?.rules as Array<{ host?: string; http?: { paths?: Array<{ path?: string; backend?: { service?: { name?: string } } }> } }> | undefined) ?? [];
    const hosts = rules.map((r) => r.host).filter((h): h is string => !!h);
    items.push({ key: keyOf(ns, `ingress-${ing.metadata.name}`), name: hosts[0] ?? ing.metadata.name, type: 'gateway', env: ns, aliases: [ing.metadata.name, ...hosts.slice(1)], attrs: { kubernetes: `Ingress ${ns}/${ing.metadata.name}` } });
    for (const r of rules) {
      for (const p of r.http?.paths ?? []) {
        const svc = p.backend?.service?.name;
        for (const to of (svc && serviceTo.get(`${ns}/${svc}`)) || []) {
          links.push({ from: keyOf(ns, `ingress-${ing.metadata.name}`), to, toIsKey: true, kind: 'routes_to', detail: `${r.host ?? '*'}${p.path ?? '/'} -> ${svc}` });
        }
      }
    }
  }

  // What each workload is configured to connect to.
  for (const w of workloads) {
    const ns = w.metadata.namespace ?? 'default';
    const from = keyOf(ns, w.metadata.name);
    const seen = new Set<string>();
    for (const c of containers(w)) {
      for (const e of c.env ?? []) {
        if (!e.value || !ENV_HINT.test(e.name)) continue;
        for (const h of hostsInValue(e.value)) {
          // A service in this cluster, by its DNS name, maps to its workload.
          const short = h.split('.')[0]!;
          const svcNs = h.split('.')[1] && !h.includes('.svc') ? h.split('.')[1]! : ns;
          const inCluster = serviceTo.get(`${h.includes('.svc') ? h.split('.')[1] : svcNs}/${short}`) ?? serviceTo.get(`${ns}/${short}`);
          const targets = inCluster ?? [h];
          for (const t of targets) {
            if (t === from || seen.has(t)) continue;
            seen.add(t);
            links.push({ from, to: t, toIsKey: !!inCluster, kind: 'depends_on', detail: `env ${e.name}` });
          }
        }
      }
    }
  }
  return { items, links };
}
