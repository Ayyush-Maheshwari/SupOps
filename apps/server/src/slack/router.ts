import { and, eq, inArray } from 'drizzle-orm';
import { alertSubscriptions, alerts } from '@supops/db';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { db } from '../context.ts';
import { parseAlertmanagerMessage, type SlackMessage } from './parse.ts';

export interface IncomingSlackAlert {
  channelId: string;
  channelName: string;
  slackTs?: string;
  permalink?: string | null;
  message: SlackMessage;
  /** The full Slack event, stored verbatim for later re-parsing. */
  rawPayload: unknown;
}

/**
 * Fan one Slack message out to every project subscribed to its channel, creating or
 * updating one alert row per project.
 *
 * Dedup is per `(projectId, fingerprint)` while the alert is still open: a repeat
 * firing bumps `count` rather than piling up rows, and a resolved notification flips
 * the matching open row closed instead of creating a phantom. A resolve with no open
 * row to match is dropped -- there is nothing to resolve.
 */
export function ingestSlackAlert(input: IncomingSlackAlert): { affected: number } {
  const subs = db
    .select()
    .from(alertSubscriptions)
    .where(and(eq(alertSubscriptions.channelId, input.channelId), eq(alertSubscriptions.enabled, true)))
    .all();
  if (subs.length === 0) return { affected: 0 };

  const parsed = parseAlertmanagerMessage(input.message, input.channelId);
  const now = new Date();
  let affected = 0;

  for (const sub of subs) {
    const existing = db
      .select()
      .from(alerts)
      .where(
        and(
          eq(alerts.projectId, sub.projectId),
          eq(alerts.fingerprint, parsed.fingerprint),
          inArray(alerts.status, [...OPEN_ALERT_STATUSES]),
        ),
      )
      .get();

    if (parsed.status === 'resolved') {
      // Auto-clear: a resolved alert leaves SupOps entirely, so the Alerts view is a
      // live queue of things still wrong -- not a graveyard of closed ones. The
      // investigation run (if one was started) keeps the record under Runs.
      if (existing) {
        db.delete(alerts).where(eq(alerts.id, existing.id)).run();
        affected++;
      }
      continue;
    }

    if (existing) {
      db.update(alerts)
        .set({
          count: existing.count + 1,
          lastSeenAt: now,
          severity: parsed.severity,
          title: parsed.title,
          summary: parsed.summary,
          labels: parsed.labels,
          rawPayload: input.rawPayload,
        })
        .where(eq(alerts.id, existing.id))
        .run();
      affected++;
      continue;
    }

    db.insert(alerts)
      .values({
        projectId: sub.projectId,
        source: 'slack',
        channelId: input.channelId,
        channelName: input.channelName,
        fingerprint: parsed.fingerprint,
        title: parsed.title,
        severity: parsed.severity,
        status: 'new',
        summary: parsed.summary,
        labels: parsed.labels,
        rawPayload: input.rawPayload,
        slackTs: input.slackTs ?? null,
        slackPermalink: input.permalink ?? null,
        receivedAt: now,
        lastSeenAt: now,
      })
      .run();
    affected++;
  }

  return { affected };
}
