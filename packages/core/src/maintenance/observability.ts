import { and, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '@supops/db';
import { alerts, incidents, metricPoints, observations } from '@supops/db';

/**
 * Observability clean-up, always on (15 days by default). Metric rollups are written
 * every few minutes and would otherwise grow forever; resolved alerts, incidents
 * (with their evidence) and observations are history, kept long enough to compare
 * with and then dropped. Anything still open is never removed, whatever its age.
 */

const DAY = 86_400_000;

export interface ObservabilityCleanup {
  points: number;
  observations: number;
  incidents: number;
  alerts: number;
}

export function cleanupObservability(db: Db, opts: { days: number; now?: number }): ObservabilityCleanup {
  const cutoff = (opts.now ?? Date.now()) - Math.max(1, opts.days) * DAY;
  const at = new Date(cutoff);

  const points = db.delete(metricPoints).where(lt(metricPoints.at, cutoff)).run().changes;
  const obs = db
    .delete(observations)
    .where(and(isNotNull(observations.resolvedAt), lt(observations.resolvedAt, at)))
    .run().changes;
  // Closed alerts: resolved by their source, or ignored by a person.
  const closedAlerts = db
    .delete(alerts)
    .where(and(inArray(alerts.status, ['resolved', 'ignored']), lt(sql`coalesce(${alerts.resolvedAt}, ${alerts.decidedAt}, ${alerts.lastSeenAt})`, cutoff)))
    .run().changes;
  // Evidence cascades with its incident; an alert still pointing at one is set free.
  const inc = db
    .delete(incidents)
    .where(and(inArray(incidents.status, ['resolved']), isNotNull(incidents.resolvedAt), lt(incidents.resolvedAt, at)))
    .run().changes;

  return { points, observations: obs, incidents: inc, alerts: closedAlerts };
}

/** How much a clean-up with this age would remove, without removing it. */
export function previewObservabilityCleanup(db: Db, opts: { days: number; now?: number }): ObservabilityCleanup {
  const cutoff = (opts.now ?? Date.now()) - Math.max(1, opts.days) * DAY;
  const at = new Date(cutoff);
  const n = (q: { get: () => unknown }) => Number((q.get() as { n: number } | undefined)?.n ?? 0);
  return {
    points: n(db.select({ n: sql<number>`count(*)` }).from(metricPoints).where(lt(metricPoints.at, cutoff))),
    observations: n(db.select({ n: sql<number>`count(*)` }).from(observations).where(and(isNotNull(observations.resolvedAt), lt(observations.resolvedAt, at)))),
    incidents: n(db.select({ n: sql<number>`count(*)` }).from(incidents).where(and(inArray(incidents.status, ['resolved']), isNotNull(incidents.resolvedAt), lt(incidents.resolvedAt, at)))),
    alerts: n(
      db
        .select({ n: sql<number>`count(*)` })
        .from(alerts)
        .where(and(inArray(alerts.status, ['resolved', 'ignored']), lt(sql`coalesce(${alerts.resolvedAt}, ${alerts.decidedAt}, ${alerts.lastSeenAt})`, cutoff))),
    ),
  };
}
