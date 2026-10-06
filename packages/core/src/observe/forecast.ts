import type { Point } from './anomaly.ts';
import { formatEta } from '@supops/shared';

/**
 * When will a resource run out? Fitted in code from the series' recent history: a
 * straight line over the last 6 and 24 hours (whichever is more conservative and
 * still fits), cross-checked against Holt's double exponential smoothing, which
 * follows a trend that has recently changed. A fit that explains little of the
 * movement is reported as low confidence and never raises an incident on its own.
 */

export interface Limit {
  value: number;
  when: 'below' | 'above';
}

export interface Forecast {
  /** Milliseconds until the limit is reached; 0 when already past it; null when not heading there. */
  etaMs: number | null;
  /** Change per hour along the chosen fit. */
  slopePerHour: number;
  current: number;
  confidence: 'high' | 'medium' | 'low';
  r2: number;
  windowHours: number;
}

const HOUR = 3_600_000;

export function linearFit(points: Point[]): { slope: number; intercept: number; r2: number } | null {
  const n = points.length;
  if (n < 3) return null;
  const t0 = points[0]!.at;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const x = p.at - t0;
    sx += x; sy += p.value; sxx += x * x; sxy += x * p.value;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n - slope * t0;
  const mean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    const f = slope * p.at + intercept;
    ssTot += (p.value - mean) ** 2;
    ssRes += (p.value - f) ** 2;
  }
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

/** Holt's linear trend: the smoothed level and trend (per ms) at the last point. */
export function holt(points: Point[], alpha = 0.5, beta = 0.2): { level: number; trend: number } | null {
  if (points.length < 3) return null;
  let level = points[0]!.value;
  let trend = (points[1]!.value - points[0]!.value) / Math.max(1, points[1]!.at - points[0]!.at);
  for (let i = 1; i < points.length; i++) {
    const dt = Math.max(1, points[i]!.at - points[i - 1]!.at);
    const prev = level;
    level = alpha * points[i]!.value + (1 - alpha) * (level + trend * dt);
    trend = beta * ((level - prev) / dt) + (1 - beta) * trend;
  }
  return { level, trend };
}

const past = (v: number, l: Limit) => (l.when === 'below' ? v <= l.value : v >= l.value);

export function forecastLimit(points: Point[], limit: Limit, now = points[points.length - 1]?.at ?? Date.now()): Forecast | null {
  const pts = points.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.at - b.at);
  if (pts.length < 6 || pts[pts.length - 1]!.at - pts[0]!.at < HOUR) return null;
  const current = pts[pts.length - 1]!.value;

  const fits = [6, 24]
    .map((h) => {
      const w = pts.filter((p) => p.at >= now - h * HOUR);
      const f = w.length >= 6 ? linearFit(w) : null;
      return f ? { ...f, h } : null;
    })
    .filter((f): f is NonNullable<typeof f> => !!f);
  if (!fits.length) return null;

  const toward = (slope: number) => (limit.when === 'below' ? slope < 0 : slope > 0);
  const eta = (f: { slope: number; intercept: number }) => {
    if (past(current, limit)) return 0;
    if (!toward(f.slope)) return null;
    // From the fitted value now, so one noisy last sample does not swing the answer.
    const fitted = f.slope * now + f.intercept;
    const ms = (limit.value - fitted) / f.slope;
    return ms <= 0 ? 0 : ms;
  };

  // The more conservative (sooner) of the fits that explain the movement reasonably.
  const usable = fits.filter((f) => f.r2 >= 0.5 && eta(f) !== null);
  const chosen = usable.sort((a, b) => eta(a)! - eta(b)!)[0] ?? fits.sort((a, b) => b.r2 - a.r2)[0]!;
  const etaMs = eta(chosen);

  // Holt disagreeing about the direction means the trend has turned: trust it less.
  const h = holt(pts.filter((p) => p.at >= now - 24 * HOUR));
  const agrees = !h || toward(h.trend) === toward(chosen.slope);
  const confidence: Forecast['confidence'] =
    !agrees ? 'low' : chosen.r2 >= 0.9 ? 'high' : chosen.r2 >= 0.7 ? 'medium' : 'low';

  return {
    etaMs: etaMs === null ? null : Math.round(etaMs),
    slopePerHour: chosen.slope * HOUR,
    current,
    confidence: past(current, limit) ? 'high' : confidence,
    r2: Number(chosen.r2.toFixed(3)),
    windowHours: chosen.h,
  };
}

/** Where a series is heading `horizonMs` from now, by the 24h linear fit. */
export function project(points: Point[], horizonMs: number, now = points[points.length - 1]?.at ?? Date.now()): { value: number; slopePerHour: number; r2: number } | null {
  const w = points.filter((p) => p.at >= now - 24 * HOUR && Number.isFinite(p.value));
  const f = linearFit(w);
  if (!f) return null;
  return { value: f.slope * (now + horizonMs) + f.intercept, slopePerHour: f.slope * HOUR, r2: f.r2 };
}

export { formatEta } from '@supops/shared';
