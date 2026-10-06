import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { alerts, createDb, evidence, incidents, metricPoints, observations, runs, targets, watches } from '@supops/db';
import { seedRun } from '../engine/harness.test-util.ts';
import { cleanupObservability, previewObservabilityCleanup } from './observability.ts';
import { deleteOldRuns } from './retention.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../db/migrations');
const DAY = 86_400_000;

test('observability clean-up removes old closed history and keeps anything open', async () => {
  const { db } = createDb(join(mkdtempSync(join(tmpdir(), 'supops-obs-')), 'test.db'));
  migrate(db, { migrationsFolder: MIGRATIONS });
  const runId = seedRun(db as never, []);
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!;
  const now = Date.now();
  const old = new Date(now - 20 * DAY);
  const recent = new Date(now - 2 * DAY);

  const conn = db.insert(targets).values({
    projectId: run.projectId, slug: 'prom', name: 'prom', kind: 'prometheus', env: 'prod', sensitivity: 1, tags: [],
    config: { kind: 'prometheus', baseUrl: 'http://prom.example:9090', allowPrivateNetwork: true }, createdAt: new Date(),
  } as never).returning().get();
  const w = db.insert(watches).values({ projectId: run.projectId, connectionId: conn.id, key: 'cpu', title: 'CPU', query: 'x' }).returning().get();
  db.insert(metricPoints).values([
    { watchId: w.id, series: '{}', at: now - 20 * DAY, value: 1 },
    { watchId: w.id, series: '{}', at: now - DAY, value: 2 },
  ]).run();

  const oldResolved = db.insert(incidents).values({ projectId: run.projectId, title: 'old', status: 'resolved', resolvedAt: old, openedAt: old, runId }).returning().get();
  db.insert(evidence).values({ incidentId: oldResolved.id, ref: 'E1', check: 'cpu', title: 'CPU', status: 'normal', summary: 'ok' }).run();
  const oldOpen = db.insert(incidents).values({ projectId: run.projectId, title: 'still open', status: 'open', openedAt: old, runId }).returning().get();
  const recentResolved = db.insert(incidents).values({ projectId: run.projectId, title: 'recent', status: 'resolved', resolvedAt: recent }).returning().get();

  const alert = (status: string, resolvedAt: Date | null, incidentId: string | null = null) =>
    db.insert(alerts).values({ projectId: run.projectId, fingerprint: `${status}-${resolvedAt?.getTime()}`, title: 'A', status: status as never, resolvedAt, lastSeenAt: resolvedAt ?? old, incidentId }).returning().get().id;
  const a1 = alert('resolved', old, oldResolved.id);
  const a2 = alert('new', null);
  const a3 = alert('resolved', recent);

  db.insert(observations).values([
    { projectId: run.projectId, watchId: w.id, series: '{}', kind: 'anomaly', severity: 'warning', message: 'old', resolvedAt: old },
    { projectId: run.projectId, watchId: w.id, series: '{}', kind: 'forecast', severity: 'critical', message: 'open', startedAt: old },
  ]).run();

  assert.deepEqual(previewObservabilityCleanup(db, { days: 15 }), { points: 1, observations: 1, incidents: 1, alerts: 1 });
  const r = cleanupObservability(db, { days: 15 });
  assert.deepEqual(r, { points: 1, observations: 1, incidents: 1, alerts: 1 });

  const ids = (t: typeof incidents) => db.select({ id: t.id }).from(t).all().map((x) => x.id).sort();
  assert.deepEqual(ids(incidents), [oldOpen.id, recentResolved.id].sort());
  assert.equal(db.select().from(evidence).all().length, 0, 'evidence went with its incident');
  assert.deepEqual(db.select({ id: alerts.id }).from(alerts).all().map((x) => x.id).sort(), [a2, a3].sort());
  assert.ok(!db.select().from(alerts).all().some((x) => x.id === a1));
  assert.equal(db.select().from(observations).all().length, 1);
  assert.equal(db.select().from(metricPoints).all().length, 1);

  // Run retention keeps the run an open incident points at.
  db.update(runs).set({ status: 'succeeded', startedAt: old, endedAt: old }).where(eq(runs.id, runId)).run();
  await deleteOldRuns(db as never, { olderThanDays: 7 });
  assert.ok(db.select().from(runs).where(eq(runs.id, runId)).get(), 'kept for the open incident');
});
