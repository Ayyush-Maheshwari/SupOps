import { and, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import type { Db } from '@supops/db';
import { healthChecks, healthIssues, incidents, runAttachments, runs } from '@supops/db';
import { TERMINAL_RUN_STATUSES } from '@supops/shared';

/**
 * Run-history clean-up.
 *
 * Every run keeps its transcript, every command's output and any pasted images, so
 * history grows without bound and eventually fills the disk. This removes finished
 * runs past an age (steps, tool calls, events and attachments cascade), or just the
 * images sooner, and then hands the space back to the filesystem -- deleting rows
 * alone does not shrink a SQLite file.
 *
 * What is never removed: runs still doing something, pinned runs, and runs an open
 * health issue, an open incident or a running health check still points at.
 */

/** A run may be cleaned up only once nothing is in flight. A parked console session counts as finished. */
export const CLEANABLE_STATUSES = [...TERMINAL_RUN_STATUSES, 'awaiting_input'] as const;

const DAY = 86_400_000;
const BATCH = 50;

export interface CleanupScope {
  olderThanDays: number;
  /** Limit to one project; omit for every project (the scheduled job). */
  projectId?: string;
  now?: Date;
}

/** Reference time for "older than": when the run ended, or started if it never did. */
const ageOf = sql`coalesce(${runs.endedAt}, ${runs.startedAt})`;

function protectedRunIds(db: Db): Set<string> {
  const keep = new Set<string>();
  for (const r of db
    .select({ id: healthIssues.runId })
    .from(healthIssues)
    .where(and(isNotNull(healthIssues.runId), inArray(healthIssues.state, ['open', 'investigating'])))
    .all()) if (r.id) keep.add(r.id);
  for (const r of db
    .select({ id: healthChecks.runId })
    .from(healthChecks)
    .where(and(isNotNull(healthChecks.runId), eq(healthChecks.status, 'running')))
    .all()) if (r.id) keep.add(r.id);
  // The investigation of an incident that is still open.
  for (const r of db
    .select({ id: incidents.runId })
    .from(incidents)
    .where(and(isNotNull(incidents.runId), eq(incidents.status, 'open')))
    .all()) if (r.id) keep.add(r.id);
  return keep;
}

function eligibleWhere(scope: CleanupScope) {
  const cutoff = new Date((scope.now ?? new Date()).getTime() - scope.olderThanDays * DAY);
  return and(
    inArray(runs.status, [...CLEANABLE_STATUSES]),
    eq(runs.pinned, false),
    sql`${ageOf} < ${cutoff.getTime()}`,
    ...(scope.projectId ? [eq(runs.projectId, scope.projectId)] : []),
  );
}

/** Runs a clean-up with this scope would delete. */
export function selectRunsForCleanup(db: Db, scope: CleanupScope): string[] {
  const keep = protectedRunIds(db);
  return db
    .select({ id: runs.id })
    .from(runs)
    .where(eligibleWhere(scope))
    .all()
    .map((r) => r.id)
    .filter((id) => !keep.has(id));
}

export interface CleanupPreview {
  runs: number;
  images: number;
  imageBytes: number;
  /** Runs past the age that are kept, and why. */
  kept: { pinned: number; active: number; linked: number };
}

export function previewCleanup(db: Db, scope: CleanupScope): CleanupPreview {
  const ids = selectRunsForCleanup(db, scope);
  const cutoff = new Date((scope.now ?? new Date()).getTime() - scope.olderThanDays * DAY);
  const old = and(sql`${ageOf} < ${cutoff.getTime()}`, ...(scope.projectId ? [eq(runs.projectId, scope.projectId)] : []));
  const count = (extra: ReturnType<typeof and>) =>
    db.select({ n: sql<number>`count(*)` }).from(runs).where(and(old, extra)).get()?.n ?? 0;

  const att = ids.length
    ? chunked(ids).reduce(
        (acc, part) => {
          const r = db
            .select({ n: sql<number>`count(*)`, b: sql<number>`coalesce(sum(${runAttachments.bytes}), 0)` })
            .from(runAttachments)
            .where(inArray(runAttachments.runId, part))
            .get();
          return { n: acc.n + (r?.n ?? 0), b: acc.b + (r?.b ?? 0) };
        },
        { n: 0, b: 0 },
      )
    : { n: 0, b: 0 };

  const eligibleOld = count(and(inArray(runs.status, [...CLEANABLE_STATUSES]), eq(runs.pinned, false)));
  return {
    runs: ids.length,
    images: att.n,
    imageBytes: att.b,
    kept: {
      pinned: count(eq(runs.pinned, true)),
      active: count(notInArray(runs.status, [...CLEANABLE_STATUSES])),
      linked: eligibleOld - ids.length,
    },
  };
}

/**
 * Delete the runs a scope selects, in small batches so the write lock is never held
 * for long. The DELETE repeats the status, pin and age conditions: a console session
 * revived (or a run pinned) between selection and deletion is left alone.
 */
export async function deleteOldRuns(db: Db, scope: CleanupScope): Promise<number> {
  const ids = selectRunsForCleanup(db, scope);
  let deleted = 0;
  for (const part of chunked(ids, BATCH)) {
    deleted += db.delete(runs).where(and(inArray(runs.id, part), eligibleWhere(scope))).run().changes;
    // Yield between batches so HTTP and the engine keep moving during a big clean-up.
    await new Promise((r) => setImmediate(r));
  }
  return deleted;
}

/** Drop pasted images older than the cutoff. The run and its transcript stay; the agent sees a note instead. */
export function dropOldImages(db: Db, scope: CleanupScope): { images: number; bytes: number } {
  const cutoff = new Date((scope.now ?? new Date()).getTime() - scope.olderThanDays * DAY);
  const where = and(
    lt(runAttachments.createdAt, cutoff),
    ...(scope.projectId
      ? [inArray(runAttachments.runId, db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, scope.projectId)))]
      : []),
  );
  const r = db
    .select({ n: sql<number>`count(*)`, b: sql<number>`coalesce(sum(${runAttachments.bytes}), 0)` })
    .from(runAttachments)
    .where(where)
    .get();
  db.delete(runAttachments).where(where).run();
  return { images: r?.n ?? 0, bytes: r?.b ?? 0 };
}

function chunked<T>(xs: T[], n = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
