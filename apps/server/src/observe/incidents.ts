import { and, eq, inArray, isNull } from 'drizzle-orm';
import { alerts, incidents } from '@supops/db';
import type { AlertSeverity } from '@supops/shared';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { chooseIncident, groupKeyOf, loadTargets, scopeAlert, worstSeverity } from '@supops/core';
import { db } from '../context.ts';

type AlertRow = typeof alerts.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;

const hostOf = (l: Record<string, string>) => l.instance || l.host || l.hostname || l.node || '';

/**
 * Targets an alert is about: by its host labels, then names in its text, then its
 * channel (see scopeAlert) -- the machines it names, not the jumps added for reach.
 */
export function alertTargets(projectId: string, a: Pick<AlertRow, 'labels' | 'title' | 'summary' | 'channelName'>): string[] {
  return scopeAlert({ labels: a.labels ?? {}, title: a.title, summary: a.summary, channelName: a.channelName }, loadTargets(db, projectId)).matched.map((t) => t.id);
}

/** A title for an incident from its alerts: "HighCPU on 3 machines", "DiskFull and 2 more on db-1". */
export function incidentTitle(rows: Array<Pick<AlertRow, 'title' | 'labels'>>): string {
  if (!rows.length) return 'Incident';
  const names = [...new Set(rows.map((r) => r.title))];
  const hosts = [...new Set(rows.map((r) => hostOf(r.labels ?? {}).replace(/:\d+$/, '')).filter(Boolean))];
  const what = names.length === 1 ? names[0]! : `${names[0]} and ${names.length - 1} more`;
  const where = hosts.length === 1 ? ` on ${hosts[0]}` : hosts.length > 1 ? ` on ${hosts.length} machines` : '';
  return `${what}${where}`.slice(0, 200);
}

/**
 * Put a new open alert into an incident: an open one it belongs with (see
 * chooseIncident), or a new one. Returns the incident and whether it was created.
 */
export function attachToIncident(alert: AlertRow): { incident: IncidentRow; created: boolean } {
  const labels = alert.labels ?? {};
  const targetIds = alertTargets(alert.projectId, alert);
  const open = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, alert.projectId), eq(incidents.status, 'open'), isNull(incidents.mergedInto)))
    .all();
  const now = alert.receivedAt.getTime();
  const pick = chooseIncident(
    { title: alert.title, labels, targetIds, at: now },
    open.map((i) => ({ id: i.id, title: i.title, groupKey: i.groupKey ?? {}, targetIds: i.targetIds ?? [], lastSeenAt: i.lastSeenAt.getTime() })),
  );

  if (pick) {
    const inc = open.find((i) => i.id === pick.incidentId)!;
    db.update(alerts).set({ incidentId: inc.id }).where(eq(alerts.id, alert.id)).run();
    const members = db.select({ title: alerts.title, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, inc.id)).all();
    const updated = db
      .update(incidents)
      .set({
        lastSeenAt: new Date(),
        // A forecast that is now also an alert: it resolves with its alerts from here on.
        origin: 'alerts',
        severity: worstSeverity(inc.severity, alert.severity) as AlertSeverity,
        targetIds: [...new Set([...(inc.targetIds ?? []), ...targetIds])],
        title: inc.origin === 'prediction' ? inc.title : incidentTitle(members),
        groupReason: inc.groupReason ? (inc.groupReason.includes(pick.reason) ? inc.groupReason : `${inc.groupReason}; ${pick.reason}`).slice(0, 1000) : pick.reason,
      })
      .where(eq(incidents.id, inc.id))
      .returning()
      .get();
    return { incident: updated, created: false };
  }

  const created = db
    .insert(incidents)
    .values({
      projectId: alert.projectId,
      title: incidentTitle([alert]),
      severity: alert.severity,
      groupKey: groupKeyOf({ title: alert.title, labels }),
      targetIds,
      openedAt: alert.receivedAt,
      lastSeenAt: new Date(),
    })
    .returning()
    .get();
  db.update(alerts).set({ incidentId: created.id }).where(eq(alerts.id, alert.id)).run();
  return { incident: created, created: true };
}

/** Resolve an alert-made incident once none of its alerts is still open. */
export function refreshIncident(incidentId: string | null): void {
  if (!incidentId) return;
  const inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc || inc.origin !== 'alerts') return;
  const stillOpen = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.incidentId, incidentId), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .get();
  if (!stillOpen && inc.status === 'open') {
    db.update(incidents).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(incidents.id, incidentId)).run();
  } else if (stillOpen && inc.status === 'resolved') {
    db.update(incidents).set({ status: 'open', resolvedAt: null }).where(eq(incidents.id, incidentId)).run();
  }
}

/** Move every alert of `fromId` into `intoId` and close `fromId` as merged. */
export function mergeIncidents(fromId: string, intoId: string): IncidentRow | null {
  if (fromId === intoId) return null;
  const from = db.select().from(incidents).where(eq(incidents.id, fromId)).get();
  const into = db.select().from(incidents).where(eq(incidents.id, intoId)).get();
  if (!from || !into || from.projectId !== into.projectId) return null;
  return db.transaction((tx) => {
    tx.update(alerts).set({ incidentId: intoId }).where(eq(alerts.incidentId, fromId)).run();
    tx.update(incidents)
      .set({ status: 'resolved', resolvedAt: new Date(), mergedInto: intoId })
      .where(eq(incidents.id, fromId))
      .run();
    const members = tx.select({ title: alerts.title, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, intoId)).all();
    return tx
      .update(incidents)
      .set({
        title: incidentTitle(members),
        severity: worstSeverity(into.severity, from.severity) as AlertSeverity,
        targetIds: [...new Set([...(into.targetIds ?? []), ...(from.targetIds ?? [])])],
        status: 'open',
        resolvedAt: null,
        groupReason: [into.groupReason, 'merged by a person'].filter(Boolean).join('; '),
        lastSeenAt: new Date(),
      })
      .where(eq(incidents.id, intoId))
      .returning()
      .get();
  });
}

/** Move some alerts out of an incident into a new one of their own. */
export function splitIncident(incidentId: string, alertIds: string[]): IncidentRow | null {
  const inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc || !alertIds.length) return null;
  const moving = db.select().from(alerts).where(and(eq(alerts.incidentId, incidentId), inArray(alerts.id, alertIds))).all();
  const staying = db.select({ id: alerts.id }).from(alerts).where(eq(alerts.incidentId, incidentId)).all().length - moving.length;
  if (!moving.length || staying <= 0) return null;
  const created = db.transaction((tx) => {
    const n = tx
      .insert(incidents)
      .values({
        projectId: inc.projectId,
        title: incidentTitle(moving),
        severity: moving.reduce<AlertSeverity>((s, a) => worstSeverity(s, a.severity), 'unknown'),
        groupKey: groupKeyOf({ title: moving[0]!.title, labels: moving[0]!.labels ?? {} }),
        groupReason: 'split out by a person',
        targetIds: [...new Set(moving.flatMap((a) => alertTargets(inc.projectId, a)))],
      })
      .returning()
      .get();
    tx.update(alerts).set({ incidentId: n.id }).where(inArray(alerts.id, moving.map((a) => a.id))).run();
    const rest = tx.select({ title: alerts.title, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, incidentId)).all();
    tx.update(incidents).set({ title: incidentTitle(rest) }).where(eq(incidents.id, incidentId)).run();
    return n;
  });
  refreshIncident(created.id);
  refreshIncident(incidentId);
  return created;
}
