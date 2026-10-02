import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_RISK_POLICY,
  auditLog,
  agents,
  credentials,
  projects,
  runs,
  targets,
} from '@supops/db';
import { db } from '../context.ts';
import { isAdmin } from '../auth.ts';
import { ensureBuiltinAgents } from '../services/builtin-agents.ts';
import { audit } from '../services/audit.ts';
import { validateProjectPolicy } from '@supops/core';
import { RISK_TIERS } from '@supops/shared';
import type { RiskPolicy } from '@supops/db';

export const projectRoutes = Router();

projectRoutes.get('/', (_req, res) => {
  res.json(db.select().from(projects).orderBy(desc(projects.createdAt)).all());
});

const createBody = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and hyphens'),
  description: z.string().max(500).optional(),
  systemPromptExtra: z.string().max(5000).optional(),
});

projectRoutes.post('/', (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid project' });
    return;
  }
  // Project instructions go into every run's system prompt -- a trusted channel.
  if (parsed.data.systemPromptExtra && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can set project instructions.' });
    return;
  }
  // A friendly message beats leaking "UNIQUE constraint failed: projects.slug".
  const clash = db.select().from(projects).where(eq(projects.slug, parsed.data.slug)).get();
  if (clash) {
    res.status(409).json({ error: `A project with the slug "${parsed.data.slug}" already exists.` });
    return;
  }

  const row = db
    .insert(projects)
    .values({ ...parsed.data, riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() })
    .returning()
    .get();

  // A project with no agent cannot run anything, so ship the built-ins. Targets and
  // credentials stay empty -- those are the parts only the operator can supply.
  ensureBuiltinAgents(row.id);

  res.status(201).json(row);
});

projectRoutes.get('/:id', (req, res) => {
  const row = db.select().from(projects).where(eq(projects.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(row);
});

const tierEnum = z.enum(RISK_TIERS);
const policyBody = z.object({
  autoExecuteMaxTier: tierEnum,
  autoExecuteCeiling: tierEnum.optional(),
  prodAutoExecuteCap: tierEnum.optional(),
  toolAutoExecuteCap: z.record(z.string(), tierEnum).optional(),
  triggerAutoExecuteCap: z.record(z.string(), tierEnum).optional(),
  approverRoleByTier: z.record(z.string(), z.enum(['owner', 'admin', 'operator', 'approver', 'viewer'])).optional(),
  requireSecondPersonAtTier: tierEnum.nullable().optional(),
  ttlMsByTier: z.record(z.string(), z.number().int().min(60_000).max(7 * 24 * 60 * 60_000)).optional(),
  onExpiry: z.enum(['continue_as_denied', 'abort_run']).optional(),
});

/**
 * Change how much this project's agents may do on their own. Admin-only, audited,
 * and validated: nothing above medium ever auto-runs, so a typo cannot hand an
 * agent unattended high-risk actions. Runs already in flight keep the policy they
 * started with.
 */
projectRoutes.patch('/:id/policy', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can change autonomy.' });
    return;
  }
  const project = db.select().from(projects).where(eq(projects.id, req.params.id)).get();
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const parsed = policyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid policy' });
    return;
  }
  const next = { ...project.riskPolicy, ...parsed.data } as RiskPolicy;
  const problem = validateProjectPolicy(next);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  const row = db.update(projects).set({ riskPolicy: next }).where(eq(projects.id, project.id)).returning().get();
  audit(req.user, { projectId: project.id, entity: 'project.policy', entityId: project.id, action: 'update', before: project.riskPolicy, after: next });
  res.json(row);
});

const settingsBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  /** Instructions added to every run's system prompt -- a trusted channel. */
  systemPromptExtra: z.string().max(5000).nullable().optional(),
});

projectRoutes.patch('/:id', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can change project settings.' });
    return;
  }
  const project = db.select().from(projects).where(eq(projects.id, req.params.id)).get();
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const parsed = settingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' });
    return;
  }
  const row = db.update(projects).set(parsed.data).where(eq(projects.id, project.id)).returning().get();
  audit(req.user, {
    projectId: project.id, entity: 'project.settings', entityId: project.id, action: 'update',
    before: { name: project.name, description: project.description, systemPromptExtra: project.systemPromptExtra },
    after: parsed.data,
  });
  res.json(row);
});

