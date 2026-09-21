import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { healthIssues } from '@supops/db';
import { db, settingsStore } from '../context.ts';
import { healthOverview, investigateIssue, startScan } from '../services/health.ts';

export const healthRoutes = Router();

/** The cadences the UI offers. `0` (Off) is expressed as `enabled: false`. */
const ALLOWED_INTERVALS = [15, 30, 60, 180, 360, 720, 1440].map((m) => m * 60_000);

function requireProject(req: { query: Record<string, unknown> }): string | null {
  return typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
}

/** Everything the Health page renders in one round trip. */
healthRoutes.get('/overview', (req, res) => {
  const projectId = requireProject(req);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const { latest, issues } = healthOverview(projectId);
  res.json({ latest, issues, schedule: settingsStore.health() });
});

/** Nav badge: how many issues are still open. */
healthRoutes.get('/count', (req, res) => {
  const projectId = requireProject(req);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(healthIssues)
    .where(and(eq(healthIssues.projectId, projectId), eq(healthIssues.state, 'open')))
    .get();
  res.json({ open: row?.n ?? 0 });
});

const scanBody = z.object({
  projectId: z.string().min(1),
  type: z.enum(['quick', 'deep']),
  /** Scope the scan to one target; omit to sweep every top-level target. */
  targetId: z.string().optional(),
});

/** The manual "run now" button. Both Quick and Deep launch an agent run. */
healthRoutes.post('/scan', (req, res) => {
  const parsed = scanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'projectId and type are required' });
    return;
  }
  const { projectId, type, targetId } = parsed.data;
  const scope = targetId ? [targetId] : undefined;

  const result = startScan(projectId, type, 'manual', req.user?.id ?? null, scope);
  if (!result.ok) {
    res.status(result.code).json({ error: result.error });
    return;
  }
  res.status(201).json({ check: result.check, runId: result.runId });
});

healthRoutes.get('/schedule', (_req, res) => {
  res.json(settingsStore.health());
});

const scheduleBody = z.object({
  enabled: z.boolean(),
  intervalMs: z
    .number()
    .refine((v) => ALLOWED_INTERVALS.includes(v), 'Unsupported interval'),
  scanType: z.enum(['quick', 'deep']),
});

healthRoutes.put('/schedule', (req, res) => {
  const parsed = scheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid schedule' });
    return;
  }
  res.json(settingsStore.saveHealth(parsed.data));
});

healthRoutes.post('/issues/:id/investigate', (req, res) => {
  const result = investigateIssue(req.params.id, req.user?.id ?? null);
  if (!result.ok) {
    res.status(result.code).json({ error: result.error });
    return;
  }
  res.status(201).json({ runId: result.runId });
});

healthRoutes.post('/issues/:id/resolve', (req, res) => {
  const removed = db
    .update(healthIssues)
    .set({ state: 'resolved', resolvedAt: new Date() })
    .where(eq(healthIssues.id, req.params.id))
    .returning()
    .get();
  if (!removed) {
    res.status(404).json({ error: 'Issue not found' });
    return;
  }
  res.json({ ok: true });
});
