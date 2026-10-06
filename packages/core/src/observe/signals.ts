import type { WatchLimit } from '@supops/db';
import type { ResolvedTarget } from '../tools/types.ts';
import { obsRequest } from '../tools/observability.ts';
import { promInstant } from './checks.ts';
import type { Point } from './anomaly.ts';

/**
 * The signals SupOps watches on its own, discovered from the metrics a backend
 * actually has: host resources (node_exporter), Kubernetes (kube-state-metrics,
 * cAdvisor, kubelet), traffic, certificates (blackbox), and the monitoring stack
 * itself. Each is one PromQL query with at most a few dozen series, sampled every
 * few minutes; those with a `limit` are forecast ("disk full in 6h").
 */
export interface SignalDef {
  key: string;
  title: string;
  group: 'resources' | 'traffic' | 'kubernetes' | 'stack';
  /** Discovered when this metric exists. */
  requires: string;
  query: string;
  unit: 'percent' | 'bytes' | 'seconds' | 'ratio' | 'count' | 'days' | 'per_second';
  badDirection: 'up' | 'down' | 'both';
  limit: WatchLimit | null;
  /** Smallest change that counts as an anomaly, in the unit. */
  minDelta?: number;
}

const FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|devtmpfs|nsfs",mountpoint!~"/boot.*|/run.*|/snap.*"';

