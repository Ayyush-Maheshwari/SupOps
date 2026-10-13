import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastShift, predict, resample } from './predict.ts';
import type { Point } from './anomaly.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

/** A deterministic pseudo-random source, so the tests never flake. */
function rng(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32 - 0.5;
  };
}

/** Samples every 5 minutes over `days`, ending at NOW. */
function series(days: number, f: (at: number, i: number) => number): Point[] {
  const out: Point[] = [];
  const n = Math.round((days * DAY) / (5 * 60_000));
  for (let i = 0; i <= n; i++) {
    const at = NOW - (n - i) * 5 * 60_000;
    out.push({ at, value: f(at, i) });
  }
  return out;
}

/** Busy in the day, quiet at night: peaks at 14:00 UTC. */
const daily = (at: number) => Math.cos(((((at % DAY) / HOUR) - 14) / 24) * 2 * Math.PI);

test('a busy-daytime CPU with no real growth is not forecast to fill up', () => {
  const r = rng();
  // 30% at night, 70% at the afternoon peak, noisy, for 14 days. The morning ramp
  // alone is +40 points in 6 hours: the old straight line said "100% tonight".
  const cpu = series(14, (at) => 50 + 20 * daily(at) + 8 * r());
  const p = predict(cpu, { value: 100, when: 'above' }, { now: NOW, minRise: 10 })!;
  assert.ok(p, 'a prediction');
  assert.equal(p.model, 'daily');
  assert.equal(p.perDay, 0, 'no trend');
  assert.equal(p.etaMs, null, 'never reaches 100%');
  assert.ok(p.seasonality > 0.6, `pattern found (${p.seasonality})`);
});

test('memory that grows a little every day is forecast to its daily peak, at the busy hour', () => {
  const r = rng(3);
  // Peak today about 80%, rising 4 points a day: 100% in about 5 days, at the peak hour.
  const mem = series(10, (at) => 70 + 10 * daily(at) + 4 * ((at - NOW) / DAY) + 1.5 * r());
  const p = predict(mem, { value: 100, when: 'above' }, { now: NOW, minRise: 5 })!;
  assert.equal(p.model, 'daily');
  assert.ok(Math.abs(p.perDay - 4) < 0.5, `trend ${p.perDay}`);
  assert.equal(p.confidence, 'high');
  const days = p.etaMs! / DAY;
  assert.ok(days > 4 && days < 5.6, `eta ${days.toFixed(2)} days`);
  const hourOfDay = new Date(NOW + p.etaMs!).getUTCHours();
  assert.ok(hourOfDay >= 10 && hourOfDay <= 18, `crosses in the busy hours, not at night (${hourOfDay}:00)`);
  assert.ok(p.earliestMs! <= p.etaMs!, 'the band reaches it no later than the forecast');
});

test('a filling disk is a straight line, and its date is right', () => {
  const r = rng(11);
  // 200 GB free, losing 10 GB a day: empty in 20 days, outside a 14-day horizon...
  const disk = series(7, (at) => 200e9 - 10e9 * ((at - NOW) / DAY) + 0.3e9 * r());
  const far = predict(disk, { value: 0, when: 'below' }, { now: NOW })!;
  assert.equal(far.model, 'linear');
  assert.equal(far.etaMs, null);
  // ...and 60 GB free at the same pace is 6 days.
  const near = predict(series(7, (at) => 60e9 - 10e9 * ((at - NOW) / DAY) + 0.3e9 * r()), { value: 0, when: 'below' }, { now: NOW })!;
  assert.ok(Math.abs(near.etaMs! / DAY - 6) < 0.3, `eta ${(near.etaMs! / DAY).toFixed(2)} days`);
  assert.equal(near.confidence, 'high');
});

test('after a cleanup, only the history since the cleanup counts', () => {
  const r = rng(5);
  // Filled fast for 5 days, freed 100 GB yesterday morning, filling slowly since.
  const cleanup = NOW - 30 * HOUR;
  const disk = series(6, (at) =>
    at < cleanup ? 20e9 - 15e9 * ((at - cleanup) / DAY) + 0.05e9 * r() : 120e9 - 2e9 * ((at - cleanup) / DAY) + 0.05e9 * r(),
  );
  const p = predict(disk, { value: 0, when: 'below' }, { now: NOW })!;
  assert.ok(p.shiftAt !== null && Math.abs(p.shiftAt - cleanup) <= HOUR, 'the cleanup is found');
  assert.ok(p.historyHours <= 31, `history since the cleanup (${p.historyHours}h)`);
  assert.ok(Math.abs(p.perDay + 2e9) < 0.5e9, `the slow rate since (${(p.perDay / 1e9).toFixed(2)} GB/day)`);
  assert.equal(p.etaMs, null, '~57 days away, not the old pace');
});

