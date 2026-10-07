import { and, eq, inArray } from 'drizzle-orm';
import { alerts, incidents } from '@supops/db';
import type { AlertSeverity, AlertSource } from '@supops/shared';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { db } from '../context.ts';
import { attachToIncident, refreshIncident, reopenIncident, worse } from './incidents.ts';
import { enqueueTriage } from './triage.ts';

/**
 * Every alert enters SupOps here, whatever brought it: a Slack message, a poll of an
 * Alertmanager/Prometheus/Grafana connection, or a forecast. One place decides what
 * is new, what is a repeat, what resolved, and which incident it belongs to.
 */
export interface IncomingAlert {
  projectId: string;
  source: AlertSource;
  fingerprint: string;
  title: string;
  severity: AlertSeverity;
  summary: string | null;
  labels: Record<string, string>;
  status: 'firing' | 'resolved';
  startsAt?: number | null;
  rawPayload?: unknown;
  /** Set for alerts read from a connection. */
  connectionId?: string | null;
  slack?: { channelId: string; channelName: string; ts?: string | null; permalink?: string | null };
  /** A repeat notification (Slack) bumps the count; a poll that still sees it does not. */
  notification: boolean;
}

type AlertRow = typeof alerts.$inferSelect;

/** Same alert seen through two routes (Slack and a connection): its name and host. */
const identity = (title: string, labels: Record<string, string>) =>
  `${(labels.alertname || title).toLowerCase()}|${(labels.instance || labels.host || labels.hostname || labels.node || '').toLowerCase().replace(/:\d+$/, '')}`;

/** Is this alert's incident ignored right now (and not yet due to be checked again)? */
function underIgnore(row: AlertRow): boolean {
  if (!row.incidentId) return false;
  const inc = db.select({ status: incidents.status, until: incidents.ignoredUntil }).from(incidents).where(eq(incidents.id, row.incidentId)).get();
  return inc?.status === 'ignored' && (!inc.until || inc.until.getTime() > Date.now());
}

function findExisting(a: IncomingAlert): AlertRow | undefined {
  const exact = db
    .select()
    .from(alerts)
    .where(and(eq(alerts.projectId, a.projectId), eq(alerts.fingerprint, a.fingerprint), inArray(alerts.status, [...OPEN_ALERT_STATUSES, 'ignored'])))
    .get();
  // An ignored alert stays the same alert while its connection still reports it, or
  // while its incident's ignore lasts; after that a repeat is news again.
  if (exact && (exact.status !== 'ignored' || a.connectionId || underIgnore(exact))) return exact;
  // The other route's copy: an open alert from a different source with the same name and host.
  const id = identity(a.title, a.labels);
  if (id.endsWith('|')) return undefined;
  return db
    .select()
    .from(alerts)
    .where(and(eq(alerts.projectId, a.projectId), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .all()
    .find((r) => (a.slack ? !!r.connectionId : r.source === 'slack' && !r.connectionId) && identity(r.title, r.labels ?? {}) === id);
}

export function ingestAlert(a: IncomingAlert): { alertId: string | null; created: boolean; resolved: boolean } {
  const existing = findExisting(a);
  const now = new Date();

  if (a.status === 'resolved') {
    if (!existing) return { alertId: null, created: false, resolved: false };
    // A connection is the better witness: Slack's "resolved" does not close an alert
    // the connection still reports, the next poll decides.
    if (a.slack && existing.connectionId) return { alertId: existing.id, created: false, resolved: false };
    db.update(alerts).set({ status: 'resolved', resolvedAt: now, lastSeenAt: now }).where(eq(alerts.id, existing.id)).run();
    refreshIncident(existing.incidentId);
    return { alertId: existing.id, created: false, resolved: true };
  }

  if (existing) {
    // Worse than when it was ignored: an ignore never hides an escalation.
    if (existing.status === 'ignored' && existing.incidentId && underIgnore(existing) && worse(a.severity, existing.severity)) {
      reopenIncident(existing.incidentId);
      enqueueTriage(existing.incidentId);
    }
    db.update(alerts)
      .set({
        count: a.notification ? existing.count + 1 : existing.count,
        lastSeenAt: now,
        severity: a.severity,
        summary: a.summary ?? existing.summary,
        // Keep the richer label set: a connection's labels are complete, Slack's parsed.
        labels: a.connectionId || !existing.connectionId ? { ...(existing.labels ?? {}), ...a.labels } : existing.labels,
        ...(a.connectionId && !existing.connectionId ? { connectionId: a.connectionId, startsAt: a.startsAt ? new Date(a.startsAt) : existing.startsAt } : {}),
        ...(a.slack && !existing.slackPermalink ? { channelId: a.slack.channelId, channelName: a.slack.channelName, slackTs: a.slack.ts ?? null, slackPermalink: a.slack.permalink ?? null } : {}),
        ...(a.rawPayload !== undefined && a.notification ? { rawPayload: a.rawPayload } : {}),
      })
      .where(eq(alerts.id, existing.id))
      .run();
    return { alertId: existing.id, created: false, resolved: false };
  }

  const row = db
    .insert(alerts)
    .values({
      projectId: a.projectId,
      source: a.source,
      connectionId: a.connectionId ?? null,
      channelId: a.slack?.channelId ?? null,
      channelName: a.slack?.channelName ?? null,
      fingerprint: a.fingerprint,
      title: a.title,
      severity: a.severity,
      status: 'new',
      summary: a.summary,
      labels: a.labels,
      rawPayload: a.rawPayload ?? null,
      slackTs: a.slack?.ts ?? null,
      slackPermalink: a.slack?.permalink ?? null,
      startsAt: a.startsAt ? new Date(a.startsAt) : null,
      receivedAt: now,
      lastSeenAt: now,
    })
    .returning()
    .get();
  const { incident, created } = attachToIncident(row);
  if (created) enqueueTriage(incident.id);
  return { alertId: row.id, created: true, resolved: false };
}
