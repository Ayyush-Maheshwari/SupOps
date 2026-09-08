import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AlertSeverity, AlertSource, AlertStatus } from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { runs } from './runs.ts';

/**
 * One alert, as SupOps saw it. Today every row is sourced from a Slack message an
 * Alertmanager instance posted, but `source` leaves room for reading Prometheus or
 * Grafana directly later without a schema change.
 *
 * Dedup is by `(projectId, fingerprint)` while the alert is still open: a flapping
 * alert bumps `count`/`lastSeenAt` on the existing row instead of spawning a new
 * one, and a `resolved` notification flips the matching open row to `resolved`.
 */
export const alerts = sqliteTable(
  'alerts',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source').$type<AlertSource>().notNull().default('slack'),

    /** The Slack channel the alert arrived in -- shown as the category/segregation. */
    channelId: text('channel_id'),
    channelName: text('channel_name'),

    /** sha256(alertname + instance + channel). Collapses repeats, links resolves. */
    fingerprint: text('fingerprint').notNull(),

    title: text('title').notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull().default('unknown'),
    status: text('status').$type<AlertStatus>().notNull().default('new'),
    summary: text('summary'),
    /** Parsed labels (alertname, instance, job, ...). Drives target auto-matching. */
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>(),
    /** The full source message, always kept so parsing can improve after the fact. */
    rawPayload: text('raw_payload', { mode: 'json' }).$type<unknown>(),

    slackTs: text('slack_ts'),
    slackPermalink: text('slack_permalink'),

    /** How many times this same alert has fired while the row stayed open. */
    count: integer('count').notNull().default(1),

    /** The investigation run started from this alert, if any. */
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),

    receivedAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(() => new Date()),
    decidedAt: ts('decided_at'),
    decidedBy: text('decided_by').references(() => users.id),
  },
  (t) => [index('alerts_project_status').on(t.projectId, t.status, t.receivedAt)],
);

/**
 * Routing layer, kept separate from the (workspace-level) Slack connection so the
 * same channel can feed more than one project. A message in `channelId` creates one
 * alert per enabled subscription that names it.
 */
export const alertSubscriptions = sqliteTable(
  'alert_subscriptions',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    channelName: text('channel_name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('alert_subs_channel').on(t.channelId, t.enabled)],
);
