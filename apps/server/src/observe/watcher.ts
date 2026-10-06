import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { incidents, metricPoints, observations, projects, watches } from '@supops/db';
import type { ResolvedTarget } from '@supops/core';
import {
  detectAnomaly,
  discoverSignals,
  forecastLimit,
  formatEta,
  formatValue,
  loadTargets,
  matchTargetsByHost,
  promRange,
  seriesName,
  SIGNALS,
} from '@supops/core';
import type { Point } from '@supops/core';
import { db, settingsStore } from '../context.ts';
import { obsConfig, projectConnections, watchesMetrics } from './connections.ts';
import { enqueueTriage } from './triage.ts';

/**
 * The watcher: every few minutes it samples the signals watched on each metrics
 * connection, keeps a 5-minute rollup in SQLite, and asks two questions of every
 * series -- is it behaving unlike itself (anomaly), and when will it run out
 * (forecast). What it finds stays open as an observation while it holds and resolves
 * on its own. A forecast that something runs out soon opens an incident, before any
 * alert would have fired.
 */

const STEP_SEC = 300;
const DAY = 86_400_000;
const HOUR = 3_600_000;
type WatchRow = typeof watches.$inferSelect;

/** Last time built-in signals were discovered per connection. */
const discoveredAt = new Map<string, number>();

/** Create the built-in watches this connection can serve (existing ones are left alone). */
export async function discover(projectId: string, conn: ResolvedTarget): Promise<number> {
  const found = await discoverSignals(conn, AbortSignal.timeout(60_000));
  discoveredAt.set(conn.id, Date.now());
  let added = 0;
  for (const s of found) {
    const r = db
      .insert(watches)
      .values({
        projectId,
        connectionId: conn.id,
        key: s.key,
        title: s.title,
        query: s.query,
        unit: s.unit,
        builtin: true,
        badDirection: s.badDirection,
        limit: s.limit,
        group: s.group,
      })
      .onConflictDoNothing()
      .run();
    added += r.changes;
  }
  return added;
}

function seriesHistory(watchId: string, series: string, since: number): Point[] {
  return db
    .select({ at: metricPoints.at, value: metricPoints.value })
    .from(metricPoints)
    .where(and(eq(metricPoints.watchId, watchId), eq(metricPoints.series, series), gt(metricPoints.at, since)))
    .orderBy(asc(metricPoints.at))
    .all();
}

function openObservation(watchId: string, series: string, kind: 'anomaly' | 'forecast') {
  return db
    .select()
    .from(observations)
    .where(and(eq(observations.watchId, watchId), eq(observations.series, series), eq(observations.kind, kind), isNull(observations.resolvedAt)))
    .get();
}

function resolveObservation(o: typeof observations.$inferSelect | undefined): void {
  if (!o) return;
  db.update(observations).set({ resolvedAt: new Date() }).where(eq(observations.id, o.id)).run();
  if (o.incidentId) {
    // A predicted problem that is no longer predicted is over.
    db.update(incidents)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(and(eq(incidents.id, o.incidentId), eq(incidents.origin, 'prediction'), eq(incidents.status, 'open')))
      .run();
  }
}

