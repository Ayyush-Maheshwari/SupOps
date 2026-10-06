import { Router } from 'express';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alerts, evidence, incidents, observations, runs, targets, toolCalls, watches } from '@supops/db';
import { forecastLimit, loadTargets, mad, median, parseSeriesKey, runChecks, seriesName } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db, settingsStore } from '../context.ts';
import { audit } from '../services/audit.ts';
import { startRun } from '../services/start-run.ts';
import { importsAlerts, projectConnections, watchesMetrics } from '../observe/connections.ts';
import { pollConnection, pollStatus } from '../observe/alert-poller.ts';
import { mergeIncidents, splitIncident } from '../observe/incidents.ts';
import { enqueueTriage, gatherEvidence, latestFixRun, startIncidentRun } from '../observe/triage.ts';
import { chartSeries, discover, watchConnection, watcher } from '../observe/watcher.ts';

/**
 * Observability: incidents (grouped alerts and predictions), their evidence and
 * investigations, the signals SupOps watches, and what it currently notices.
 */
export const observabilityRoutes = Router();

const projectOf = (req: { query: Record<string, unknown> }) => (typeof req.query.projectId === 'string' ? req.query.projectId : '');

function requireProject(req: Parameters<Parameters<typeof observabilityRoutes.get>[1]>[0], res: Parameters<Parameters<typeof observabilityRoutes.get>[1]>[1]): string | null {
  const p = projectOf(req as never);
  if (!p) {
    res.status(400).json({ error: 'projectId is required' });
    return null;
  }
  return p;
}

const SEV = sql`case ${incidents.severity} when 'critical' then 0 when 'warning' then 1 when 'info' then 2 else 3 end`;

/** Everything the Overview tab shows, in one request. */
observabilityRoutes.get('/overview', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const open = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open')))
    .orderBy(SEV, desc(incidents.lastSeenAt))
    .limit(20)
    .all();
  const counts = db
    .select({ incidentId: alerts.incidentId, n: sql<number>`count(*)` })
    .from(alerts)
    .where(inArray(alerts.incidentId, open.map((i) => i.id).concat('-')))
    .groupBy(alerts.incidentId)
    .all();
  const obs = db
    .select({
      id: observations.id, kind: observations.kind, severity: observations.severity, message: observations.message,
      targetId: observations.targetId, watchId: observations.watchId, series: observations.series, details: observations.details,
      startedAt: observations.startedAt, incidentId: observations.incidentId, unit: watches.unit, title: watches.title,
    })
    .from(observations)
    .innerJoin(watches, eq(watches.id, observations.watchId))
    .where(and(eq(observations.projectId, projectId), isNull(observations.resolvedAt)))
    .orderBy(desc(observations.lastSeenAt))
    .limit(100)
    .all();
  const conns = projectConnections(projectId);
  const ws = db.select().from(watches).where(eq(watches.projectId, projectId)).all();
  res.json({
    incidents: open.map((i) => ({ ...i, alertCount: counts.find((c) => c.incidentId === i.id)?.n ?? 0 })),
    observations: obs,
    connections: conns.map((c) => ({
      id: c.id, slug: c.slug, kind: c.kind,
      importsAlerts: importsAlerts(c), watches: watchesMetrics(c),
      poll: pollStatus.get(c.id) ?? null,
      watchCount: ws.filter((w) => w.connectionId === c.id && w.enabled).length,
      watchErrors: ws.filter((w) => w.connectionId === c.id && w.enabled && w.lastError && !w.lastError.includes('more series')).length,
      lastSampledAt: ws.filter((w) => w.connectionId === c.id).reduce<number | null>((m, w) => (w.lastRunAt && (!m || w.lastRunAt.getTime() > m) ? w.lastRunAt.getTime() : m), null),
    })),
    settings: settingsStore.observability(),
  });
});

