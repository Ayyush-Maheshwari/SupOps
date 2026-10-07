import { Activity, Box, Cloud, Container, Database, Globe, HardDrive, Layers, MessagesSquare, Network, Server, Zap } from 'lucide-react';

/** Service map types, words and layout for the web app. */

export type CiType = 'service' | 'host' | 'database' | 'cache' | 'queue' | 'load_balancer' | 'storage' | 'cluster' | 'gateway' | 'external' | 'monitoring' | 'other';
export type CiLinkKind = 'depends_on' | 'runs_on' | 'routes_to' | 'replicates_to' | 'reads_from' | 'writes_to' | 'backs_up_to' | 'monitors';
export type Certainty = 'confirmed' | 'manual' | 'documented' | 'observed' | 'stale';
export type CiSource = 'doc' | 'target' | 'network' | 'kubernetes' | 'metrics' | 'manual';

export interface MapEvidence {
  id: string;
  source: CiSource;
  ref: string;
  refName: string | null;
  docSlug: string | null;
  detail: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MapConfidence {
  score: number;
  certainty: Certainty;
  drift: 'not_seen' | 'not_documented' | null;
  sources: CiSource[];
}

export interface MapItem {
  id: string;
  key: string;
  name: string;
  type: CiType;
  env: string | null;
  description: string | null;
  aliases: string[];
  attrs: Record<string, string>;
  targetId: string | null;
  locked: boolean;
  confidence: MapConfidence;
  evidence: MapEvidence[];
  target: { id: string; slug: string; healthState: string } | null;
  incidents: Array<{ id: string; title: string; severity: string }>;
}

export interface MapLink {
  id: string;
  fromId: string;
  toId: string;
  kind: CiLinkKind;
  detail: string | null;
  locked: boolean;
  confidence: MapConfidence;
  evidence: MapEvidence[];
  /** Other sources that support the same connection told at the other level (host vs service). */
  alsoSupportedBy?: CiSource[];
  /** Drawn as the more exact service-level connection instead. */
  supersededBy?: string | null;
}

export interface DiscoveryReport {
  at: number;
  sources: Record<'targets' | 'network' | 'kubernetes' | 'metrics', { checked: number; found: number; errors: string[] }>;
}

export interface ServiceMapData {
  items: MapItem[];
  links: MapLink[];
  pending: number;
  discovery: DiscoveryReport | null;
}

export interface Proposal {
  id: string;
  origin: 'doc' | 'manual';
  sourceRef: string | null;
  sourceTitle: string | null;
  op: 'add_item' | 'update_item' | 'remove_item' | 'add_link' | 'update_link' | 'remove_link';
  payload: Record<string, unknown>;
  quote: string | null;
  createdAt: string;
}

export const TYPE_META: Record<CiType, { label: string; icon: typeof Box; tier: number; color: string }> = {
  external: { label: 'External', icon: Globe, tier: 0, color: 'rgb(var(--muted))' },
  gateway: { label: 'Gateway', icon: Network, tier: 0, color: 'rgb(var(--cyan))' },
  load_balancer: { label: 'Load balancer', icon: Network, tier: 1, color: 'rgb(var(--cyan))' },
  service: { label: 'Service', icon: Box, tier: 2, color: 'rgb(var(--blue))' },
  monitoring: { label: 'Monitoring', icon: Activity, tier: 2, color: 'rgb(var(--violet))' },
  other: { label: 'Other', icon: Layers, tier: 2, color: 'rgb(var(--muted))' },
  queue: { label: 'Queue', icon: MessagesSquare, tier: 3, color: 'rgb(var(--amber))' },
  cache: { label: 'Cache', icon: Zap, tier: 3, color: 'rgb(var(--amber))' },
  cluster: { label: 'Cluster', icon: Container, tier: 3, color: 'rgb(var(--cyan))' },
  database: { label: 'Database', icon: Database, tier: 4, color: 'rgb(var(--green))' },
  storage: { label: 'Storage', icon: HardDrive, tier: 4, color: 'rgb(var(--green))' },
  host: { label: 'Host', icon: Server, tier: 5, color: 'rgb(var(--muted))' },
};
export const CloudIcon = Cloud;

export const KIND_LABEL: Record<CiLinkKind, string> = {
  depends_on: 'depends on',
  runs_on: 'runs on',
  routes_to: 'routes to',
  replicates_to: 'replicates to',
  reads_from: 'reads from',
  writes_to: 'writes to',
  backs_up_to: 'backs up to',
  monitors: 'monitors',
};

export const CERTAINTY: Record<Certainty, { label: string; hint: string; chip: string; dash: string | undefined; opacity: number }> = {
  manual: { label: 'Set by a person', hint: 'Added or confirmed by someone on your team.', chip: 'border-blue/40 bg-blue/10 text-blue-text', dash: undefined, opacity: 1 },
  confirmed: { label: 'Confirmed', hint: 'Your documents say so and it was seen live.', chip: 'border-green/40 bg-green/10 text-green', dash: undefined, opacity: 1 },
  documented: { label: 'Documented', hint: 'Only your documents say so; not (yet) seen live.', chip: 'border-edge bg-tile-2 text-ink/80', dash: '6 4', opacity: 0.95 },
  observed: { label: 'Seen live', hint: 'Seen on your systems; no document mentions it.', chip: 'border-cyan/40 bg-cyan/10 text-cyan', dash: '2 4', opacity: 0.95 },
  stale: { label: 'Not seen lately', hint: 'Was seen before, not in the last few days.', chip: 'border-edge bg-tile-2 text-muted', dash: '2 6', opacity: 0.45 },
};

export const DRIFT: Record<'not_seen' | 'not_documented', { label: string; hint: string }> = {
  not_seen: { label: 'Documented, not seen', hint: 'A document says this connection exists, but the machine was checked and it is not there. The document may be out of date.' },
  not_documented: { label: 'Not documented', hint: 'Seen on your systems, but no document mentions it.' },
};

export const SOURCE_LABEL: Record<CiSource, string> = {
  doc: 'Document',
  target: 'Registered target',
  network: 'Live connections',
  kubernetes: 'Kubernetes',
  metrics: 'Metrics',
  manual: 'Set by a person',
};

/** Health in one word: from the matched target and open incidents. */
export function healthOf(i: MapItem): 'down' | 'degraded' | 'ok' | 'unknown' {
  if (i.incidents.some((x) => x.severity === 'critical') || i.target?.healthState === 'unreachable') return 'down';
  if (i.incidents.length || i.target?.healthState === 'degraded') return 'degraded';
  if (i.target?.healthState === 'ok') return 'ok';
  return 'unknown';
}

// ---- layout ---------------------------------------------------------------------------

export const NODE_W = 176;
export const NODE_H = 46;
const COL_W = 250;
const ROW_H = 74;
const DOWN_COL = 196;
const DOWN_ROW = 92;

/** Kinds that put `to` to the right of `from`. */
const RIGHTWARD: CiLinkKind[] = ['depends_on', 'routes_to', 'reads_from', 'writes_to', 'runs_on', 'replicates_to', 'backs_up_to'];

export interface Placed {
  x: number;
  y: number;
}

/**
 * A left-to-right, tiered layout: entry points on the left, services, then data
 * stores, then the machines things run on. Layers start from each type's tier and are
 * pushed right so dependencies point rightward; order within a layer follows the
 * neighbours (barycentre sweeps) to keep crossings down.
 */
export type MapDirection = 'right' | 'down';

export function layoutMap(items: MapItem[], links: MapLink[], direction: MapDirection = 'right'): { pos: Map<string, Placed>; width: number; height: number } {
  const ids = new Set(items.map((i) => i.id));
  const edges = links.filter((l) => ids.has(l.fromId) && ids.has(l.toId) && l.kind !== 'monitors');
  const layer = new Map(items.map((i) => [i.id, TYPE_META[i.type].tier * 2]));
  for (let pass = 0; pass < items.length + 2; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!RIGHTWARD.includes(e.kind)) continue;
      const need = layer.get(e.fromId)! + 1;
      if (layer.get(e.toId)! < need && need < 60) {
        layer.set(e.toId, need);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Compress: only layers that hold something.
  const used = [...new Set(layer.values())].sort((a, b) => a - b);
  const col = new Map(used.map((l, i) => [l, i]));
  const columns: string[][] = used.map(() => []);
  for (const i of [...items].sort((a, b) => a.name.localeCompare(b.name))) columns[col.get(layer.get(i.id)!)!]!.push(i.id);

  const nbrs = new Map<string, string[]>();
  for (const e of edges) {
    nbrs.set(e.fromId, [...(nbrs.get(e.fromId) ?? []), e.toId]);
    nbrs.set(e.toId, [...(nbrs.get(e.toId) ?? []), e.fromId]);
  }
  const index = new Map<string, number>();
  const reindex = () => columns.forEach((c) => c.forEach((id, i) => index.set(id, i)));
  reindex();
  for (let sweep = 0; sweep < 6; sweep++) {
    for (const c of columns) {
      const bary = new Map(c.map((id) => {
        const ns = (nbrs.get(id) ?? []).map((n) => index.get(n)).filter((v): v is number => v !== undefined);
        return [id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : index.get(id)!];
      }));
      c.sort((a, b) => bary.get(a)! - bary.get(b)!);
    }
    reindex();
  }

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const pos = new Map<string, Placed>();
  if (direction === 'down') {
    // The same layers as rows: for narrow screens, where a long chain reads better downward.
    columns.forEach((c, ci) => {
      const offset = ((tallest - c.length) * DOWN_COL) / 2;
      c.forEach((id, ri) => pos.set(id, { x: offset + ri * DOWN_COL, y: ci * DOWN_ROW }));
    });
    return { pos, width: tallest * DOWN_COL - (DOWN_COL - NODE_W), height: Math.max(1, columns.length) * DOWN_ROW - (DOWN_ROW - NODE_H) };
  }
  columns.forEach((c, ci) => {
    const offset = ((tallest - c.length) * ROW_H) / 2;
    c.forEach((id, ri) => pos.set(id, { x: ci * COL_W, y: offset + ri * ROW_H }));
  });
  return { pos, width: Math.max(1, columns.length) * COL_W - (COL_W - NODE_W), height: tallest * ROW_H - (ROW_H - NODE_H) };
}