/** Sample one watch, store the points, and update its observations. */
export async function sampleWatch(w: WatchRow, conn: ResolvedTarget, now = Date.now()): Promise<void> {
  const cfg = settingsStore.observability();
  const end = Math.floor(now / (STEP_SEC * 1000)) * STEP_SEC * 1000;
  // First sample backfills up to a week, so baselines and forecasts work at once.
  const backfill = Math.min(7 * DAY, (obsConfig(conn).maxRangeHours ?? 168) * HOUR);
  const start = w.lastRunAt ? Math.max(w.lastRunAt.getTime() - 15 * 60_000, end - 6 * HOUR) : end - backfill;

  const r = await promRange(conn, w.query, start, end, STEP_SEC, { signal: AbortSignal.timeout(45_000), maxSeries: 50 });
  if ('error' in r) {
    db.update(watches).set({ lastRunAt: new Date(now), lastError: r.error.slice(0, 500) }).where(eq(watches.id, w.id)).run();
    return;
  }
  db.transaction((tx) => {
    for (const s of r.series) {
      for (const p of s.points) {
        tx.insert(metricPoints)
          .values({ watchId: w.id, series: s.key, at: p.at, value: p.value })
          .onConflictDoUpdate({ target: [metricPoints.watchId, metricPoints.series, metricPoints.at], set: { value: p.value } })
          .run();
      }
    }
    tx.update(watches)
      .set({ lastRunAt: new Date(now), lastError: r.dropped ? `${r.dropped} more series were not kept (50 per signal)` : null, seriesCount: r.series.length })
      .where(eq(watches.id, w.id))
      .run();
  });

  const available = loadTargets(db, w.projectId);
  const signal = SIGNALS.find((s) => s.key === w.key);
  for (const s of r.series) {
    const history = seriesHistory(w.id, s.key, end - 3 * DAY);
    const name = seriesName(s.labels);
    const host = s.labels.instance || s.labels.node || s.labels.host;
    const targetId = host ? (matchTargetsByHost(available, host)[0]?.id ?? null) : null;
    const fmt = (v: number) => formatValue(v, w.unit);

    // ---- anomaly
    const a = detectAnomaly(history, { badDirection: w.badDirection, minDelta: signal?.minDelta, now: end });
    const openA = openObservation(w.id, s.key, 'anomaly');
    if (a?.anomalous) {
      const message = `${w.title} on ${name}: ${fmt(a.value)}, usually about ${fmt(a.baseline)} ${a.method === 'seasonal' ? 'at this time of day' : 'over the last few hours'}`;
      if (openA) {
        db.update(observations).set({ lastSeenAt: new Date(now), message, value: a.value, details: { z: a.z, baseline: a.baseline, direction: a.direction, method: a.method } }).where(eq(observations.id, openA.id)).run();
      } else {
        db.insert(observations)
          .values({ projectId: w.projectId, watchId: w.id, series: s.key, labels: s.labels, targetId, kind: 'anomaly', severity: 'warning', message, value: a.value, details: { z: a.z, baseline: a.baseline, direction: a.direction, method: a.method } })
          .run();
      }
    } else {
      resolveObservation(openA);
    }

    // ---- forecast
    if (!w.limit) continue;
    const openF = openObservation(w.id, s.key, 'forecast');
    const f = forecastLimit(history.filter((p) => p.at >= end - DAY), w.limit, end);
    const horizon = (h: number) => h * HOUR;
    const deterministic = w.key === 'cert_days';
    const usable = f && f.etaMs !== null && (f.confidence !== 'low' || deterministic || f.etaMs === 0);
    if (!f || f.etaMs === null || f.etaMs > 7 * DAY) {
      resolveObservation(openF);
      continue;
    }
    const severity: 'critical' | 'warning' | 'info' = !usable
      ? 'info'
      : f.etaMs <= horizon(cfg.predictCriticalHours)
        ? 'critical'
        : f.etaMs <= horizon(cfg.predictWarningHours)
          ? 'warning'
          : 'info';
    const message = deterministic
      ? `Certificate for ${name} expires in ${formatEta(f.etaMs)}`
      : f.etaMs === 0
        ? `${w.title} on ${name} has reached its limit (${fmt(f.current)})`
        : `${w.title} on ${name} runs out in about ${formatEta(f.etaMs)} (now ${fmt(f.current)}, ${f.slopePerHour >= 0 ? '+' : ''}${fmt(f.slopePerHour)}/h)`;
    const details = { etaMs: f.etaMs, limit: w.limit, slopePerHour: f.slopePerHour, confidence: deterministic ? 'high' : f.confidence, windowHours: f.windowHours, r2: f.r2 };
    let obs = openF;
    if (obs) {
      db.update(observations).set({ lastSeenAt: new Date(now), message, severity, value: f.current, details }).where(eq(observations.id, obs.id)).run();
    } else {
      obs = db
        .insert(observations)
        .values({ projectId: w.projectId, watchId: w.id, series: s.key, labels: s.labels, targetId, kind: 'forecast', severity, message, value: f.current, details })
        .returning()
        .get();
    }
    // Soon enough, and sure enough: open an incident before anything fails -- or, when
    // an incident is already open about this machine, add the forecast to it.
    if (severity !== 'info' && !obs.incidentId && targetId) {
      const existing = db
        .select({ id: incidents.id, targetIds: incidents.targetIds })
        .from(incidents)
        .where(and(eq(incidents.projectId, w.projectId), eq(incidents.status, 'open'), isNull(incidents.mergedInto)))
        .all()
        .find((i) => (i.targetIds ?? []).includes(targetId));
      if (existing) {
        db.update(observations).set({ incidentId: existing.id }).where(eq(observations.id, obs.id)).run();
        obs = { ...obs, incidentId: existing.id };
      }
    }
    if (severity !== 'info' && !obs.incidentId) {
      const inc = db
        .insert(incidents)
        .values({
          projectId: w.projectId,
          title: message.slice(0, 200),
          severity: severity === 'critical' ? 'critical' : 'warning',
          origin: 'prediction',
          groupKey: { signal: w.key, series: name },
          groupReason: 'raised by a forecast from the metric history',
          targetIds: targetId ? [targetId] : [],
        })
        .returning()
        .get();
      db.update(observations).set({ incidentId: inc.id }).where(eq(observations.id, obs.id)).run();
      enqueueTriage(inc.id);
    } else if (obs.incidentId) {
      db.update(incidents)
        .set({ title: message.slice(0, 200), lastSeenAt: new Date(now), ...(severity === 'critical' ? { severity: 'critical' as const } : {}) })
        .where(and(eq(incidents.id, obs.incidentId), eq(incidents.status, 'open'), eq(incidents.origin, 'prediction')))
        .run();
    }
  }

  // Series the query no longer returns: whatever was open about them is over.
  const keys = new Set(r.series.map((s) => s.key));
  for (const o of db.select().from(observations).where(and(eq(observations.watchId, w.id), isNull(observations.resolvedAt))).all()) {
    if (!keys.has(o.series)) resolveObservation(o);
  }
}