observabilityRoutes.get('/count', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const n = db.select({ n: sql<number>`count(*)` }).from(incidents).where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open'))).get()?.n ?? 0;
  res.json({ open: n });
});

observabilityRoutes.get('/incidents', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const status = req.query.status === 'resolved' ? 'resolved' : req.query.status === 'all' ? null : 'open';
  const rows = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, projectId), isNull(incidents.mergedInto), ...(status ? [eq(incidents.status, status)] : [])))
    .orderBy(desc(incidents.openedAt))
    .limit(200)
    .all();
  const counts = db
    .select({ incidentId: alerts.incidentId, n: sql<number>`count(*)` })
    .from(alerts)
    .where(inArray(alerts.incidentId, rows.map((i) => i.id).concat('-')))
    .groupBy(alerts.incidentId)
    .all();
  res.json(rows.map((i) => ({ ...i, alertCount: counts.find((c) => c.incidentId === i.id)?.n ?? 0 })));
});

observabilityRoutes.get('/incidents/:id', (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const members = db.select().from(alerts).where(eq(alerts.incidentId, inc.id)).orderBy(asc(alerts.receivedAt)).all();
  const ev = db.select().from(evidence).where(eq(evidence.incidentId, inc.id)).all();
  ev.sort((a, b) => (a.ref === '-' ? 1 : b.ref === '-' ? -1 : Number(a.ref.slice(1)) - Number(b.ref.slice(1))));
  const obs = db.select().from(observations).where(eq(observations.incidentId, inc.id)).all();
  const run = inc.runId ? db.select({ id: runs.id, status: runs.status, title: runs.title, startedAt: runs.startedAt, endedAt: runs.endedAt, policySnapshot: runs.policySnapshot }).from(runs).where(eq(runs.id, inc.runId)).get() : null;
  const slugs = new Map(loadTargets(db, inc.projectId).map((t) => [t.id, t.slug]));

  // Timeline: alerts firing and resolving, the investigation, and SupOps' own changes.
  const timeline: Array<{ at: number; kind: string; text: string }> = [];
  timeline.push({ at: inc.openedAt.getTime(), kind: 'opened', text: inc.origin === 'prediction' ? 'Predicted by the watcher' : 'Incident opened' });
  for (const a of members) {
    timeline.push({ at: (a.startsAt ?? a.receivedAt).getTime(), kind: 'alert', text: `${a.title} fired${a.labels?.instance ? ` on ${a.labels.instance}` : ''}` });
    if (a.resolvedAt) timeline.push({ at: a.resolvedAt.getTime(), kind: 'resolved', text: `${a.title} resolved` });
  }
  if (run) {
    timeline.push({ at: run.startedAt.getTime(), kind: 'run', text: (run.policySnapshot as { unattended?: boolean }).unattended ? 'Read-only diagnosis started automatically' : 'Investigation started' });
    const changes = db
      .select({ at: toolCalls.createdAt, toolKey: toolCalls.toolKey, tier: toolCalls.tier, state: toolCalls.state })
      .from(toolCalls)
      .where(and(eq(toolCalls.runId, run.id), inArray(toolCalls.tier, ['low', 'medium', 'high']), eq(toolCalls.state, 'succeeded')))
      .all();
    for (const c of changes) timeline.push({ at: c.at.getTime(), kind: 'change', text: `Change made: ${c.toolKey} (${c.tier})` });
  }
  for (const e of ev.filter((x) => x.check === 'deploys' && x.status === 'interesting')) {
    timeline.push({ at: e.createdAt.getTime(), kind: 'deploy', text: e.summary.split('\n')[0]! });
  }
  if (inc.resolvedAt) timeline.push({ at: inc.resolvedAt.getTime(), kind: 'closed', text: inc.mergedInto ? 'Merged into another incident' : 'Incident resolved' });
  timeline.sort((a, b) => a.at - b.at);

  const others = db
    .select({ id: incidents.id, title: incidents.title })
    .from(incidents)
    .where(and(eq(incidents.projectId, inc.projectId), eq(incidents.status, 'open')))
    .all()
    .filter((o) => o.id !== inc.id);

  res.json({
    incident: { ...inc, targets: (inc.targetIds ?? []).map((id) => slugs.get(id)).filter(Boolean) },
    alerts: members,
    evidence: ev.map((e) => ({ ...e, connection: e.connectionId ? slugs.get(e.connectionId) ?? null : null })),
    observations: obs,
    run,
    fixRun: latestFixRun(inc.id),
    timeline,
    mergeCandidates: others,
  });
});

