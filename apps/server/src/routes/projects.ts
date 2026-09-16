import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_RISK_POLICY,
  DEFAULT_RUN_BUDGET,
  agents,
  credentials,
  projects,
  runs,
  targets,
} from '@supops/db';
import { BUILTIN_TOOL_KEYS, CONSOLE_TOOL_KEYS } from '@supops/core';
import { db } from '../context.ts';

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

  // A project with no agent cannot run anything, so ship one. Targets and
  // credentials stay empty -- those are the parts only the operator can supply.
  db.insert(agents)
    .values({
      projectId: row.id,
      slug: 'triage',
      name: 'Triage Agent',
      role: 'triage',
      systemPrompt:
        'You are triaging an incident. Work the problem from evidence: check service ' +
        'status, recent logs, resource pressure and recent changes before forming a ' +
        'hypothesis. State your conclusion with record_finding before proposing any ' +
        'change. Prefer the smallest reversible action that addresses the cause.',
      toolKeys: BUILTIN_TOOL_KEYS,
      budget: DEFAULT_RUN_BUDGET,
      createdAt: new Date(),
    })
    .run();

    db.insert(agents)
      .values({
        projectId: row.id,
        slug: 'console',
        name: 'Console Assistant',
        role: 'assistant',
        systemPrompt:
          'You are an operations assistant working alongside an engineer. Unlike an incident '
        + 'triage run, most of what you are asked is ordinary work: check something, make '
        + 'something, or explain something.\n\n'
        + 'If a question can be answered without touching a machine, just answer it -- do '
        + 'not invent a command to look busy. If it needs a machine, run the narrowest '
        + 'command that answers it and say what you found in plain language.\n\n'
        + 'Keep replies short. The engineer can see every command and its output beside '
        + 'this conversation, so do not repeat output back at them -- interpret it. Ask a '
        + 'clarifying question when the request is ambiguous rather than guessing at '
        + 'something destructive.',
        toolKeys: CONSOLE_TOOL_KEYS,
        budget: DEFAULT_RUN_BUDGET,
        createdAt: new Date(),
      })
      .run();

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

/** The kill switch. Deliberately a single boolean with no ceremony around it. */
projectRoutes.post('/:id/kill-switch', (req, res) => {
  const active = !!req.body?.active;
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
 */
projectRoutes.delete('/:id', (req, res) => {
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
