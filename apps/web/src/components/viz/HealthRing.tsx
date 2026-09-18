import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';

export interface RingSegment {
  label: string;
  value: number;
  hex: string;
}

/**
 * A donut for proportions.
 *
 * The centre always carries the headline number and a word, so the chart is never
 * the only way to read the value -- the skill's chart guidance is explicit that
 * colour alone must not carry meaning, and a ring with no text fails that outright.
 */
export function HealthRing({
  segments,
  size = 108,
  thickness = 10,
  center,
  caption,
  className,
  /** Override the derived centre size where a specific usage wants its own. */
  centreSize: centreSizeProp,
}: {
  segments: RingSegment[];
  size?: number;
  thickness?: number;
  /** Headline value. Accepts a node so a glyph (a tick, a lock) can sit here too. */
  center: ReactNode;
  caption?: string;
  className?: string;
  centreSize?: number;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const [hovered, setHovered] = useState<RingSegment | null>(null);

  // The centre text has to scale with the ring. At a fixed 24px a 34px ring (the
  // target picker) renders a letter larger than the ring it sits in.
  const centreSize = centreSizeProp ?? Math.min(24, Math.max(14, Math.round(size * 0.24)));
  // Usable width inside the stroke, so a hovered label wraps rather than clipping.
  const innerWidth = Math.max(0, size - thickness * 2 - 8);

  let offset = 0;

  return (
    <div className={clsx('relative inline-grid place-items-center', className)}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgb(var(--tile-2))"
          strokeWidth={thickness}
        />
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => {
              const len = (s.value / total) * circumference;
              const dash = `${len} ${circumference - len}`;
              const el = (
                <circle
                  key={s.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={s.hex}
                  strokeWidth={thickness}
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  strokeLinecap={segments.length === 1 ? 'round' : 'butt'}
                  className="cursor-default transition-opacity"
                  style={{ opacity: hovered && hovered !== s ? 0.35 : 1 }}
                  onMouseEnter={() => setHovered(s)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <title>{`${s.label}: ${s.value}`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
      </svg>

      <div className="pointer-events-none absolute grid place-items-center text-center">
        <span
          className="tabular font-semibold leading-none"
          style={{ fontSize: centreSize, color: hovered ? hovered.hex : 'rgb(var(--text))' }}
        >
          {hovered ? hovered.value : center}
        </span>
        {(hovered ? hovered.label : caption) && (
          <span
            className="mt-1 uppercase leading-tight tracking-wide text-muted"
            style={{
              // Wraps inside the ring instead of truncating -- labels like
              // "ran automatically" do not fit on one line at any sane size.
              maxWidth: innerWidth,
              fontSize: Math.max(8, Math.round(centreSize * 0.42)),
            }}
          >
            {hovered ? hovered.label : caption}
          </span>
        )}
      </div>
    </div>
  );
}

/** Text legend — the non-colour channel for the ring above. */
export function RingLegend({
  segments,
  className,
  dense,
}: {
  segments: RingSegment[];
  className?: string;
  /** Tighter rows, for tiles where all four outcomes must fit without scrolling. */
  dense?: boolean;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <ul className={clsx(dense ? 'space-y-1.5' : 'space-y-2.5', className)}>
      {segments.map((s) => (
        <li
          key={s.label}
          className={clsx('flex items-center gap-2.5', dense ? 'text-xs' : 'text-[13px]')}
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.hex }} />
          <span className="flex-1 truncate text-muted">{s.label}</span>
          <span className="tabular font-semibold text-ink">{s.value}</span>
          <span className="tabular w-10 text-right text-xs text-muted">
            {Math.round((s.value / total) * 100)}%
          </span>
        </li>
      ))}
    </ul>
  );
}
