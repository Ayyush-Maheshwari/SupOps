import { Router } from 'express';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { runs, targets, toolCalls } from '@supops/db';
import { db } from '../context.ts';

export const dashboardRoutes = Router();

const DAYS = 14;

/**
 * Everything the dashboard needs, in one round trip.
 *
 * Aggregated in SQL rather than by loading rows and counting in JS: these tables
 * grow without bound and the dashboard polls, so the work belongs in the query.
 * No new tables -- every number here is derived from what the engine already writes.
 */
dashboardRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const since = new Date(Date.now() - DAYS * 86_400_000);
  const scoped = eq(runs.projectId, projectId);

  const runsByStatus = db
    .select({ status: runs.status, n: sql<number>`count(*)` })
    .from(runs)
    .where(scoped)
    .groupBy(runs.status)
    .all();

  const callsByTier = db
    .select({ tier: toolCalls.tier, n: sql<number>`count(*)` })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(scoped)
    .groupBy(toolCalls.tier)
    .all();

  const callsByState = db
    .select({ state: toolCalls.state, n: sql<number>`count(*)` })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(scoped)
    .groupBy(toolCalls.state)
    .all();

  /**
   * The autonomy split — the product's central claim, measured.
   *
   * `decided_by IS NULL` on an executed call means policy allowed it without asking
   * anyone; that is the number worth watching.
   */
  const autonomy = db
    .select({
      auto: sql<number>`sum(case when ${toolCalls.decidedBy} is null and ${toolCalls.state} in ('succeeded','failed') then 1 else 0 end)`,
      approved: sql<number>`sum(case when ${toolCalls.decidedBy} is not null and ${toolCalls.state} in ('succeeded','failed') then 1 else 0 end)`,
      refused: sql<number>`sum(case when ${toolCalls.state} in ('denied','expired') then 1 else 0 end)`,
      blocked: sql<number>`sum(case when ${toolCalls.state} = 'blocked' then 1 else 0 end)`,
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(scoped)
    .get();

  // Daily buckets, local-time, oldest first.
  const activityRows = db
    .select({
      day: sql<string>`date(${runs.startedAt} / 1000, 'unixepoch', 'localtime')`,
      n: sql<number>`count(*)`,
      failed: sql<number>`sum(case when ${runs.status} in ('failed','halted') then 1 else 0 end)`,
    })
    .from(runs)
    .where(and(scoped, gte(runs.startedAt, since)))
    .groupBy(sql`1`)
    .all();

  const byDay = new Map(activityRows.map((r) => [r.day, r]));
  const activity = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(Date.now() - (DAYS - 1 - i) * 86_400_000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = byDay.get(key);
    return { day: key, runs: row?.n ?? 0, failed: row?.failed ?? 0 };
  });

  // Machines reached via a jump (config.via) are not top-level targets -- they live
  // under their jump's umbrella and must not be counted as separate targets in the UI.
  const health = db
    .select({ state: targets.healthState, n: sql<number>`count(*)` })
    .from(targets)
    .where(
      and(
        eq(targets.projectId, projectId),
        eq(targets.enabled, true),
        sql`json_extract(${targets.config}, '$.via.alias') is null`,
      ),
    )
    .groupBy(targets.healthState)
    .all();

  /**
   * Approval behaviour. A very high approve rate at a very low median latency is
   * the signal that the risk tiers are mis-set and people are rubber-stamping --
   * which is exactly the failure this product has to watch for in itself.
   */
  const decided = db
    .select({
      total: sql<number>`count(*)`,
      approvedCount: sql<number>`sum(case when ${toolCalls.state} in ('approved','succeeded','failed') then 1 else 0 end)`,
      medianMs: sql<number>`avg(${toolCalls.decidedAt} - ${toolCalls.createdAt})`,
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(and(scoped, sql`${toolCalls.decidedBy} is not null`))
    .get();

  // Only count approvals on runs that are still active. A call left awaiting
  // approval on a run that was later cancelled or failed can never be acted on, so
  // counting it made the "Awaiting you" tile sit at 1 with nothing to approve.
  const pending = db
    .select({ n: sql<number>`count(*)`, oldest: sql<number>`min(${toolCalls.createdAt})` })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(
      and(
        scoped,
        eq(toolCalls.state, 'awaiting_approval'),
        inArray(runs.status, ['running', 'awaiting_approval', 'suspended', 'queued']),
      ),
    )
    .get();

  res.json({
    runs: Object.fromEntries(runsByStatus.map((r) => [r.status, r.n])),
    tiers: Object.fromEntries(callsByTier.filter((r) => r.tier).map((r) => [r.tier, r.n])),
    states: Object.fromEntries(callsByState.map((r) => [r.state, r.n])),
    autonomy: {
      auto: autonomy?.auto ?? 0,
      approved: autonomy?.approved ?? 0,
      refused: autonomy?.refused ?? 0,
      blocked: autonomy?.blocked ?? 0,
    },
    activity,
    targetHealth: Object.fromEntries(health.map((r) => [r.state, r.n])),
    approvals: {
      pending: pending?.n ?? 0,
      oldestWaitingSince: pending?.oldest ?? null,
      decided: decided?.total ?? 0,
      approveRate: decided?.total ? (decided.approvedCount ?? 0) / decided.total : null,
      avgDecisionMs: decided?.medianMs ?? null,
    },
  });
});
