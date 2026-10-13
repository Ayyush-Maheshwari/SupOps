import type { Point } from './anomaly.ts';
import type { Limit } from './forecast.ts';

/**
 * When will a resource reach its limit? The model the watcher and the agents share,
 * built the way capacity forecasting is done in practice (Datadog's linear and
 * seasonal forecasts, STL-style decomposition, robust regression):
 *
 *  1. Hourly means over up to three weeks, so a single spike is never the level.
 *  2. Only the history since the last level shift (a cleanup, a resize, a restart):
 *     a disk that was emptied yesterday is forecast from yesterday, not from last week.
 *     A jump that also happened at the same time the day before is part of the
 *     daily pattern, not a shift.
 *  3. Trend + pattern + noise: a robust Theil–Sen trend, a daily (or weekly) profile
 *     from per-hour medians, refined twice, and the spread of what is left.
 *  4. The model is chosen by backtest: fitted without the last day, each candidate
 *     (straight line, line + daily pattern, line + weekly pattern) predicts that day,
 *     and the one with the smallest error wins; a richer one must win clearly.
 *  5. A trend the data does not support (pairwise slopes disagree, or it moves less
 *     than `minRise` over the history) is flattened: daily ups and downs and slow
 *     random walks are not growth.
 *  6. The forecast runs two weeks ahead with a 90% band (the spread of the noise, and
 *     of the trend). It says when the forecast reaches the limit and the earliest
 *     the band does, and how much to trust it: history, trend consistency, pattern
 *     strength and backtest error against the headroom left.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ForecastModel = 'linear' | 'daily' | 'weekly';

export interface Prediction {
  model: ForecastModel;
  /** Milliseconds from `now` until the forecast reaches the limit; 0 when it already has; null when it does not within the horizon. */
  etaMs: number | null;
  /** The earliest the 90% band reaches it: the pessimistic case. */
  earliestMs: number | null;
  /** Trend per day, pattern removed (0 when the data does not support one). */
  perDay: number;
  /** The model's value now (trend + pattern). */
  level: number;
  confidence: 'high' | 'medium' | 'low';
  /** The forecast, hourly: [time, expected, low, high]. */
  path: Array<[number, number, number, number]>;
  /** Hours of history used (after the last level shift). */
  historyHours: number;
  /** When the last level shift happened, if one cut the history. */
  shiftAt: number | null;
  /** Mean absolute error predicting the last day it had not seen; null with under three days. */
  backtestMae: number | null;
  /** How much of the movement the daily/weekly pattern explains, 0 to 1. */
  seasonality: number;
}

export interface PredictOptions {
  now?: number;
  stepMs?: number;
  /** How far ahead to forecast (default 14 days). */
  horizonMs?: number;
  /** Smallest change over the history that counts as a trend, in the series' unit. */
  minRise?: number;
}

// ---- small robust statistics ------------------------------------------------

