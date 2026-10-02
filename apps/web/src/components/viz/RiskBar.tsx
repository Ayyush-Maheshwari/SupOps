import { useState } from 'react';
import { clsx } from 'clsx';
import type { RiskTier } from '@supops/shared';
import { TIER_STYLE } from '../../lib/format';

const ORDER: RiskTier[] = ['read_only', 'low', 'medium', 'high', 'forbidden'];

/**
 * Distribution of actions across risk tiers.
 *
 * Reading left to right is reading the autonomy story: a bar that is mostly slate
 * and cyan means the agent is doing its own work; a bar weighted amber and red
 * means it is spending its time waiting on people.
 */
export function RiskBar({
  counts,
  className,
  showLabels = true,
  /** Compact form for list rows: bar plus a numeric count, no legend. */
  inline = false,
  /** Full-width segmented bar with a per-tier tally beneath -- for a single hero card. */
  bar = false,
}: {
  counts: Partial<Record<RiskTier, number>>;
  className?: string;
  showLabels?: boolean;
  inline?: boolean;
  bar?: boolean;
}) {
  const [hovered, setHovered] = useState<RiskTier | null>(null);
  const present = ORDER.filter((t) => (counts[t] ?? 0) > 0);
  const total = present.reduce((sum, t) => sum + (counts[t] ?? 0), 0);

  if (total === 0) {
    // The inline form must keep its exact geometry when a run took no actions --
    // a Console answer with no commands is common, and swapping the bar for words
    // of a different width made the whole column jump row to row.
    if (inline) {
      return (
        <span className={clsx('inline-flex items-center gap-2', className)} aria-label="no actions">
          <span className="flex h-5 w-24 items-center">
            <span className="h-2 w-full rounded-full bg-tile-2" />
          </span>
          <span className="tabular w-6 shrink-0 text-right text-[11px] text-dim">0</span>
        </span>
      );
    }
    if (bar) {
      return (
        <div className={className} aria-label="no actions">
          <div className="h-2.5 w-full rounded-full bg-tile-2" />
        </div>
      );
    }
    return <div className={clsx('text-[11px] text-muted', className)}>no actions yet</div>;
  }

  const label = present.map((t) => `${counts[t]} ${TIER_STYLE[t].label}`).join(', ');

  // A bare bar conveys its meaning by colour alone, so the compact form keeps the
  // action count as text beside it.
  if (inline) {
    return (
      <span className={clsx('inline-flex items-center gap-2', className)}>
        {/* A 6px bar is a hard target, so the visible bar sits inside a 20px-tall
            row and a transparent hit layer on top carries the hover. No `title`
            attribute anywhere: the browser delays those by half a second, which is
            what made the value feel slow to appear. */}
        <span className="relative flex h-5 w-24 items-center">
          <span
            className="flex h-2 w-full overflow-hidden rounded-full bg-tile-2"
            role="img"
            aria-label={label}
          >
            {present.map((t) => (
              <span
                key={t}
                className={clsx(TIER_STYLE[t].bg, 'transition-opacity')}
                style={{
                  width: `${((counts[t] ?? 0) / total) * 100}%`,
                  opacity: hovered && hovered !== t ? 0.4 : 1,
                }}
              />
            ))}
          </span>

          <span className="absolute inset-0 flex" aria-hidden>
            {present.map((t) => (
              <span
                key={t}
                className="cursor-default"
                style={{ width: `${((counts[t] ?? 0) / total) * 100}%` }}
                onMouseEnter={() => setHovered(t)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </span>
        </span>

        {/* The count slot doubles as the readout: pointing at a segment swaps the
            total for that segment's own value. Fixed width so the bar never shifts. */}
        <span
          className={clsx(
            'tabular w-6 shrink-0 text-right text-[11px]',
            hovered ? TIER_STYLE[hovered].text : 'text-muted',
          )}
        >
          {hovered ? counts[hovered] : total}
        </span>
      </span>
    );
  }

  // The plain per-tier tally. The dot carries the risk colour, so severity reads at
  // a glance without a separate key.
  const tally = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {present.map((t) => (
        <span key={t} className="inline-flex items-baseline gap-1.5">
          <span
            className={clsx('h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full', TIER_STYLE[t].bg)}
            aria-hidden
          />
          <span className={clsx('tabular text-sm font-semibold', TIER_STYLE[t].text)}>
            {counts[t]}
          </span>
          {showLabels && <span className="text-[11px] text-muted">{TIER_STYLE[t].label}</span>}
        </span>
      ))}
    </div>
  );

  // Hero form: a full-width segmented bar (the fingerprint) with the tally beneath it
  // as its legend. Pointing at a segment dims the others and floats its value above.
  if (bar) {
    let run = 0;
    const midpoint: Partial<Record<RiskTier, number>> = {};
    for (const t of present) {
      const pct = ((counts[t] ?? 0) / total) * 100;
      midpoint[t] = run + pct / 2;
      run += pct;
    }
    return (
      <div className={clsx('space-y-2.5', className)}>
        <div className="relative">
          {hovered && (
            <span
              className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-hairline bg-tile-2 px-2 py-1 text-[11px] shadow-lg"
              style={{ left: `${midpoint[hovered]}%` }}
            >
              <span className={clsx('tabular font-semibold', TIER_STYLE[hovered].text)}>{counts[hovered]}</span>
              <span className="ml-1 text-muted">{TIER_STYLE[hovered].label}</span>
            </span>
          )}
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-tile-2" role="img" aria-label={label}>
            {present.map((t) => (
              <span
                key={t}
                className={clsx(TIER_STYLE[t].bg, 'cursor-default transition-[width] duration-500')}
                style={{
                  width: `${((counts[t] ?? 0) / total) * 100}%`,
                  opacity: hovered && hovered !== t ? 0.4 : 1,
                }}
                onMouseEnter={() => setHovered(t)}
                onMouseLeave={() => setHovered(null)}
              />
            ))}
          </div>
        </div>
        {tally}
      </div>
    );
  }

  return <div className={className}>{tally}</div>;
}