export const SIGNALS: SignalDef[] = [
  { key: 'cpu', title: 'CPU used', group: 'resources', requires: 'node_cpu_seconds_total', unit: 'percent', badDirection: 'up', limit: null, minDelta: 10,
    query: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))' },
  { key: 'memory', title: 'Memory used', group: 'resources', requires: 'node_memory_MemAvailable_bytes', unit: 'percent', badDirection: 'up', limit: { value: 100, when: 'above' }, minDelta: 5,
    query: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)' },
  { key: 'disk_free', title: 'Disk free', group: 'resources', requires: 'node_filesystem_avail_bytes', unit: 'bytes', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: `min by (instance, mountpoint) (node_filesystem_avail_bytes{${FS}})` },
  { key: 'inodes_free', title: 'Inodes free', group: 'resources', requires: 'node_filesystem_files_free', unit: 'count', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: `min by (instance, mountpoint) (node_filesystem_files_free{${FS}})` },
  { key: 'load', title: 'Load per core', group: 'resources', requires: 'node_load5', unit: 'ratio', badDirection: 'up', limit: null, minDelta: 0.3,
    query: 'node_load5 / on (instance) count by (instance) (node_cpu_seconds_total{mode="idle"})' },
  { key: 'net_errors', title: 'Network errors', group: 'resources', requires: 'node_network_receive_errs_total', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.1,
    query: 'sum by (instance) (rate(node_network_receive_errs_total[5m]) + rate(node_network_transmit_errs_total[5m]))' },
  { key: 'pod_restarts', title: 'Pod restarts (15m)', group: 'kubernetes', requires: 'kube_pod_container_status_restarts_total', unit: 'count', badDirection: 'up', limit: null, minDelta: 2,
    query: 'sum by (namespace) (increase(kube_pod_container_status_restarts_total[15m]))' },
  { key: 'pvc_free', title: 'Volume free', group: 'kubernetes', requires: 'kubelet_volume_stats_available_bytes', unit: 'bytes', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: 'min by (namespace, persistentvolumeclaim) (kubelet_volume_stats_available_bytes)' },
  { key: 'http_5xx', title: 'HTTP 5xx rate', group: 'traffic', requires: 'http_requests_total', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.05,
    query: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m]))' },
  { key: 'http_p99', title: 'Latency p99', group: 'traffic', requires: 'http_request_duration_seconds_bucket', unit: 'seconds', badDirection: 'up', limit: null, minDelta: 0.05,
    query: 'histogram_quantile(0.99, sum by (job, le) (rate(http_request_duration_seconds_bucket[5m])))' },
  { key: 'ingress_5xx', title: 'Ingress 5xx rate', group: 'traffic', requires: 'nginx_ingress_controller_requests', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.05,
    query: 'sum by (ingress) (rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))' },
  { key: 'cert_days', title: 'Certificate days left', group: 'traffic', requires: 'probe_ssl_earliest_cert_expiry', unit: 'days', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: 'min by (instance) ((probe_ssl_earliest_cert_expiry - time()) / 86400)' },
  { key: 'targets_down', title: 'Scrape targets down', group: 'stack', requires: 'up', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum by (job) (1 - up)' },
  { key: 'rule_failures', title: 'Rule evaluation failures', group: 'stack', requires: 'prometheus_rule_evaluation_failures_total', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum(increase(prometheus_rule_evaluation_failures_total[15m]))' },
  { key: 'notifications_dropped', title: 'Notifications dropped', group: 'stack', requires: 'prometheus_notifications_dropped_total', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum(increase(prometheus_notifications_dropped_total[15m]))' },
  { key: 'head_series', title: 'Active series', group: 'stack', requires: 'prometheus_tsdb_head_series', unit: 'count', badDirection: 'up', limit: null,
    query: 'sum(prometheus_tsdb_head_series)' },
  { key: 'scrape_duration', title: 'Slowest scrape', group: 'stack', requires: 'scrape_duration_seconds', unit: 'seconds', badDirection: 'up', limit: null, minDelta: 1,
    query: 'max by (job) (scrape_duration_seconds)' },
];

/** Which signals this backend can serve, one cheap probe each. */
export async function discoverSignals(target: ResolvedTarget, signal?: AbortSignal): Promise<SignalDef[]> {
  const out: SignalDef[] = [];
  for (const s of SIGNALS) {
    const r = await promInstant(target, `count(${s.requires})`, signal);
    if (!('error' in r) && r.samples.length && r.samples[0]!.value > 0) out.push(s);
  }
  return out;
}

/** Canonical series key: `{a="1",b="2"}`, sorted, without __name__. */
export function seriesKey(metric: Record<string, string>): string {
  const keys = Object.keys(metric).filter((k) => k !== '__name__').sort();
  return `{${keys.map((k) => `${k}="${metric[k]}"`).join(',')}}`;
}

export function parseSeriesKey(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of key.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** A range query, as points per series. At most `maxSeries` series are kept. */
export async function promRange(
  target: ResolvedTarget,
  query: string,
  start: number,
  end: number,
  stepSec: number,
  opts: { signal?: AbortSignal; maxSeries?: number } = {},
): Promise<{ error: string } | { series: Array<{ key: string; labels: Record<string, string>; points: Point[] }>; dropped: number }> {
  const r = await obsRequest(target, '/api/v1/query_range', {
    query: { query, start: Math.floor(start / 1000), end: Math.floor(end / 1000), step: `${stepSec}s` },
    signal: opts.signal,
    timeoutMs: 30_000,
    maxBytes: 16 * 1024 * 1024,
  });
  if ('error' in r) return r;
  const rows = ((r.json as { data?: { result?: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> } }).data?.result ?? []);
  const max = opts.maxSeries ?? 50;
  return {
    series: rows.slice(0, max).map((x) => ({
      key: seriesKey(x.metric),
      labels: Object.fromEntries(Object.entries(x.metric).filter(([k]) => k !== '__name__')),
      points: x.values.map(([t, v]) => ({ at: Math.round(t * 1000), value: Number(v) })).filter((p) => Number.isFinite(p.value)),
    })),
    dropped: Math.max(0, rows.length - max),
  };
}

/** A short, human name for a series: its most telling labels. */
export function seriesName(labels: Record<string, string>): string {
  const keys = ['instance', 'mountpoint', 'namespace', 'persistentvolumeclaim', 'ingress', 'pod'];
  const parts = keys.map((k) => labels[k]).filter(Boolean);
  if (labels.job && !labels.instance) parts.unshift(`job ${labels.job}`);
  return parts.length ? parts.join(' ') : Object.values(labels).join(' ') || 'total';
}

export { formatValue } from '@supops/shared';
