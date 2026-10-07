import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { formatValue } from '@supops/shared';

/**
 * A time-series chart for a watched signal: one line per series, an optional
 * "usual range" band, and a dashed forecast continuing the line to where it is
 * heading. Hand-rolled SVG like the rest of the charts here, so it takes the theme
 * tokens directly; labels are HTML so they never stretch with the plot.
 */

export interface ChartSeries {
  key: string;
  name: string;
  points: Array<[number, number]>;
  band?: { low: number; high: number } | null;
  /** Continue the line at `slopePerHour` until `untilMs` (or 24h). */
  forecast?: { slopePerHour: number; etaMs: number | null } | null;
  flagged?: boolean;
  /** Its own colour, e.g. the one it has in a combined graph; else by position. */
  color?: string;
}

const PALETTE = ['rgb(var(--blue))', 'rgb(var(--violet))', 'rgb(var(--cyan))', 'rgb(var(--green))', 'rgb(var(--amber))', 'rgb(var(--red))'];
/** The theme's colours first; past them, hues spread by the golden angle so neighbours differ. */
export const seriesColor = (i: number) => (i < PALETTE.length ? PALETTE[i]! : `hsl(${Math.round((i * 137.508) % 360)} 70% 62%)`);

const W = 600;

export function LineChart({
  series,
  unit,
  height = 160,
  compact = false,
  limit,
  className,
  empty = 'No samples yet',
  highlight,
}: {
  series: ChartSeries[];
  unit: string;
  height?: number;
  /** No axes or hover readout: for small multiples. */
  compact?: boolean;
  /** Draw the limit (e.g. 0 bytes free) as a line when it is in view. */
  limit?: number | null;
  className?: string;
  /** What to say when there is nothing to draw. */
  empty?: string;
  /** Pick out one series: the others fade. */
  highlight?: string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const pad = compact ? 2 : 6;

  const geo = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    if (!all.length) return null;
    let t0 = Math.min(...all.map((p) => p[0]));
    let t1 = Math.max(...all.map((p) => p[0]));
    const ext: number[] = all.map((p) => p[1]);
    // Room for the forecast: up to a quarter more of the window, ending at the ETA.
    const fc = series.find((s) => s.forecast && s.points.length);
    let fcEnd = t1;
    if (fc?.forecast) {
      const span = Math.max(t1 - t0, 3_600_000);
      fcEnd = t1 + Math.min(span * 0.35, fc.forecast.etaMs ?? span * 0.35);
      const last = fc.points[fc.points.length - 1]!;
      ext.push(last[1] + (fc.forecast.slopePerHour * (fcEnd - last[0])) / 3_600_000);
      t1 = fcEnd;
    }
    for (const s of series) if (s.band) ext.push(s.band.low, s.band.high);
    if (limit !== undefined && limit !== null) {
      const lo = Math.min(...ext), hi = Math.max(...ext);
      // Only pull the limit into view when it is reasonably close.
      if (limit >= lo - (hi - lo) * 0.5 && limit <= hi + (hi - lo) * 0.5) ext.push(limit);
    }
    let lo = Math.min(...ext);
    let hi = Math.max(...ext);
    // Quantities near zero read better against zero.
    if (['percent', 'bytes', 'count', 'per_second'].includes(unit) && lo > 0 && lo < hi - lo) lo = 0;
    if (hi === lo) {
      hi += Math.abs(hi) * 0.1 || 1;
      lo -= Math.abs(lo) * 0.1 || 0;
    }
    const m = (hi - lo) * 0.08;
    hi += m;
    lo = lo === 0 ? 0 : lo - m;
    if (t1 === t0) t0 -= 60_000;
    const x = (t: number) => pad + ((t - t0) / (t1 - t0)) * (W - pad * 2);
    const y = (v: number) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
    return { t0, t1, lo, hi, x, y, fcEnd };
  }, [series, H, pad, unit, limit]);

  if (!geo) {
    return <div className={clsx('grid place-items-center text-[11px] text-muted', className)} style={{ height }}>{empty}</div>;
  }
  const { x, y, t0, t1, lo, hi } = geo;
  const longest = series.reduce((a, s) => (s.points.length > a.points.length ? s : a), series[0]!);
  const hoverAt = hover !== null ? longest.points[hover]?.[0] : undefined;
  const nearest = (s: ChartSeries, t: number) => s.points.reduce((b, p) => (Math.abs(p[0] - t) < Math.abs(b[0] - t) ? p : b), s.points[0]!);
  const fmtTime = (t: number) => {
    const d = new Date(t);
    return t1 - t0 > 36 * 3_600_000 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className={clsx('relative', className)}>
      <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: H }}
        role="img"
        aria-label={`${series.length} series, ${formatValue(lo, unit)} to ${formatValue(hi, unit)}`}
        onMouseMove={(e) => {
          if (compact || !longest.points.length) return;
          const r = (e.currentTarget as SVGElement).getBoundingClientRect();
          const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
          let best = 0;
          longest.points.forEach((p, i) => { if (Math.abs(p[0] - t) < Math.abs(longest.points[best]![0] - t)) best = i; });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {!compact && [0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="rgb(var(--hairline))" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s, i) => s.band && (
          <rect key={`b-${s.key}`} x={x(s.points[0]?.[0] ?? t0)} width={Math.max(0, x(s.points[s.points.length - 1]?.[0] ?? t1) - x(s.points[0]?.[0] ?? t0))}
            y={y(s.band.high)} height={Math.max(1, y(s.band.low) - y(s.band.high))} fill={s.color ?? seriesColor(i)} opacity={0.07} />
        ))}
        {limit !== undefined && limit !== null && limit >= lo && limit <= hi && (
          <line x1={0} x2={W} y1={y(limit)} y2={y(limit)} stroke="rgb(var(--red))" strokeOpacity={0.6} strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
        {/* The picked-out line is drawn last, on top of the rest. */}
        {series.map((s, i) => [s, i] as const).sort((a, b) => Number(a[0].key === highlight) - Number(b[0].key === highlight)).map(([s, i]) => (
          <polyline
            key={s.key}
            points={s.points.map((p) => `${x(p[0])},${y(p[1])}`).join(' ')}
            fill="none"
            stroke={s.color ?? seriesColor(i)}
            strokeWidth={highlight === s.key ? 2.6 : s.flagged ? 2.2 : series.length > 12 ? 1.2 : 1.5}
            strokeOpacity={highlight ? (highlight === s.key ? 1 : 0.12) : series.length > 4 && !s.flagged ? 0.75 : 1}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {series.map((s, i) => {
          if (!s.forecast || !s.points.length) return null;
          const last = s.points[s.points.length - 1]!;
          const end = geo.fcEnd;
          const v = last[1] + (s.forecast.slopePerHour * (end - last[0])) / 3_600_000;
          return (
            <line key={`f-${s.key}`} x1={x(last[0])} y1={y(last[1])} x2={x(end)} y2={y(v)} stroke={s.color ?? seriesColor(i)} strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
          );
        })}
        {hoverAt !== undefined && (
          <line x1={x(hoverAt)} x2={x(hoverAt)} y1={0} y2={H} stroke="rgb(var(--muted))" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {!compact && (
        <>
          <span className="pointer-events-none absolute left-1 top-0.5 font-mono text-[10px] text-muted">{formatValue(hi, unit)}</span>
          <span className="pointer-events-none absolute bottom-0.5 left-1 font-mono text-[10px] text-muted">{formatValue(lo, unit)}</span>
        </>
      )}
      </div>

      {!compact && (
        <>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-dim">
            <span>{fmtTime(t0)}</span>
            {geo.fcEnd > (longest.points[longest.points.length - 1]?.[0] ?? t1) && <span className="text-muted">forecast →</span>}
            <span>{fmtTime(t1)}</span>
          </div>
        </>
      )}

      {hoverAt !== undefined && (
        <div className="pointer-events-none absolute right-2 top-2 max-w-[70%] rounded-inner border border-edge bg-tile/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur">
          <div className="mb-0.5 font-mono text-[10px] text-muted">{new Date(hoverAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          {(() => {
            // With many lines, the readout lists the picked-out one, then the highest values.
            const rows = series.map((s, i) => ({ s, i, v: s.points.length ? nearest(s, hoverAt)[1] : NaN })).filter((r) => Number.isFinite(r.v));
            rows.sort((a, b) => Number(b.s.key === highlight) - Number(a.s.key === highlight) || b.v - a.v);
            const shown = rows.slice(0, 6);
            return (
              <>
                {shown.map(({ s, i, v }) => (
                  <div key={s.key} className={clsx('flex items-center gap-1.5', highlight && s.key !== highlight && 'opacity-60')}>
                    <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color ?? seriesColor(i) }} />
                    <span className="truncate text-muted">{s.name}</span>
                    <span className="ml-auto pl-2 font-mono text-ink">{formatValue(v, unit)}</span>
                  </div>
                ))}
                {rows.length > shown.length && <div className="mt-0.5 text-[10px] text-dim">+{rows.length - shown.length} more</div>}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
