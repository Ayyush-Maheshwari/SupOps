import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { observations, watches } from '@supops/db';
import { db } from '../context.ts';

/**
 * What the watcher sees right now about a run's targets: open anomalies and
 * forecasts, in a few lines for the opening message. Observations about a machine
 * in scope, and about anything measured by a connection in scope.
 */
export function observationContext(projectId: string, targetIds: string[]): string | null {
  if (!targetIds.length) return null;
  const rows = db
    .select({ message: observations.message, kind: observations.kind, severity: observations.severity })
    .from(observations)
    .innerJoin(watches, eq(watches.id, observations.watchId))
    .where(
      and(
        eq(observations.projectId, projectId),
        isNull(observations.resolvedAt),
        or(inArray(observations.targetId, targetIds), and(isNull(observations.targetId), inArray(watches.connectionId, targetIds))),
      ),
    )
    .orderBy(desc(observations.severity), desc(observations.lastSeenAt))
    .limit(12)
    .all();
  if (!rows.length) return null;
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  rows.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return [
    "SupOps' metric watcher currently sees (computed from Prometheus history, not verified by you yet):",
    ...rows.map((r) => `- ${r.kind === 'forecast' ? 'Forecast' : 'Unusual'} (${r.severity}): ${r.message}`),
  ].join('\n');
}
