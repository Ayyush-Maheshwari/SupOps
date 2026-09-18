import { useState } from 'react';
import { clsx } from 'clsx';

/**
 * A small trend line with an area fill.
 *
 * Deliberately not a charting library: at this size axes and tooltips would be
 * noise, and hand-rolled SVG inherits the theme tokens exactly. The current value
 * is always rendered as text beside it, so the shape is supporting evidence rather
 * than the only way to read the number.
 */
export function Sparkline({
  points,
  width = 240,
  height = 44,
  color = 'rgb(var(--blue))',
  className,
  ariaLabel,
}: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  className?: string;
  ariaLabel?: string;
}) {
  if (points.length === 0) {
    return <div className={clsx('text-[11px] text-muted', className)}>no activity yet</div>;
  }

  const max = Math.max(...points, 1);
  const pad = 3;
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);

  const line = points.map((p, i) => `${pad + i * stepX},${y(p)}`).join(' ');
  const area = `${pad},${height} ${line} ${pad + (points.length - 1) * stepX},${height}`;
  const lastX = pad + (points.length - 1) * stepX;
  const gradId = `spark-${Math.round(width)}-${points.length}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={clsx('w-full', className)}
      style={{ height }}
      role="img"
      aria-label={ariaLabel ?? `trend, latest ${points[points.length - 1]}`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${gradId})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={y(points[points.length - 1]!)} r="2.5" fill={color} />
    </svg>
  );
}

/** Discrete daily bars — clearer than a line when most days are zero. */
export function BarTrend({
  points,
  labels,
  color = 'rgb(var(--blue))',
  className,
  ariaLabel,
}: {
  points: number[];
  /** Per-point caption for the hover readout, e.g. the date. */
  labels?: string[];
  color?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const max = Math.max(...points, 1);
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <div className={clsx('relative', className)}>
      {/* Pointing at a day reads out that day's own count, rather than leaving the
          bars as a shape you can only estimate from. */}
      {hovered !== null && (
        <span
          className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-hairline bg-tile-2 px-2 py-1 text-[11px] shadow-lg"
          style={{ left: `${((hovered + 0.5) / points.length) * 100}%` }}
        >
          <span className="tabular font-semibold text-ink">{points[hovered]}</span>
          <span className="ml-1 text-muted">{labels?.[hovered] ?? 'runs'}</span>
        </span>
      )}

      <div
        className="flex h-11 items-end gap-[3px]"
        role="img"
        aria-label={ariaLabel ?? `${points.reduce((a, b) => a + b, 0)} over ${points.length} days`}
      >
        {points.map((p, i) => (
          <span
            key={i}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            className="flex-1 cursor-default rounded-[2px] transition-opacity"
            style={{
              // A floor of 2px keeps empty days visible as a baseline instead of a gap.
              height: `${Math.max((p / max) * 100, 3)}%`,
              background: p === 0 ? 'rgb(var(--tile-2))' : color,
              opacity: hovered === i ? 1 : p === 0 ? 1 : 0.35 + (p / max) * 0.65,
            }}
          />
        ))}
      </div>
    </div>
  );
}