test('a nightly batch job that jumps every night is a pattern, not a shift', () => {
  const r = rng(9);
  const job = (at: number) => { const h = (at % DAY) / HOUR; return h >= 2 && h < 4 ? 85 : 20; };
  const cpu = series(7, (at) => job(at) + 3 * r());
  const { t, y } = resample(cpu, HOUR, NOW);
  assert.equal(lastShift(t, y), null);
  const p = predict(cpu, { value: 100, when: 'above' }, { now: NOW, minRise: 10 })!;
  assert.equal(p.etaMs, null);
  assert.equal(p.historyHours >= 160, true, 'the whole week is used');
});

test('noise and slow random walks are not a trend', () => {
  const r = rng(21);
  let v = 60;
  const walk = series(7, () => (v += 0.15 * r()));
  const p = predict(walk, { value: 100, when: 'above' }, { now: NOW, minRise: 5 })!;
  assert.equal(p.etaMs, null);
});

test('one huge spike in the history does not change the forecast', () => {
  const r = rng(4);
  const base = (at: number) => 60e9 - 10e9 * ((at - NOW) / DAY) + 0.3e9 * r();
  const clean = predict(series(7, base), { value: 0, when: 'below' }, { now: NOW })!;
  const spiky = predict(series(7, (at, i) => (i === 900 ? 400e9 : base(at))), { value: 0, when: 'below' }, { now: NOW })!;
  assert.ok(Math.abs(spiky.etaMs! - clean.etaMs!) < 0.1 * clean.etaMs!, 'robust to the outlier');
});

test('too little history is no forecast, not a guess', () => {
  assert.equal(predict(series(0.3, () => 50), { value: 100, when: 'above' }, { now: NOW }), null);
});

test('the forecast band widens with time and contains the expected path', () => {
  const r = rng(13);
  const p = predict(series(7, (at) => 60e9 - 10e9 * ((at - NOW) / DAY) + 0.5e9 * r()), { value: 0, when: 'below' }, { now: NOW })!;
  const first = p.path[0]!, last = p.path[p.path.length - 1]!;
  assert.ok(first[2] <= first[1] && first[1] <= first[3]);
  assert.ok(last[3] - last[2] > first[3] - first[2], 'wider further out');
});

test('a weekday/weekend rhythm is learned when there are two weeks of history', () => {
  const r = rng(17);
  // Busy on weekdays (and in the afternoon), quiet at weekends; flat overall.
  const week = (at: number) => { const dow = new Date(at).getUTCDay(); return dow === 0 || dow === 6 ? -15 : 5; };
  const cpu = series(21, (at) => 45 + week(at) + 10 * daily(at) + 2 * r());
  const p = predict(cpu, { value: 100, when: 'above' }, { now: NOW, minRise: 10 })!;
  assert.ok(p.model === 'weekly' || p.model === 'daily', p.model);
  assert.equal(p.etaMs, null);
});

test('a steady leak with no pattern is found, with a date', () => {
  const r = rng(29);
  // A process leaking 3 points a day, 82% now: 100% in 6 days.
  const mem = series(8, (at) => 82 + 3 * ((at - NOW) / DAY) + 0.4 * r());
  const p = predict(mem, { value: 100, when: 'above' }, { now: NOW, minRise: 5 })!;
  assert.ok(Math.abs(p.etaMs! / DAY - 6) < 0.4, `eta ${(p.etaMs! / DAY).toFixed(2)} days`);
  assert.equal(p.confidence, 'high');
});

test('fast enough to run for a hundred series every hour', () => {
  const r = rng(31);
  // What the watcher reads: hourly means over 15 days.
  const s = resample(series(15, (at) => 50 + 15 * daily(at) + 2 * ((at - NOW) / DAY) + 3 * r()), HOUR, NOW);
  const hourly = s.t.map((at, i) => ({ at, value: s.y[i]! }));
  predict(hourly, { value: 100, when: 'above' }, { now: NOW });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) predict(hourly, { value: 100, when: 'above' }, { now: NOW });
  const each = (performance.now() - t0) / 20;
  // A hundred series in well under a minute, even on a slow, busy CI machine.
  assert.ok(each < 250, `${each.toFixed(1)} ms per series`);
});
