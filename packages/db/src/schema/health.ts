import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  HealthCheckStatus,
  HealthIssueState,
  HealthScanType,
} from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { targets } from './targets.ts';
import { runs } from './runs.ts';

/**
 * One health-check cycle -- a Quick probe sweep or a Deep agent run over a
 * project's targets. Quick checks finish synchronously and land as `done`; Deep
 * checks link a `runId` and stay `running` until the engine finishes the run and the
 * scheduler harvests its findings.
 */
export const healthChecks = sqliteTable(
  'health_checks',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').$type<HealthScanType>().notNull(),
    trigger: text('trigger').$type<'manual' | 'schedule'>().notNull().default('manual'),
    status: text('status').$type<HealthCheckStatus>().notNull().default('running'),
    /** The Deep-scan run this check is harvesting from, if any. */
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** { checked, ok, degraded, unreachable, issues } -- filled when the check is done. */
    summaryJson: text('summary_json', { mode: 'json' }).$type<HealthCheckSummary | null>(),
    startedBy: text('started_by').references(() => users.id),
    startedAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('health_checks_project').on(t.projectId, t.startedAt)],
);

export interface HealthCheckSummary {
  checked: number;
  ok: number;
  degraded: number;
  unreachable: number;
  issues: number;
  /** The at-a-glance numbers per target, for a Quick scan. */
  targets?: HealthTargetMetric[];
}

export interface HealthTargetMetric {
  targetId: string;
  slug: string;
  healthState: 'ok' | 'degraded' | 'unreachable' | 'unknown';
  diskPct: number | null;
  memPct: number | null;
  load1: number | null;
  cores: number | null;
  failedUnits: number;
  namespaces: number | null;
  pods: number | null;
  badPods: number | null;
}

/**
 * One problem a scan found on one target. Deduped by `(projectId, fingerprint)`
 * while still open: a problem that persists across scans bumps `lastSeenAt` on the
 * existing row instead of spawning a new one -- the same shape as alert dedup.
 */
export const healthIssues = sqliteTable(
  'health_issues',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    checkId: text('check_id')
      .notNull()
      .references(() => healthChecks.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    severity: text('severity').$type<'warning' | 'critical'>().notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    state: text('state').$type<HealthIssueState>().notNull().default('open'),
    /** The investigation run a human started from this issue, if any. */
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** sha256(targetId + title) -- collapses the same problem across scans. */
    fingerprint: text('fingerprint').notNull(),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(() => new Date()),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [index('health_issues_project_state').on(t.projectId, t.state, t.lastSeenAt)],
);