function median(v: number[]): number {
  if (!v.length) return NaN;
  const a = [...v].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** Quantile of an already sorted array. */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** Robust spread: 1.4826 × median absolute deviation (equals σ for normal noise). */
function robustSd(v: number[]): number {
  const m = median(v);
  return 1.4826 * median(v.map((x) => Math.abs(x - m)));
}

function variance(v: number[]): number {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
}

// ---- preparing the history ---------------------------------------------------

/** Means per step, aligned to whole steps (hours) so the daily pattern lines up. */
export function resample(points: Point[], stepMs = HOUR, now = Infinity): { t: number[]; y: number[] } {
  const sums = new Map<number, [number, number]>();
  for (const p of points) {
    if (!Number.isFinite(p.value) || p.at > now) continue;
    const b = Math.floor(p.at / stepMs);
    const s = sums.get(b) ?? [0, 0];
    s[0] += p.value;
    s[1] += 1;
    sums.set(b, s);
  }
  const keys = [...sums.keys()].sort((a, b) => a - b);
  return { t: keys.map((k) => k * stepMs + stepMs / 2), y: keys.map((k) => sums.get(k)![0] / sums.get(k)![1]) };
}

/**
 * Where the last level shift is, if any: a jump far beyond the usual hour-to-hour
 * change, that stays (the level after it differs from before it), and that is not
 * part of the daily or weekly pattern (no similar jump a day or a week earlier).
 */
export function lastShift(t: number[], y: number[], stepMs = HOUR, minJump = 0): number | null {
  const n = y.length;
  if (n < 8) return null;
  const d = y.map((v, i) => (i ? v - y[i - 1]! : 0)).slice(1);
  // The usual hour-to-hour step: its scatter, or its size when the series moves
  // steadily (a filling disk changes by about the same amount every hour).
  const noise = Math.max(robustSd(d), median(d.map(Math.abs)), Math.abs(median(y)) * 1e-6, 1e-12);
  const idxAt = new Map(t.map((x, i) => [x, i]));
  for (let i = n - 3; i >= 1; i--) {
    const jump = y[i]! - y[i - 1]!;
    if (Math.abs(jump) <= Math.max(6 * noise, minJump)) continue;
    const before = median(y.slice(Math.max(0, i - 6), i));
    const after = median(y.slice(i, Math.min(n, i + 6)));
    if (Math.sign(after - before) !== Math.sign(jump) || Math.abs(after - before) < 0.5 * Math.abs(jump)) continue;
    // The same jump a day (or a week) earlier: a pattern, not a shift.
    const recurring = [DAY, 7 * DAY].some((p) => {
      const j = idxAt.get(t[i]! - p);
      if (j === undefined || j < 1) return false;
      const prev = y[j]! - y[j - 1]!;
      return Math.sign(prev) === Math.sign(jump) && Math.abs(prev) >= 0.4 * Math.abs(jump);
    });
    if (recurring) continue;
    return i;
  }
  return null;
}

// ---- fitting -----------------------------------------------------------------

interface Fit {
  model: ForecastModel;
  /** Per day, from the last point. */
  slope: number;
  /** Value of the trend at the last point. */
  intercept: number;
  tLast: number;
  profile: number[] | null;
  period: number;
  stepMs: number;
  sigma: number;
  /** All pairwise slopes, sorted: the trend's own uncertainty. */
  slopes: number[];
  seasonality: number;
}

function theilSenFull(x: number[], y: number[]): { slope: number; intercept: number; slopes: number[] } {
  const slopes: number[] = [];
  // Evenly thinned to at most 150 points (11k pairs): the median slope barely moves,
  // and a hundred series fit in well under a second each.
  const stride = x.length > 150 ? Math.ceil(x.length / 150) : 1;
  for (let i = 0; i < x.length; i += stride)
    for (let j = i + stride; j < x.length; j += stride) {
      const dx = x[j]! - x[i]!;
      if (dx !== 0) slopes.push((y[j]! - y[i]!) / dx);
    }
  slopes.sort((a, b) => a - b);
  const slope = slopes.length ? quantile(slopes, 0.5) : 0;
  const intercept = median(y.map((v, i) => v - slope * x[i]!));
  return { slope, intercept, slopes };
}

function binOf(t: number, period: number, stepMs: number): number {
  return Math.floor((((t % period) + period) % period) / stepMs);
}

function fit(t: number[], y: number[], model: ForecastModel, stepMs: number): Fit {
  const tLast = t[t.length - 1]!;
  const x = t.map((v) => (v - tLast) / DAY);
  const period = model === 'weekly' ? 7 * DAY : DAY;
  const bins = Math.round(period / stepMs);
  let trend = theilSenFull(x, y);
  let profile: number[] | null = null;
  if (model !== 'linear') {
    // Two rounds: pattern from the detrended data, trend from the de-patterned data.
    for (let round = 0; round < 2; round++) {
      const groups: number[][] = Array.from({ length: bins }, () => []);
      y.forEach((v, i) => groups[binOf(t[i]!, period, stepMs)]!.push(v - (trend.intercept + trend.slope * x[i]!)));
      const raw = groups.map((g) => (g.length ? median(g) : NaN));
      const known = raw.filter((v) => Number.isFinite(v));
      const centre = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0;
      profile = raw.map((v) => (Number.isFinite(v) ? v - centre : 0));
      trend = theilSenFull(x, y.map((v, i) => v - profile![binOf(t[i]!, period, stepMs)]!));
    }
  }
  const seasonal = (i: number) => (profile ? profile[binOf(t[i]!, period, stepMs)]! : 0);
  const detrended = y.map((v, i) => v - (trend.intercept + trend.slope * x[i]!));
  const resid = detrended.map((v, i) => v - seasonal(i));
  const vd = variance(detrended);
  return {
    model,
    slope: trend.slope,
    intercept: trend.intercept,
    tLast,
    profile,
    period,
    stepMs,
    sigma: robustSd(resid),
    slopes: trend.slopes,
    seasonality: profile && vd > 0 ? Math.max(0, 1 - variance(resid) / vd) : 0,
  };
}

function valueAt(f: Fit, at: number, slope = f.slope): number {
  return f.intercept + slope * ((at - f.tLast) / DAY) + (f.profile ? f.profile[binOf(at, f.period, f.stepMs)]! : 0);
}

/** Fit on everything but the last day, predict that day, and score each model. */
function backtest(t: number[], y: number[], stepMs: number): { model: ForecastModel; mae: number } | null {
  const hold = Math.round(DAY / stepMs);
  const n = y.length;
  if (n < 3 * hold) return null;
  const tt = t.slice(0, n - hold), ty = y.slice(0, n - hold);
  const candidates: ForecastModel[] = ['linear', 'daily'];
  if (tt[tt.length - 1]! - tt[0]! >= 13.5 * DAY) candidates.push('weekly');
  const scored = candidates.map((model) => {
    const f = fit(tt, ty, model, stepMs);
    let err = 0;
    for (let i = n - hold; i < n; i++) err += Math.abs(y[i]! - valueAt(f, t[i]!));
    return { model, mae: err / hold };
  });
  // A richer model has to earn it: at least 10% less error than the simpler one.
  let best = scored[0]!;
  for (const s of scored.slice(1)) if (s.mae < best.mae * 0.9) best = s;
  return best;
}

// ---- the forecast ------------------------------------------------------------

export function predict(points: Point[], limit: Limit, opts: PredictOptions = {}): Prediction | null {
  const stepMs = opts.stepMs ?? HOUR;
  const now = opts.now ?? points.reduce((m, p) => Math.max(m, p.at), 0);
  const horizonMs = opts.horizonMs ?? 14 * DAY;
  const minRise = opts.minRise ?? 0;

  let { t, y } = resample(points, stepMs, now);
  if (y.length < 12 || t[t.length - 1]! - t[0]! < 12 * HOUR) return null;

  // History since the last level shift, if it leaves enough to work with.
  const shift = lastShift(t, y, stepMs, minRise);
  let shiftAt: number | null = null;
  if (shift !== null) {
    shiftAt = t[shift]! - stepMs / 2;
    t = t.slice(shift);
    y = y.slice(shift);
  }
  if (y.length < 6) return null;
  const historyHours = (t[t.length - 1]! - t[0]! + stepMs) / HOUR;
  const spanDays = historyHours / 24;

  // Choose the model by how well each predicted a day it had not seen.
  const bt = backtest(t, y, stepMs);
  let model: ForecastModel = bt?.model ?? 'linear';
  if (!bt && spanDays >= 2) {
    const daily = fit(t, y, 'daily', stepMs);
    if (daily.seasonality >= 0.4) model = 'daily';
  }
  const f = fit(t, y, model, stepMs);

  // Is the trend real? Most pairwise slopes must agree, and it must move enough.
  const toward = (v: number) => (limit.when === 'above' ? v > 0 : v < 0);
  const q = (p: number) => quantile(f.slopes, p);
  const consistent = toward(f.slope) ? toward(limit.when === 'above' ? q(0.25) : q(0.75)) : false;
  const meaningful = Math.abs(f.slope) * spanDays > minRise;
  const slope = consistent && meaningful ? f.slope : 0;
  const strong = toward(limit.when === 'above' ? q(0.1) : q(0.9));

  // The band: noise, plus how far the trend could plausibly be off.
  const lo5 = q(0.05), hi95 = q(0.95);
  const n = y.length;
  const steps = Math.max(1, Math.round(horizonMs / stepMs));
  const path: Prediction['path'] = [];
  for (let k = 1; k <= steps; k++) {
    const at = f.tLast + k * stepMs;
    const mid = valueAt(f, at, slope);
    const ahead = (at - f.tLast) / DAY;
    const noise = 1.645 * f.sigma * Math.sqrt(1 + k / n);
    const up = Math.max(0, (Number.isFinite(hi95) ? hi95 : slope) - slope) * ahead;
    const down = Math.max(0, slope - (Number.isFinite(lo5) ? lo5 : slope)) * ahead;
    path.push([at, mid, mid - down - noise, mid + up + noise]);
  }

  const past = (v: number) => (limit.when === 'above' ? v >= limit.value : v <= limit.value);
  const level = valueAt(f, f.tLast, slope);
  const crossing = (col: 1 | 2 | 3): number | null => {
    if (past(level) && col === 1) return 0;
    let prevT = f.tLast, prevV = level;
    for (const row of path) {
      const v = row[col];
      if (past(v)) {
        // Between two steps, where the line meets the limit.
        const frac = v === prevV ? 1 : Math.min(1, Math.max(0, (limit.value - prevV) / (v - prevV)));
        return Math.max(0, Math.round(prevT + frac * (row[0] - prevT) - now));
      }
      prevT = row[0];
      prevV = v;
    }
    return null;
  };
  const etaMs = crossing(1);
  const earliestMs = crossing(limit.when === 'above' ? 3 : 2);

  // How much to trust it.
  let confidence: Prediction['confidence'] = 'low';
  const byPattern = etaMs !== null && slope === 0;
  if (etaMs !== null) {
    if (spanDays >= 3 && ((strong && slope !== 0) || (byPattern && f.seasonality >= 0.5))) confidence = 'high';
    else if (spanDays >= 1.5 && (slope !== 0 || (byPattern && f.seasonality >= 0.3))) confidence = 'medium';
    // Half a day of a fill that nearly every pair of hours agrees on is worth acting on.
    else if (spanDays >= 0.5 && strong && slope !== 0) confidence = 'medium';
    // A model that missed the last day by a lot, against the room left, is not to be trusted far.
    const headroom = Math.abs(limit.value - level);
    if (bt && headroom > 0 && bt.mae > 0.25 * headroom) confidence = confidence === 'high' ? 'medium' : 'low';
  }

  return {
    model,
    etaMs,
    earliestMs,
    perDay: slope,
    level,
    confidence,
    path,
    historyHours: Math.round(historyHours),
    shiftAt,
    backtestMae: bt ? bt.mae : null,
    seasonality: Number(f.seasonality.toFixed(2)),
  };
}