observabilityRoutes.post('/incidents/:id/investigate', (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const r = startIncidentRun(inc, { mode: 'fix', startedBy: req.user?.id ?? null });
  if (!r.ok) {
    res.status(r.code).json({ error: r.error });
    return;
  }
  res.status(201).json({ runId: r.runId });
});

observabilityRoutes.post('/incidents/:id/evidence', async (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const ev = await gatherEvidence(inc);
  res.json({ count: ev.length });
});

observabilityRoutes.post('/incidents/:id/resolve', (req, res) => {
  const row = db
    .update(incidents)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(eq(incidents.id, req.params.id))
    .returning()
    .get();
  if (!row) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  // Its open alerts are dealt with too.
  db.update(alerts)
    .set({ status: 'ignored', decidedAt: new Date(), decidedBy: req.user?.id ?? null })
    .where(and(eq(alerts.incidentId, row.id), inArray(alerts.status, ['new', 'investigating'])))
    .run();
  res.json(row);
});

observabilityRoutes.post('/incidents/:id/merge', (req, res) => {
  const body = z.object({ into: z.string() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'into is required' });
    return;
  }
  const r = mergeIncidents(req.params.id, body.data.into);
  if (!r) {
    res.status(400).json({ error: 'Those incidents cannot be merged.' });
    return;
  }
  res.json(r);
});

observabilityRoutes.post('/incidents/:id/split', (req, res) => {
  const body = z.object({ alertIds: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'alertIds is required' });
    return;
  }
  const r = splitIncident(req.params.id, body.data.alertIds);
  if (!r) {
    res.status(400).json({ error: 'Choose some, but not all, of the incident\'s alerts.' });
    return;
  }
  enqueueTriage(r.id);
  res.json(r);
});

// ---- watches -----------------------------------------------------------------------

observabilityRoutes.get('/watches', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  const rows = db.select().from(watches).where(eq(watches.projectId, projectId)).orderBy(asc(watches.group), asc(watches.title)).all();
  const slugs = new Map(loadTargets(db, projectId).map((t) => [t.id, t.slug]));
  const open = db
    .select({ watchId: observations.watchId, series: observations.series, kind: observations.kind, severity: observations.severity })
    .from(observations)
    .where(and(eq(observations.projectId, projectId), isNull(observations.resolvedAt)))
    .all();
  res.json(
    rows.map((w) => {
      const series = w.enabled ? chartSeries(w.id, hours, 60) : [];
      return {
        ...w,
        connection: slugs.get(w.connectionId) ?? null,
        series: series.slice(0, 12).map((s) => ({
          key: s.series,
          name: seriesName(parseSeriesKey(s.series)),
          points: s.points,
          flags: open.filter((o) => o.watchId === w.id && o.series === s.series).map((o) => `${o.kind}:${o.severity}`),
        })),
        moreSeries: Math.max(0, series.length - 12),
      };
    }),
  );
});