/** Change history for a project (policy, agents, settings). Admin-only. */
projectRoutes.get('/:id/audit', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can view the change history.' });
    return;
  }
  const entity = typeof req.query.entity === 'string' ? req.query.entity : null;
  const rows = db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.projectId, req.params.id), ...(entity ? [eq(auditLog.entity, entity)] : [])))
    .orderBy(desc(auditLog.at))
    .limit(100)
    .all();
  res.json(rows);
});

/**
 * The kill switch. Deliberately a single boolean with no ceremony around it -- and
 * asymmetric: anyone can stop the agents (stopping is always safe), but only an
 * owner or admin can let them run again.
 */
projectRoutes.post('/:id/kill-switch', (req, res) => {
  const active = !!req.body?.active;
  if (!active && !isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can resume agents after the kill switch.' });
    return;
  }
  const row = db
    .update(projects)
    .set({ killSwitch: active })
    .where(eq(projects.id, req.params.id))
    .returning()
    .get();
  if (!row) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  audit(req.user, { projectId: row.id, entity: 'project.killSwitch', entityId: row.id, action: active ? 'halt' : 'resume' });
  res.json(row);
});

const ACTIVE = ['queued', 'running', 'awaiting_approval', 'suspended'] as const;


/** What deleting this project would destroy. Shown before anything is removed. */
projectRoutes.get('/:id/impact', (req, res) => {
  const project = db.select().from(projects).where(eq(projects.id, req.params.id)).get();
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const n = (rows: { n: number } | undefined) => rows?.n ?? 0;
  const targetCount = n(
    db.select({ n: sql<number>`count(*)` }).from(targets).where(eq(targets.projectId, project.id)).get(),
  );
  const agentCount = n(
    db.select({ n: sql<number>`count(*)` }).from(agents).where(eq(agents.projectId, project.id)).get(),
  );
  const runCount = n(
    db.select({ n: sql<number>`count(*)` }).from(runs).where(eq(runs.projectId, project.id)).get(),
  );
  const credentialCount = n(
    db.select({ n: sql<number>`count(*)` }).from(credentials).where(eq(credentials.projectId, project.id)).get(),
  );
  const activeRuns = n(
    db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.projectId, project.id), inArray(runs.status, [...ACTIVE])))
      .get(),
  );
  const total = n(db.select({ n: sql<number>`count(*)` }).from(projects).get());

  res.json({
    slug: project.slug,
    targets: targetCount,
    agents: agentCount,
    runs: runCount,
    credentials: credentialCount,
    activeRuns,
    isLastProject: total <= 1,
  });
});

/**
 * Delete a project and everything inside it.
 *
 * This is the most destructive action in the product: targets, credentials, agents
 * and the entire run history cascade away, and the run history is the audit record
 * of what an agent did to real machines. Hence the confirmation slug, the refusal
 * while work is in flight, and the refusal to leave the install with no project at all.
 * Owners and admins only: it would otherwise let a member erase run history wholesale.
 */
projectRoutes.delete('/:id', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can delete projects.' });
    return;
  }
  const project = db.select().from(projects).where(eq(projects.id, req.params.id)).get();
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const total = db.select({ n: sql<number>`count(*)` }).from(projects).get()?.n ?? 0;
  if (total <= 1) {
    res.status(409).json({ error: 'This is the only project. Create another before deleting it.' });
    return;
  }

  if (req.body?.confirm !== project.slug) {
    res.status(400).json({ error: `Type the project slug "${project.slug}" to confirm.` });
    return;
  }

  const active = db
    .select({ n: sql<number>`count(*)` })
    .from(runs)
    .where(and(eq(runs.projectId, project.id), inArray(runs.status, [...ACTIVE])))
    .get()?.n ?? 0;
  if (active > 0) {
    res.status(409).json({
      error: `${active} run(s) are still working or awaiting approval. Cancel them before deleting the project.`,
    });
    return;
  }

  // targets, credentials, agents, runs (and their steps/calls/events) all cascade.
  db.delete(projects).where(eq(projects.id, project.id)).run();
  res.json({ ok: true, slug: project.slug });
});
