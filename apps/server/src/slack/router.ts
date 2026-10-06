import { and, eq } from 'drizzle-orm';
import { alertSubscriptions } from '@supops/db';
import { db } from '../context.ts';
import { ingestAlert } from '../observe/ingest.ts';
import { parseAlertmanagerMessages, type SlackMessage } from './parse.ts';

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
 * Fan one Slack message out to every project subscribed to its channel. A grouped
 * notification (`[FIRING:3]`) becomes one alert per instance. Dedup, resolves and
 * incident grouping happen in ingestAlert, shared with alerts read from connections.
 */
export function ingestSlackAlert(input: IncomingSlackAlert): { affected: number } {
  const subs = db
    .select()
    .from(alertSubscriptions)
    .where(and(eq(alertSubscriptions.channelId, input.channelId), eq(alertSubscriptions.enabled, true)))
    .all();
  if (subs.length === 0) return { affected: 0 };

  const parsed = parseAlertmanagerMessages(input.message, input.channelId);
  let affected = 0;
  for (const sub of subs) {
    for (const p of parsed) {
      const r = ingestAlert({
        projectId: sub.projectId,
        source: 'slack',
        fingerprint: p.fingerprint,
        title: p.title,
        severity: p.severity,
        summary: p.summary,
        labels: p.labels,
        status: p.status,
        rawPayload: input.rawPayload,
        slack: { channelId: input.channelId, channelName: input.channelName, ts: input.slackTs ?? null, permalink: input.permalink ?? null },
        notification: true,
      });
      if (r.alertId) affected++;
    }
  }
  return { affected };
}