/** One watch in detail: its series over a window, a baseline band and forecasts. */
observabilityRoutes.get('/watches/:id/series', (req, res) => {
  const w = db.select().from(watches).where(eq(watches.id, req.params.id)).get();
  if (!w) {
    res.status(404).json({ error: 'Watch not found' });
    return;
  }
  const hours = Math.min(360, Math.max(1, Number(req.query.hours) || 24));
  const series = chartSeries(w.id, hours, 300).slice(0, 20).map((s) => {
    const vals = s.points.slice(-288).map((p) => p[1]);
    const med = median(vals);
    const spread = mad(vals, med);
    const f = w.limit ? forecastLimit(s.points.map(([at, value]) => ({ at, value })).filter((p) => p.at >= Date.now() - 86_400_000), w.limit) : null;
    return {
      key: s.series,
      name: seriesName(parseSeriesKey(s.series)),
      points: s.points,
      band: Number.isFinite(med) ? { low: med - 3 * spread, high: med + 3 * spread, median: med } : null,
      // Only a forecast worth drawing: within a week, and a trend that fits.
      forecast: f && f.etaMs !== null && f.etaMs <= 7 * 86_400_000 && f.confidence !== 'low' ? { etaMs: f.etaMs, slopePerHour: f.slopePerHour, confidence: f.confidence, current: f.current } : null,
    };
  });
  res.json({ watch: w, series });
});

const watchBody = z.object({
  projectId: z.string(),
  connectionId: z.string(),
  title: z.string().min(1).max(120),
  query: z.string().min(1).max(2000),
  unit: z.enum(['percent', 'bytes', 'seconds', 'ratio', 'count', 'days', 'per_second']).default('count'),
  badDirection: z.enum(['up', 'down', 'both']).default('both'),
  limit: z.object({ value: z.number(), when: z.enum(['below', 'above']) }).nullable().default(null),
});

observabilityRoutes.post('/watches', (req, res) => {
  const body = watchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid watch' });
    return;
  }
  const conn = db.select().from(targets).where(eq(targets.id, body.data.connectionId)).get();
  if (!conn || conn.projectId !== body.data.projectId || !['prometheus', 'grafana'].includes(conn.kind)) {
    res.status(400).json({ error: 'Choose a Prometheus or Grafana connection in this project.' });
    return;
  }
  const slug = body.data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'watch';
  const row = db
    .insert(watches)
    .values({ ...body.data, key: `custom:${slug}-${Date.now().toString(36)}`, builtin: false, group: 'custom' })
    .returning()
    .get();
  audit(req.user, { entity: 'watch', entityId: row.id, action: 'create', after: { title: row.title, query: row.query } });
  watcher.kick();
  res.status(201).json(row);
});

observabilityRoutes.patch('/watches/:id', (req, res) => {
  const body = z
    .object({ enabled: z.boolean().optional(), title: z.string().min(1).max(120).optional(), limit: watchBody.shape.limit.optional(), badDirection: watchBody.shape.badDirection.optional() })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid change' });
    return;
  }
  const row = db.update(watches).set(body.data).where(eq(watches.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Watch not found' });
    return;
  }
  if (body.data.enabled === false) {
    db.update(observations).set({ resolvedAt: new Date() }).where(and(eq(observations.watchId, row.id), isNull(observations.resolvedAt))).run();
  }
  res.json(row);
});

observabilityRoutes.delete('/watches/:id', (req, res) => {
  const w = db.select().from(watches).where(eq(watches.id, req.params.id)).get();
  if (!w) {
    res.status(404).json({ error: 'Watch not found' });
    return;
  }
  if (w.builtin) {
    res.status(400).json({ error: 'Built-in signals can be switched off, not deleted.' });
    return;
  }
  db.delete(watches).where(eq(watches.id, w.id)).run();
  res.json({ ok: true });
});

/** Re-discover a connection's signals and sample them now; read its alerts now. */
observabilityRoutes.post('/connections/:id/refresh', async (req, res) => {
  const t = db.select().from(targets).where(eq(targets.id, req.params.id)).get();
  if (!t) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  const conn = projectConnections(t.projectId).find((c) => c.id === t.id);
  if (!conn) {
    res.status(400).json({ error: 'Not an enabled observability connection.' });
    return;
  }
  const out: { added?: number; poll?: unknown } = {};
  if (watchesMetrics(conn)) {
    out.added = await discover(t.projectId, conn);
    await watchConnection(t.projectId, conn);
  }
  if (importsAlerts(conn)) out.poll = await pollConnection(t.projectId, conn);
  res.json(out);
});

