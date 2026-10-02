import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { createDb, healthChecks, healthIssues, runAttachments, runSteps, runs, toolCalls } from '@supops/db';
import { seedRun } from '../engine/harness.test-util.ts';
import { deleteOldRuns, dropOldImages, previewCleanup, selectRunsForCleanup } from './retention.ts';
import { autoVacuumMode, ensureIncrementalVacuum, reclaimSpace, storageStats } from './storage.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../db/migrations');
const DAY = 86_400_000;

function fresh() {
  const path = join(mkdtempSync(join(tmpdir(), 'supops-ret-')), 'test.db');
  const { db, sqlite } = createDb(path);
  migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, sqlite, path };
}

type DbT = ReturnType<typeof fresh>['db'];

/** A copy of the seeded run with a given status, age and pin. */
function addRun(db: DbT, template: string, o: { status: string; ageDays: number; pinned?: boolean; ended?: boolean }) {
  const t = db.select().from(runs).where(eq(runs.id, template)).get()!;
  const at = new Date(Date.now() - o.ageDays * DAY);
  const { id: _id, ...rest } = t;
  const row = db
    .insert(runs)
    .values({ ...rest, status: o.status as never, pinned: !!o.pinned, startedAt: at, endedAt: o.ended === false ? null : at })
    .returning()
    .get();
  const step = db.insert(runSteps).values({ runId: row.id, seq: 0, messageJson: { role: 'user', content: 'x' }, state: 'committed' }).returning().get();
  db.insert(toolCalls).values({ runId: row.id, stepId: step.id, toolCallId: `${row.id}-c`, callIndex: 0, toolKey: 'shell', argsJson: {}, argsHash: 'h', state: 'succeeded' } as never).run();
  return row.id;
}

function scenario() {
  const env = fresh();
  const base = seedRun(env.db as never, []);
  const ids = {
    oldDone: addRun(env.db, base, { status: 'succeeded', ageDays: 40 }),
    oldFailed: addRun(env.db, base, { status: 'failed', ageDays: 20 }),
    oldSession: addRun(env.db, base, { status: 'awaiting_input', ageDays: 31 }),
    oldPinned: addRun(env.db, base, { status: 'succeeded', ageDays: 90, pinned: true }),
    oldRunning: addRun(env.db, base, { status: 'running', ageDays: 50, ended: false }),
    oldAwaiting: addRun(env.db, base, { status: 'awaiting_approval', ageDays: 50, ended: false }),
    oldLinked: addRun(env.db, base, { status: 'succeeded', ageDays: 60 }),
    recent: addRun(env.db, base, { status: 'succeeded', ageDays: 2 }),
  };
  // An open health issue still points at oldLinked.
  const run = env.db.select().from(runs).where(eq(runs.id, ids.oldLinked)).get()!;
  const check = env.db.insert(healthChecks).values({ projectId: run.projectId, type: 'quick', status: 'done' }).returning().get();
  env.db.insert(healthIssues).values({
    projectId: run.projectId, checkId: check.id, targetId: (env.db.all(`select id from targets limit 1`) as Array<{ id: string }>)[0]!.id,
    severity: 'warning', title: 'disk', fingerprint: 'fp', state: 'open', runId: ids.oldLinked, lastSeenAt: new Date(),
  } as never).run();
  return { ...env, ids };
}

test('only finished, unpinned, unlinked runs past the age are selected', () => {
  const { db, ids } = scenario();
  const picked = new Set(selectRunsForCleanup(db, { olderThanDays: 15 }));
  assert.deepEqual(
    [...picked].sort(),
    [ids.oldDone, ids.oldFailed, ids.oldSession].sort(),
    'finished runs (incl. a parked console session) older than 15 days',
  );
  for (const k of ['oldPinned', 'oldRunning', 'oldAwaiting', 'oldLinked', 'recent'] as const) {
    assert.ok(!picked.has(ids[k]), `${k} must be kept`);
  }
  assert.deepEqual(new Set(selectRunsForCleanup(db, { olderThanDays: 30 })), new Set([ids.oldDone, ids.oldSession]));
});

test('the preview counts what goes and explains what stays', () => {
  const { db } = scenario();
  const p = previewCleanup(db, { olderThanDays: 15 });
  assert.equal(p.runs, 3);
  assert.deepEqual(p.kept, { pinned: 1, active: 2, linked: 1 });
});

