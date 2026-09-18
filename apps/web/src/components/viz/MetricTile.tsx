import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { useCountUp } from '../../lib/useCountUp';

/**
 * A headline number with room for a small visual beneath it.
 *
 * The number counts from its previous value rather than from zero, so a dashboard
 * polling every few seconds does not make a stable metric look like it is churning.
 */
export function MetricTile({
  icon,
  label,
  value,
  tint = 'text-blue',
  bg = 'bg-blue/10',
  hint,
  children,
  animate = true,
  /** Bigger type for a tall tile that would otherwise read as mostly empty. */
  size = 'md',
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  tint?: string;
  bg?: string;
  hint?: ReactNode;
  children?: ReactNode;
  animate?: boolean;
  size?: 'md' | 'lg';
}) {
  const numeric = typeof value === 'number' ? value : null;
  const counted = useCountUp(numeric ?? 0);
  const shown = numeric === null ? value : animate ? counted : numeric;
  const large = size === 'lg';

  return (
    <div className="flex h-full flex-col justify-between p-5">
      <div className={clsx('flex items-start', large ? 'gap-3.5' : 'gap-3')}>
        <span
          className={clsx(
            'grid shrink-0 place-items-center rounded-xl',
            large ? 'h-11 w-11' : 'h-9 w-9',
            bg,
            tint,
          )}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={clsx(
              'truncate font-medium uppercase tracking-wider text-muted',
              large ? 'text-xs' : 'text-[11px]',
            )}
          >
            {label}
          </div>
          <div
            className={clsx(
              'tabular font-semibold leading-none text-ink',
              large ? 'mt-1.5 text-[44px]' : 'mt-0.5 text-[28px]',
            )}
          >
            {shown}
          </div>
        </div>
      </div>

      {children}

      {hint && (
        <div className={clsx('mt-3 truncate text-muted', large ? 'text-xs' : 'text-[11px]')}>{hint}</div>
      )}
    </div>
  );
}

/** A live indicator. The ring pulses; under reduced motion the dot alone remains. */
export function LiveDot({ className, color = 'text-blue' }: { className?: string; color?: string }) {
  return (
    <span className={clsx('relative inline-flex h-2 w-2', color, className)}>
      <span className="pulse-ring absolute inset-0 rounded-full" />
      <span className="h-2 w-2 rounded-full bg-current" />
    </span>
  );
}