// ---- the stack itself ----------------------------------------------------------------

/**
 * Investigate the observability stack itself: run the stack checks first (is
 * Prometheus scraping, are rules evaluating, are notifications getting out), then
 * start a run on the connections with that evidence.
 */
observabilityRoutes.post('/stack-investigate', async (req, res) => {
  const body = z.object({ projectId: z.string(), task: z.string().max(20_000).optional(), agentId: z.string().optional() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const conns = projectConnections(body.data.projectId);
  if (!conns.length) {
    res.status(400).json({ error: 'This project has no observability connections.' });
    return;
  }
  const items = await runChecks(conns, {}, { stack: true, signal: AbortSignal.timeout(60_000) });
  let n = 0;
  const cited = items.filter((i) => i.status !== 'unavailable');
  const lines = [
    'OBSERVABILITY STACK CHECK',
    'EVIDENCE PACK (read-only checks of the monitoring itself; cite as [E1], [E2]...):',
    ...cited.flatMap((i) => [`[E${++n}] ${i.title} (${i.connectionSlug}) -- ${i.status}`, ...i.summary.split('\n').slice(0, i.status === 'interesting' ? 10 : 2).map((l) => `    ${l}`)]),
  ];
  const missing = items.filter((i) => i.status === 'unavailable');
  if (missing.length) lines.push(`Not measured here: ${[...new Set(missing.map((i) => i.title))].join(', ')}.`);

  const agentId =
    body.data.agentId ??
    db.select().from(agents).where(and(eq(agents.projectId, body.data.projectId), eq(agents.slug, 'triage'))).get()?.id ??
    db.select().from(agents).where(eq(agents.projectId, body.data.projectId)).get()?.id;
  if (!agentId) {
    res.status(409).json({ error: 'This project has no agent.' });
    return;
  }
  const r = startRun({
    projectId: body.data.projectId,
    agentId,
    task:
      body.data.task?.trim() ||
      'Check the health of our observability stack: is Prometheus scraping every target, are alert rules evaluating, are notifications reaching Alertmanager and its receivers, are logs being ingested, and is anything about to break (storage, series growth). Use the status operations of the tools.',
    targetIds: conns.map((c) => c.id),
    trigger: 'chat',
    startedBy: req.user?.id ?? null,
    incident: { evidence: lines.join('\n') },
  });
  if (!r.ok) {
    res.status(r.code).json({ error: r.error });
    return;
  }
  res.status(201).json({ run: r.run });
});

// ---- settings ------------------------------------------------------------------------

observabilityRoutes.get('/settings', (_req, res) => res.json(settingsStore.observability()));

const settingsBody = z.object({
  alertPollMs: z.number().int().min(15_000).max(3_600_000).optional(),
  watchIntervalMs: z.number().int().min(60_000).max(3_600_000).optional(),
  autoTriage: z.boolean().optional(),
  triageMinSeverity: z.enum(['critical', 'warning', 'info']).optional(),
  triageMaxPerHour: z.number().int().min(0).max(100).optional(),
  predictWarningHours: z.number().min(1).max(24 * 7).optional(),
  predictCriticalHours: z.number().min(0.5).max(72).optional(),
});

observabilityRoutes.put('/settings', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can change observability settings.' });
    return;
  }
  const body = settingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid settings' });
    return;
  }
  const before = settingsStore.observability();
  const saved = settingsStore.saveObservability(body.data);
  audit(req.user, { entity: 'settings.observability', action: 'update', before, after: saved });
  res.json(saved);
});
