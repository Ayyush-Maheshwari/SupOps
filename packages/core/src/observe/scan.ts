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
}

export const MAX_SCAN_SERIES = 2000;

export async function scanSignal(
  target: ResolvedTarget,
  query: string,
  opts: { withTrend: boolean; signal?: AbortSignal; max?: number },
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
  const extra: Array<[keyof ScanSeries, string]> = [
    ['avg1d', `avg_over_time(${q}[1d:15m])`],
    ['sd1d', `stddev_over_time(${q}[1d:15m])`],
    ['yesterday', `${q} offset 1d`],
    ...(opts.withTrend ? ([['deriv6h', `deriv(${q}[6h:5m])`], ['deriv1d', `deriv(${q}[1d:15m])`]] as Array<[keyof ScanSeries, string]>) : []),
  ];
  // The extras only refine the picture: one that fails leaves its field empty.
  await Promise.all(
    extra.map(async ([field, expr]) => {
      const r = await promInstant(target, expr, opts.signal);
      if ('error' in r) return;
      for (const s of r.samples) {
        const labels = Object.fromEntries(Object.entries(s.metric).filter(([k]) => k !== '__name__'));
        const row = byKey.get(seriesKey(labels));
        if (row) (row as unknown as Record<string, number>)[field] = s.value;
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
