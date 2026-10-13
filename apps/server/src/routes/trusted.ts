import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { runs, toolCalls, trustedCommands, users } from '@supops/db';
import { buildTrustRule, describeTrustRule, rateSuggestedCommand, trustText } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';

/**
 * Trusted commands: an admin's standing approval for a command, per project. A trusted
 * command still shows its real risk tier; it only skips the wait for a person. Anyone
 * else can suggest one for an admin to approve. Untrusting keeps the rule, revoked,
 * so the record of who trusted what, and when, survives.
 */
export const trustedRoutes = Router();

const ENVS = ['dev', 'staging', 'prod'] as const;

type Row = typeof trustedCommands.$inferSelect;

function view(rows: Row[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.approvedBy, r.revokedBy]).filter((x): x is string => !!x))];
  const names = new Map(ids.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)).all().map((u) => [u.id, u.name]) : []);
  return rows.map((r) => ({
    ...r,
    description: describeTrustRule(r),
    createdByName: r.createdBy ? names.get(r.createdBy) ?? null : null,
    approvedByName: r.approvedBy ? names.get(r.approvedBy) ?? null : null,
    revokedByName: r.revokedBy ? names.get(r.revokedBy) ?? null : null,
  }));
}

trustedRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const rows = db.select().from(trustedCommands).where(eq(trustedCommands.projectId, projectId)).orderBy(desc(trustedCommands.createdAt)).all();
  // Revoked rules stay listed for 30 days, so an untrust done by mistake is easy to see and redo.
  const since = Date.now() - 30 * 86_400_000;
  res.json(view(rows.filter((r) => r.status !== 'revoked' || (r.revokedAt?.getTime() ?? 0) > since)));
});

const createBody = z.object({
  projectId: z.string().min(1),
  toolCallId: z.string().optional(),
  toolKey: z.enum(['ssh_exec', 'k8s_kubectl']).optional(),
  command: z.string().max(4000).optional(),
  matchKind: z.enum(['exact', 'folder']),
  folder: z.string().max(500).nullish(),
  glob: z.string().max(100).nullish(),
  envs: z.array(z.enum(ENVS)).min(1),
  note: z.string().max(500).nullish(),
});

trustedRoutes.post('/', (req, res) => {
  const body = createBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }
  const b = body.data;
  let toolKey = b.toolKey;
  let command = b.command;
  let tier: string | null = null;
  if (b.toolCallId) {
    const call = db
      .select({ toolKey: toolCalls.toolKey, argsJson: toolCalls.argsJson, tier: toolCalls.tier, projectId: runs.projectId })
      .from(toolCalls)
      .innerJoin(runs, eq(runs.id, toolCalls.runId))
      .where(eq(toolCalls.id, b.toolCallId))
      .get();
    if (!call || call.projectId !== b.projectId) {
      res.status(404).json({ error: 'That command was not found in this project.' });
      return;
    }
    toolKey = call.toolKey as typeof toolKey;
    command = trustText(call.toolKey, call.argsJson as Record<string, unknown>) ?? undefined;
    tier = call.tier;
  }
  if (!toolKey || !command) {
    res.status(400).json({ error: 'Give the command to trust, or the action it came from.' });
    return;
  }
  // Forbidden is checked twice: as the engine classified it here, and as it would be anywhere.
  const anywhere = rateSuggestedCommand(command).tier;
  const rule = buildTrustRule({ toolKey, command, matchKind: b.matchKind, folder: b.folder, glob: b.glob, envs: b.envs, tier: tier === 'forbidden' || anywhere === 'forbidden' ? 'forbidden' : tier ?? anywhere });
  if (!rule.ok) {
    res.status(422).json({ error: rule.error });
    return;
  }
  const r = rule.rule;
  const same = db
    .select()
    .from(trustedCommands)
    .where(and(eq(trustedCommands.projectId, b.projectId), eq(trustedCommands.toolKey, r.toolKey), eq(trustedCommands.canonical, r.canonical), eq(trustedCommands.matchKind, r.matchKind), inArray(trustedCommands.status, ['active', 'suggested'])))
    .all()
    .find((x) => (x.folder ?? null) === (r.folder ?? null) && (x.glob ?? null) === (r.glob ?? null));
  if (same) {
    res.status(409).json({ error: same.status === 'active' ? 'This is already trusted.' : 'This is already suggested and waiting for an admin.' });
    return;
  }
  const admin = isAdmin(req.user);
  const now = new Date();
  const row = db
    .insert(trustedCommands)
    .values({
      projectId: b.projectId,
      toolKey: r.toolKey,
      matchKind: r.matchKind,
      canonical: r.canonical,
      program: r.program ?? null,
      flags: r.flags ?? null,
      folder: r.folder ?? null,
      glob: r.glob ?? null,
      envs: r.envs,
      status: admin ? 'active' : 'suggested',
      note: b.note ?? null,
      sourceToolCallId: b.toolCallId ?? null,
      createdBy: req.user?.id ?? null,
      ...(admin ? { approvedBy: req.user?.id ?? null, approvedAt: now } : {}),
    })
    .returning()
    .get();
  audit(req.user, { projectId: b.projectId, entity: 'trusted-command', entityId: row.id, action: admin ? 'trust' : 'suggest-trust', after: { rule: describeTrustRule(r), envs: r.envs } });
  res.status(201).json(view([row])[0]);
});