test('deleting cascades to steps and tool calls, and keeps everything protected', async () => {
  const { db, ids } = scenario();
  const deleted = await deleteOldRuns(db, { olderThanDays: 15 });
  assert.equal(deleted, 3);
  for (const k of ['oldDone', 'oldFailed', 'oldSession'] as const) {
    assert.equal(db.select().from(runs).where(eq(runs.id, ids[k])).get(), undefined);
    assert.equal(db.select().from(toolCalls).where(eq(toolCalls.runId, ids[k])).all().length, 0, 'tool calls cascade');
  }
  for (const k of ['oldPinned', 'oldRunning', 'oldAwaiting', 'oldLinked', 'recent'] as const) {
    assert.ok(db.select().from(runs).where(eq(runs.id, ids[k])).get(), `${k} survives`);
  }
});

test('a run revived or pinned between selection and deletion is left alone', async () => {
  const { db, ids } = scenario();
  // Simulate the race: selection happens, then the session is revived and a run pinned.
  const selected = selectRunsForCleanup(db, { olderThanDays: 15 });
  assert.ok(selected.includes(ids.oldSession) && selected.includes(ids.oldDone));
  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, ids.oldSession)).run();
  db.update(runs).set({ pinned: true }).where(eq(runs.id, ids.oldDone)).run();
  await deleteOldRuns(db, { olderThanDays: 15 });
  assert.ok(db.select().from(runs).where(eq(runs.id, ids.oldSession)).get(), 'revived session kept');
  assert.ok(db.select().from(runs).where(eq(runs.id, ids.oldDone)).get(), 'newly pinned run kept');
});

test('dropping images keeps the run and only removes old attachments', () => {
  const { db, ids } = scenario();
  const png = Buffer.alloc(2048, 7);
  db.insert(runAttachments).values({ runId: ids.recent, mime: 'image/png', bytes: png.length, data: png, createdAt: new Date(Date.now() - 10 * DAY) }).run();
  db.insert(runAttachments).values({ runId: ids.recent, mime: 'image/png', bytes: png.length, data: png }).run();
  const r = dropOldImages(db, { olderThanDays: 7 });
  assert.deepEqual(r, { images: 1, bytes: 2048 });
  assert.equal(db.select().from(runAttachments).all().length, 1);
  assert.ok(db.select().from(runs).where(eq(runs.id, ids.recent)).get());
});

test('a fresh database uses incremental auto-vacuum, and clean-up shrinks the file', async () => {
  const { db, sqlite, path, ids } = scenario();
  assert.equal(autoVacuumMode(sqlite), 2, 'new databases are created ready to shrink');
  const big = Buffer.alloc(64 * 1024, 1);
  for (let i = 0; i < 80; i += 1) {
    db.insert(runAttachments).values({ runId: ids.oldDone, mime: 'image/png', bytes: big.length, data: big }).run();
  }
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  const before = storageStats(sqlite, path).databaseBytes;
  assert.ok(before > 4_000_000, `expected a few MB of images, got ${before}`);

  await deleteOldRuns(db, { olderThanDays: 15 });
  const r = reclaimSpace(sqlite, path);
  const after = storageStats(sqlite, path);
  assert.equal(r.shrunk, true);
  assert.ok(after.databaseBytes < before / 4, `file should shrink: ${before} -> ${after.databaseBytes}`);
  assert.equal(after.freeInsideBytes, 0);
});

test('an existing database without auto-vacuum is converted once, keeping its data', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'supops-old-')), 'old.db');
  // An install created before this change: auto_vacuum NONE, WAL mode, real rows.
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.exec('create table t(x blob)');
  raw.prepare('insert into t values (?)').run(Buffer.alloc(8192, 3));
  assert.equal(autoVacuumMode(raw), 0);

  assert.equal(ensureIncrementalVacuum(raw, path).status, 'converted');
  assert.equal(autoVacuumMode(raw), 2);
  assert.equal((raw.prepare('select count(*) n from t').get() as { n: number }).n, 1, 'data survives');
  assert.equal(ensureIncrementalVacuum(raw, path).status, 'already', 'idempotent');
});

test('conversion is skipped, with a reason, when the database is too large to rewrite at boot', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'supops-big-')), 'big.db');
  const raw = new Database(path);
  raw.exec('create table t(x blob)');
  for (let i = 0; i < 40; i += 1) raw.prepare('insert into t values (?)').run(Buffer.alloc(64 * 1024, 1));
  const r = ensureIncrementalVacuum(raw, path, { maxMb: 1 });
  assert.equal(r.status, 'skipped');
  assert.match((r as { reason: string }).reason, /Compact database/);
  assert.equal(autoVacuumMode(raw), 0);
});
