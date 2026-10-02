import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import type { RiskTier, RunStatus } from '@supops/shared';
import { ENV_STYLE, HEALTH_STYLE, STATUS_STYLE, TIER_STYLE } from '../lib/format';

export function Panel({
  title,
  accent = 'bg-blue',
  action,
  className,
  children,
}: {
  title?: string;
  accent?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={clsx('tile', className)}>
      {title && (
        <header className="flex items-center gap-2 px-5 pb-3 pt-4">
          <span className={clsx('h-1.5 w-1.5 rounded-full', accent)} />
          <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
          <div className="ml-auto">{action}</div>
        </header>
      )}
      {children}
    </section>
  );
}

/** Risk tier. Always carries its label — never colour alone. */
export function RiskBadge({ tier, className }: { tier: RiskTier | null; className?: string }) {
  if (!tier) return null;
  const s = TIER_STYLE[tier];
  return (
    <span className={clsx('chip uppercase tracking-wide', s.chip, className)}>
      {tier === 'forbidden' && <LockGlyph />}
      {s.label}
    </span>
  );
}

const LockGlyph = () => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export function StatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium', s.text, className)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', s.dot, s.live && 'animate-pulse')} />
      {s.label}
    </span>
  );
}

export function EnvBadge({ env }: { env: string }) {
  return <span className={clsx('chip uppercase', ENV_STYLE[env] ?? ENV_STYLE.dev)}>{env}</span>;
}

export function HealthBadge({ state }: { state: string }) {
  const h = HEALTH_STYLE[state] ?? HEALTH_STYLE.unknown!;
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-[11px]', h.text)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', h.dot)} />
      {h.label}
    </span>
  );
}

export function Empty({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {icon && <div className="text-dim">{icon}</div>}
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-muted">{hint}</p>}
      {action}
    </div>
  );
}

export function CommandBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={clsx(
        'overflow-x-auto whitespace-pre-wrap break-words rounded-inner border border-hairline bg-ground/70',
        'px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink',
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
      role="status"
      aria-label="Loading"
    />
  );
}

/** A horizontal bar for a duration, relative to the slowest thing on screen. */
export function DurationBar({ ms, max, className }: { ms: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max((ms / max) * 100, 4) : 0;
  return (
    <div className={clsx('h-1 w-full overflow-hidden rounded-full bg-tile-2', className)} aria-hidden>
      <span className="block h-full rounded-full bg-muted/50" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** An on/off switch. Carries `role="switch"` so assistive tech reads it as one. */
export function Switch({
  checked, onChange, label, disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue/50 disabled:opacity-50',
        checked ? 'border-blue bg-blue' : 'border-edge bg-tile-2',
      )}
    >
      <span
        className={clsx(
          'inline-block h-4 w-4 rounded-full bg-ink shadow transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}

/** A joined, single-choice control for two to four short options. */
export function Segmented<T extends string>({
  value, options, onChange, label, disabled,
}: {
  value: T;
  options: Array<{ value: T; label: string; active?: string }>;
  onChange: (next: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={clsx('inline-flex rounded-full border border-edge bg-tile-2 p-0.5', disabled && 'opacity-50')}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={clsx(
              'rounded-full px-3 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue/50',
              on ? o.active ?? 'bg-blue/20 text-blue-text' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
