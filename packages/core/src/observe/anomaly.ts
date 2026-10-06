/**
 * Anomalies, computed in code from a series' own history -- no model involved. A
 * point is compared with what the same series normally does: at the same time of
 * day on previous days once there are two days of history (so a nightly batch job
 * is not an anomaly every night), otherwise the last few hours. The spread is the
 * median absolute deviation, which a single past spike cannot inflate the way a
 * standard deviation can. Several anomalous points in a row are needed, so one odd
 * sample never raises anything.
 */

export interface Point {
  at: number;
  value: number;
}

export interface AnomalyOptions {
  /** Which way is a problem: up (errors, latency), down (free space), or both. */
  badDirection?: 'up' | 'down' | 'both';
  /** Robust z-score at which a point is anomalous. */
  threshold?: number;
  /** Consecutive anomalous points needed. */
  minStreak?: number;
  /** Smallest change that matters, in the series' own unit (e.g. 2 percentage points). */
  minDelta?: number;
  now?: number;
}

export interface AnomalyResult {
  anomalous: boolean;
  /** The latest point's robust z-score against its baseline. */
  z: number;
  baseline: number;
  spread: number;
  value: number;
  direction: 'up' | 'down';
  method: 'seasonal' | 'recent';
  /** How many of the latest points are anomalous in the same direction. */
  streak: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
export function mad(xs: number[], med = median(xs)): number {
  return 1.4826 * median(xs.map((x) => Math.abs(x - med)));
}

/** Points from earlier days within `windowMs` of `at`'s time of day. */
function sameTimeOfDay(history: Point[], at: number, windowMs: number): number[] {
  const out: number[] = [];
  for (const p of history) {
    if (p.at > at - DAY + windowMs) continue; // only earlier days
    const off = Math.abs((((p.at - at) % DAY) + DAY) % DAY);
    if (off <= windowMs || off >= DAY - windowMs) out.push(p.value);
  }
  return out;
}

export function detectAnomaly(points: Point[], opts: AnomalyOptions = {}): AnomalyResult | null {
  const threshold = opts.threshold ?? 4;
  const minStreak = opts.minStreak ?? 3;
  const bad = opts.badDirection ?? 'both';
  const pts = points.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.at - b.at);
  if (pts.length < minStreak + 12) return null;

  const latest = pts.slice(-minStreak);
  const history = pts.slice(0, -minStreak);
  const span = history[history.length - 1]!.at - history[0]!.at;
  const seasonal = span >= 2 * DAY;

  const score = (p: Point) => {
    let base: number[];
    if (seasonal) {
      base = sameTimeOfDay(history, p.at, 45 * 60_000);
      if (base.length < 6) base = history.filter((h) => h.at >= p.at - 6 * HOUR).map((h) => h.value);
    } else {
      base = history.filter((h) => h.at >= p.at - 6 * HOUR).map((h) => h.value);
    }
    if (base.length < 6) return null;
    const med = median(base);
    // A flat series has no spread: floor it so a tiny wobble is not "infinitely" odd.
    const spread = Math.max(mad(base, med), Math.abs(med) * 0.02, 1e-9);
    const delta = p.value - med;
    const z = Math.abs(delta) < (opts.minDelta ?? 0) ? 0 : delta / spread;
    return { z, med, spread };
  };

  const scored = latest.map(score);
  const last = scored[scored.length - 1];
  if (!last) return null;
  const direction: 'up' | 'down' = last.z >= 0 ? 'up' : 'down';
  let streak = 0;
  for (let i = scored.length - 1; i >= 0; i--) {
    const s = scored[i];
    if (!s || Math.abs(s.z) < threshold || (s.z >= 0 ? 'up' : 'down') !== direction) break;
    streak++;
  }
  const wrongWay = bad !== 'both' && bad !== direction;
  return {
    anomalous: streak >= minStreak && !wrongWay,
    z: Number(last.z.toFixed(2)),
    baseline: last.med,
    spread: last.spread,
    value: latest[latest.length - 1]!.value,
    direction,
    method: seasonal ? 'seasonal' : 'recent',
    streak,
  };
}