const patchBody = z.object({
  action: z.enum(['approve', 'reject']).optional(),
  envs: z.array(z.enum(ENVS)).min(1).optional(),
  note: z.string().max(500).nullish(),
});

trustedRoutes.patch('/:id', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can change trusted commands.' });
    return;
  }
  const body = patchBody.safeParse(req.body);
  const row = db.select().from(trustedCommands).where(eq(trustedCommands.id, req.params.id)).get();
  if (!body.success || !row) {
    res.status(body.success ? 404 : 400).json({ error: body.success ? 'Not found' : 'Invalid request' });
    return;
  }
  const now = new Date();
  const set: Partial<typeof trustedCommands.$inferInsert> = {};
  if (body.data.action === 'approve' && row.status === 'suggested') Object.assign(set, { status: 'active', approvedBy: req.user?.id ?? null, approvedAt: now });
  if (body.data.action === 'reject' && row.status === 'suggested') Object.assign(set, { status: 'revoked', revokedBy: req.user?.id ?? null, revokedAt: now });
  if (body.data.envs) set.envs = body.data.envs;
  if (body.data.note !== undefined) set.note = body.data.note;
  const updated = db.update(trustedCommands).set(set).where(eq(trustedCommands.id, row.id)).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'trusted-command', entityId: row.id, action: body.data.action ?? 'update', before: { status: row.status, envs: row.envs }, after: { status: updated.status, envs: updated.envs } });
  res.json(view([updated])[0]);
});

/** Untrust: the next matching command waits for approval again. Kept, revoked, for the record. */
trustedRoutes.delete('/:id', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can untrust a command.' });
    return;
  }
  const row = db.select().from(trustedCommands).where(eq(trustedCommands.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const updated = db.update(trustedCommands).set({ status: 'revoked', revokedBy: req.user?.id ?? null, revokedAt: new Date() }).where(eq(trustedCommands.id, row.id)).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'trusted-command', entityId: row.id, action: 'untrust', before: { status: row.status } });
  res.json(view([updated])[0]);
});

/** Restore a rule untrusted by mistake (within the 30 days it stays listed). */
trustedRoutes.post('/:id/restore', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can restore a trusted command.' });
    return;
  }
  const row = db.select().from(trustedCommands).where(eq(trustedCommands.id, req.params.id)).get();
  if (!row || row.status !== 'revoked') {
    res.status(404).json({ error: 'Nothing to restore.' });
    return;
  }
  const updated = db.update(trustedCommands).set({ status: 'active', revokedBy: null, revokedAt: null, approvedBy: req.user?.id ?? null, approvedAt: new Date() }).where(eq(trustedCommands.id, row.id)).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'trusted-command', entityId: row.id, action: 'restore' });
  res.json(view([updated])[0]);
});
