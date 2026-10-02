import { clsx } from 'clsx';

/**
 * "The Gate" — the SupOps mark.
 *
 * Four ascending bars are the risk tiers, split by a policy line: the two below it
 * are solid (the agent acts on its own), the two above are hollow (it stops and
 * asks). It draws the product's actual thesis rather than decorating it, and shares
 * a visual language with the `RiskBar` meter so the identity and the interface agree.
 *
 * The rule at y=11 is load-bearing: without it this is a generic bar chart.
 */

const BARS = [
  { x: 1, y: 15, h: 6, filled: true },
  { x: 7, y: 11, h: 10, filled: true },
  { x: 13, y: 7, h: 14, filled: false },
  { x: 19, y: 3, h: 18, filled: false },
];

/** Below ~20px the 4-bar geometry turns to mush, so a heavier 3-bar cut takes over. */
const COMPACT = [
  { x: 2, y: 13, h: 8, filled: true },
  { x: 9.5, y: 8, h: 13, filled: false },
  { x: 17, y: 4, h: 17, filled: false },
];

export function Logo({
  size = 24,
  mono = false,
  className,
}: {
  size?: number;
  /** currentColor throughout — for the PDF header and anywhere colour can't be trusted. */
  mono?: boolean;
  className?: string;
}) {
  const compact = size <= 18;
  const bars = compact ? COMPACT : BARS;
  const w = compact ? 5 : 4;
  const stroke = compact ? 2 : 1.5;
  const id = mono ? 'sg-mono' : 'sg-brand';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={clsx('shrink-0', className)}
      role="img"
      aria-label="SupOps"
    >
      {!mono && (
        <defs>
          <linearGradient id={id} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="rgb(var(--cyan))" />
            <stop offset="100%" stopColor="rgb(var(--blue))" />
          </linearGradient>
        </defs>
      )}

      {bars.map((b, i) =>
        b.filled ? (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={w}
            height={b.h}
            rx={w / 2}
            fill={mono ? 'currentColor' : `url(#${id})`}
          />
        ) : (
          <rect
            key={i}
            x={b.x + stroke / 2}
            y={b.y + stroke / 2}
            width={w - stroke}
            height={b.h - stroke}
            rx={(w - stroke) / 2}
            fill={mono ? 'none' : 'rgb(var(--blue))'}
            fillOpacity={mono ? 0 : 0}
            stroke={mono ? 'currentColor' : 'rgb(var(--muted))'}
            strokeWidth={stroke}
            className={mono ? undefined : 'logo-gated'}
          />
        ),
      )}

      {/* The policy line: exactly the top of the last filled bar. It breathes, so the
          mark reads as a live system rather than a static logo. */}
      <rect
        x={0}
        y={compact ? 12.25 : 10.25}
        width={24}
        height={stroke}
        rx={stroke / 2}
        fill={mono ? 'currentColor' : 'rgb(var(--blue))'}
        className={mono ? undefined : 'logo-line'}
      />
    </svg>
  );
}

/** Two-tone so it survives mono printing without relying on colour. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={clsx('font-semibold tracking-[-0.01em]', className)}>
      <span className="font-normal text-muted">Super</span>
      <span className="text-ink">Ops</span>
    </span>
  );
}

/**
 * The brand lockup.
 *
 * Uses the supplied artwork rather than the drawn mark: the full wordmark when
 * there is room, the bolt alone when the rail is collapsed. Sized by height so the
 * two stay optically consistent, and it lifts on hover -- the only decorative
 * motion here, and inert under reduced motion.
 */
export function Lockup({
  size = 30,
  showWordmark = true,
  /** Span the container width rather than being sized by height. */
  fill = false,
  className,
}: {
  size?: number;
  showWordmark?: boolean;
  fill?: boolean;
  className?: string;
}) {
  return (
    <span className={clsx('logo-lockup inline-flex items-center', fill && 'w-full', className)}>
      <img
        src={showWordmark ? '/brand-lockup.png' : '/brand-mark.png'}
        alt="SupOps"
        className={clsx(
          'logo-mark select-none object-contain',
          fill ? 'w-full' : 'w-auto',
        )}
        style={fill ? { maxHeight: size } : { height: size }}
        draggable={false}
      />
    </span>
  );
}