export async function watchConnection(projectId: string, conn: ResolvedTarget): Promise<void> {
  if (Date.now() - (discoveredAt.get(conn.id) ?? 0) > DAY) await discover(projectId, conn);
  const list = db.select().from(watches).where(and(eq(watches.connectionId, conn.id), eq(watches.enabled, true))).all();
  for (const w of list) {
    try {
      await sampleWatch(w, conn);
    } catch (err) {
      db.update(watches).set({ lastRunAt: new Date(), lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500) }).where(eq(watches.id, w.id)).run();
    }
  }
}

export class Watcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private nextAt = 0;

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
    setTimeout(() => void this.tick(), 20_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run a pass now (e.g. after a connection was added). */
  kick(): void {
    this.nextAt = 0;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.busy || Date.now() < this.nextAt) return;
    this.busy = true;
    this.nextAt = Date.now() + settingsStore.observability().watchIntervalMs;
    try {
      for (const p of db.select({ id: projects.id }).from(projects).all()) {
        const watched = projectConnections(p.id).filter(watchesMetrics);
        for (const conn of watched) {
          try {
            await watchConnection(p.id, conn);
          } catch (err) {
            console.error(`watching ${conn.slug} failed:`, err);
          }
        }
        // A connection no longer watched (switched off, disabled, removed) stops claiming anything.
        const ids = new Set(watched.map((c) => c.id));
        const stale = db
          .select({ o: observations, connectionId: watches.connectionId })
          .from(observations)
          .innerJoin(watches, eq(watches.id, observations.watchId))
          .where(and(eq(observations.projectId, p.id), isNull(observations.resolvedAt)))
          .all()
          .filter((r) => !ids.has(r.connectionId));
        for (const r of stale) resolveObservation(r.o);
      }
    } finally {
      this.busy = false;
    }
  }
}

export const watcher = new Watcher();

/** Points for a chart: at most `max` per series, by averaging buckets. */
export function chartSeries(watchId: string, hours: number, max = 240): Array<{ series: string; points: Array<[number, number]> }> {
  const since = Date.now() - hours * HOUR;
  const rows = db
    .select({ series: metricPoints.series, at: metricPoints.at, value: metricPoints.value })
    .from(metricPoints)
    .where(and(eq(metricPoints.watchId, watchId), gt(metricPoints.at, since)))
    .orderBy(asc(metricPoints.series), asc(metricPoints.at))
    .all();
  const by = new Map<string, Array<[number, number]>>();
  for (const r of rows) {
    const arr = by.get(r.series) ?? [];
    arr.push([r.at, r.value]);
    by.set(r.series, arr);
  }
  return [...by.entries()].map(([series, pts]) => {
    if (pts.length <= max) return { series, points: pts };
    const size = Math.ceil(pts.length / max);
    const out: Array<[number, number]> = [];
    for (let i = 0; i < pts.length; i += size) {
      const b = pts.slice(i, i + size);
      out.push([b[b.length - 1]![0], b.reduce((s, p) => s + p[1], 0) / b.length]);
    }
    return { series, points: out };
  });
}

/** Rows kept per watch, for the settings page. */
export const pointCount = () => db.select({ n: sql<number>`count(*)` }).from(metricPoints).get()?.n ?? 0;
