import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { useReveal } from '../lib/useReveal';

/**
 * The bento grid.
 *
 * Twelve columns on desktop, six on tablet, one on mobile. Row spans apply only
 * from `md` up -- on a phone a fixed row height would clip content rather than
 * scroll it, so tiles fall back to auto height.
 */
export function Bento({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        'grid grid-cols-1 gap-4 md:grid-cols-6 md:auto-rows-[82px] xl:grid-cols-12',
        className,
      )}
    >
      {children}
    </div>
  );
}

const COL: Record<number, string> = {
  3: 'md:col-span-3 xl:col-span-3',
  4: 'md:col-span-3 xl:col-span-4',
  5: 'md:col-span-6 xl:col-span-5',
  6: 'md:col-span-6 xl:col-span-6',
  8: 'md:col-span-6 xl:col-span-8',
  9: 'md:col-span-6 xl:col-span-9',
  12: 'md:col-span-6 xl:col-span-12',
};

const ROW: Record<number, string> = {
  1: 'md:row-span-1',
  2: 'md:row-span-2',
  3: 'md:row-span-3',
  4: 'md:row-span-4',
  5: 'md:row-span-5',
};

export function Tile({
  span = 4,
  rows = 2,
  index = 0,
  interactive = false,
  className,
  children,
  ...rest
}: {
  span?: number;
  rows?: number;
  /** Position in the stagger sequence. */
  index?: number;
  interactive?: boolean;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const { ref, shown } = useReveal();

  return (
    <div
      ref={ref}
      style={{ '--i': index } as React.CSSProperties}
      className={clsx(
        COL[span] ?? COL[4],
        ROW[rows] ?? ROW[2],
        interactive ? 'tile-interactive' : 'tile',
        'reveal min-h-0 overflow-hidden',
        shown && 'reveal-in',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Standard tile chrome: a small colour dot, a title, and an optional action. */
export function TileHead({
  title,
  accent = 'bg-blue',
  action,
  icon,
}: {
  title: string;
  accent?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2.5 px-5 pb-3 pt-4">
      {icon ?? (
        // A larger dot with a soft halo, so the heading reads as a titled section
        // rather than a faint label floating above the content.
        <span className={clsx('h-2 w-2 rounded-full ring-4 ring-current/10', accent)} />
      )}
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <div className="ml-auto">{action}</div>
    </header>
  );
}
