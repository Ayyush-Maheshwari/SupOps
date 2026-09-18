import { useEffect, useRef, useState } from 'react';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Animate a metric to its value.
 *
 * Counts from the previous value rather than from zero, so a dashboard that
 * refreshes every few seconds ticks 4 → 5 instead of replaying 0 → 5 and making a
 * stable number look like it is thrashing. Pair with `.tabular` so the width holds.
 */
export function useCountUp(value: number, durationMs = 600): number {
  const [display, setDisplay] = useState(value);
  const from = useRef(value);
  const frame = useRef<number>();

  useEffect(() => {
    if (prefersReducedMotion() || value === from.current) {
      from.current = value;
      setDisplay(value);
      return;
    }

    const start = performance.now();
    const origin = from.current;
    const delta = value - origin;

    const tick = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      // easeOutCubic -- decelerate on arrival, per the motion guidance.
      const eased = 1 - (1 - t) ** 3;
      setDisplay(Math.round(origin + delta * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else from.current = value;
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      from.current = value;
    };
  }, [value, durationMs]);

  return display;
}
