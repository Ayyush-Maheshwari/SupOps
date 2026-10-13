import type { ResolvedTarget } from '../tools/types.ts';
import { promInstant, promString } from './checks.ts';
import { seriesKey } from './signals.ts';

/**
 * One look at every series of a signal, computed by the metrics backend rather than
 * from samples kept here: the value now, its average and spread over the last day,
 * the value at this time yesterday and -- for signals with a limit -- its trend over
 * 6 and 24 hours. A handful of instant queries covers thousands of series, so
 * nothing is left out for want of local storage.
 */
export interface ScanSeries {
  key: string;
  labels: Record<string, string>;
  value: number;
  avg1d?: number;
  sd1d?: number;
  yesterday?: number;
  /** Change per second, from the last 6 hours and the last day. */
  deriv6h?: number;
  deriv1d?: number;
  /**
   * Signals that rise and fall: the level held throughout the last 15 minutes (the
   * lowest of them when high is bad, the highest when low is bad) and the 15-minute
   * mean. One sample is never the level.
   */
  sustained?: number;
  avg15m?: number;
}

export const MAX_SCAN_SERIES = 2000;

export async function scanSignal(
  target: ResolvedTarget,
  query: string,
  opts: {
    withTrend: boolean;
    /** A signal that rises and falls, bad in this direction: also read its 15-minute levels. */
    sustain?: 'up' | 'down';
    signal?: AbortSignal;
    max?: number;
  },
): Promise<{ error: string } | { series: ScanSeries[]; truncated: number }> {
  const q = `(${query})`;
  const now = await promInstant(target, query, opts.signal);
  if ('error' in now) return now;
  const max = opts.max ?? MAX_SCAN_SERIES;
  const byKey = new Map<string, ScanSeries>();
  for (const s of now.samples.slice(0, max)) {
    const labels = Object.fromEntries(Object.entries(s.metric).filter(([k]) => k !== '__name__'));
    byKey.set(seriesKey(labels), { key: seriesKey(labels), labels, value: s.value });
  }
  type Set = (row: ScanSeries, v: number) => void;
  const field = (f: 'avg1d' | 'sd1d' | 'yesterday' | 'deriv6h' | 'deriv1d' | 'sustained' | 'avg15m'): Set => (row, v) => { row[f] = v; };
  const extra: Array<[Set, string]> = [
    [field('avg1d'), `avg_over_time(${q}[1d:15m])`],
    [field('sd1d'), `stddev_over_time(${q}[1d:15m])`],
    [field('yesterday'), `${q} offset 1d`],
  ];
  if (opts.withTrend) extra.push([field('deriv6h'), `deriv(${q}[6h:5m])`], [field('deriv1d'), `deriv(${q}[1d:15m])`]);
  if (opts.sustain) {
    // What held for the whole of the last 15 minutes, as an alert's `for: 15m` sees it.
    extra.push([field('sustained'), `${opts.sustain === 'up' ? 'min' : 'max'}_over_time(${q}[15m:1m])`]);
    extra.push([field('avg15m'), `avg_over_time(${q}[15m:1m])`]);
  }
  // The extras only refine the picture: one that fails leaves its field empty.
  await Promise.all(
    extra.map(async ([set, expr]) => {
      const r = await promInstant(target, expr, opts.signal);
      if ('error' in r) return;
      for (const s of r.samples) {
        const labels = Object.fromEntries(Object.entries(s.metric).filter(([k]) => k !== '__name__'));
        const row = byKey.get(seriesKey(labels));
        if (row && Number.isFinite(s.value)) set(row, s.value);
      }
    }),
  );
  return { series: [...byKey.values()], truncated: Math.max(0, now.samples.length - max) };
}

/**
 * The query narrowed to one of its series, by that series' labels:
 * `(q) and on(a, b) label_replace(label_replace(vector(1), "a", "1", "", ""), "b", "2", "", "")`.
 * Works on any expression, in Prometheus and VictoriaMetrics alike.
 */
export function seriesFilterQuery(query: string, labels: Record<string, string>): string {
  const keys = Object.keys(labels).filter((k) => k !== '__name__' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).sort();
  if (!keys.length) return query;
  let v = 'vector(1)';
  // In a label_replace replacement, $ starts a group reference: double it.
  for (const k of keys) v = `label_replace(${v}, "${k}", "${promString(labels[k]!).replace(/\$/g, '$$$$')}", "", "")`;
  return `(${query}) and on(${keys.join(', ')}) ${v}`;
}

/**
 * The query narrowed to several of its series at once (for a combined graph): the
 * same `and on(...)` as seriesFilterQuery, against the union of their label sets.
 */
export function seriesFilterQueryMany(query: string, labelSets: Array<Record<string, string>>): string {
  if (!labelSets.length) return query;
  if (labelSets.length === 1) return seriesFilterQuery(query, labelSets[0]!);
  const keys = [...new Set(labelSets.flatMap((l) => Object.keys(l)))].filter((k) => k !== '__name__' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).sort();
  if (!keys.length) return query;
  const one = (labels: Record<string, string>) => {
    let v = 'vector(1)';
    for (const k of keys) v = `label_replace(${v}, "${k}", "${promString(labels[k] ?? '').replace(/\$/g, '$$$$')}", "", "")`;
    return v;
  };
  return `(${query}) and on(${keys.join(', ')}) (${labelSets.map(one).join(' or ')})`;
}
