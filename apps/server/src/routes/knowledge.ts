import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { knowledgeDocs, runKnowledge, runs } from '@supops/db';
import { searchKnowledge } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';

/**
 * Project knowledge: runbooks, notes and facts the agent is given at the start of a
 * run. Anyone signed in may read and write drafts; only an admin's document -- or a
 * draft an admin approved -- ever reaches a run, because knowledge is a trusted
 * instruction channel into every future run.
 */
export const knowledgeRoutes = Router();

const scope = z
  .object({
    targetIds: z.array(z.string()).max(200).optional(),
    kinds: z.array(z.string()).max(20).optional(),
    envs: z.array(z.enum(['dev', 'staging', 'prod'])).optional(),
  })
  .default({});

const docBody = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens'),
  kind: z.enum(['runbook', 'note', 'fact']),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(32_000),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  scope,
  pinned: z.boolean().optional(),
});

knowledgeRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) {
    // Search covers approved documents (what a run would see).
    res.json(searchKnowledge(db, projectId, q, 50));
    return;
  }
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  res.json(
    db
      .select()
      .from(knowledgeDocs)
      .where(and(eq(knowledgeDocs.projectId, projectId), ...(status ? [eq(knowledgeDocs.status, status as 'draft')] : [])))
      .orderBy(desc(knowledgeDocs.updatedAt), desc(knowledgeDocs.createdAt))
      .all(),
  );
});

knowledgeRoutes.get('/drafts/count', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const n = db
    .select({ n: sql<number>`count(*)` })
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.status, 'draft')))
    .get()?.n ?? 0;
  res.json({ drafts: n });
});

knowledgeRoutes.get('/:id', (req, res) => {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, req.params.id)).get();
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const usedIn = db
    .select({ runId: runKnowledge.runId, via: runKnowledge.via, at: runKnowledge.createdAt, title: runs.title })
    .from(runKnowledge)
    .innerJoin(runs, eq(runKnowledge.runId, runs.id))
    .where(eq(runKnowledge.docId, doc.id))
    .orderBy(desc(runKnowledge.createdAt))
    .limit(20)
    .all();
  res.json({ ...doc, usedIn });
});

knowledgeRoutes.post('/', (req, res) => {
  const parsed = docBody.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid document' });
    return;
  }
  const taken = db.select({ id: knowledgeDocs.id }).from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, parsed.data.projectId), eq(knowledgeDocs.slug, parsed.data.slug))).get();
  if (taken) {
    res.status(409).json({ error: `A document with the slug "${parsed.data.slug}" already exists.` });
    return;
  }
  const admin = isAdmin(req.user);
  const row = db
    .insert(knowledgeDocs)
    .values({
      ...parsed.data,
      pinned: parsed.data.pinned ?? parsed.data.kind === 'fact',
      status: admin ? 'approved' : 'draft',
      createdBy: req.user?.id ?? null,
      ...(admin ? { approvedBy: req.user!.id, approvedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'knowledge', entityId: row.id, action: admin ? 'create' : 'draft', after: { slug: row.slug, kind: row.kind, title: row.title } });
  res.status(201).json(row);
});

knowledgeRoutes.patch('/:id', (req, res) => {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, req.params.id)).get();
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const admin = isAdmin(req.user);
  // Members may edit drafts; an approved document is only changed by an admin, so
  // an edit can never slip unreviewed text into what runs see.
  if (!admin && doc.status !== 'draft') {
    res.status(403).json({ error: 'Only owners and admins can edit an approved document. Save a copy as a draft instead.' });
    return;
  }
  const parsed = docBody.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid document' });
    return;
  }
  const row = db.update(knowledgeDocs).set({ ...parsed.data, updatedAt: new Date() }).where(eq(knowledgeDocs.id, doc.id)).returning().get();
  audit(req.user, { projectId: doc.projectId, entity: 'knowledge', entityId: doc.id, action: 'update', before: { title: doc.title, body: doc.body }, after: { title: row.title, body: row.body } });
  res.json(row);
});

function setStatus(status: 'approved' | 'draft' | 'archived', action: string) {
  return (req: import('express').Request<{ id: string }>, res: import('express').Response) => {
    if (!isAdmin(req.user)) {
      res.status(403).json({ error: 'Only owners and admins can approve or archive knowledge.' });
      return;
    }
    const row = db
      .update(knowledgeDocs)
      .set({ status, updatedAt: new Date(), ...(status === 'approved' ? { approvedBy: req.user!.id, approvedAt: new Date() } : {}) })
      .where(eq(knowledgeDocs.id, req.params.id))
      .returning()
      .get();
    if (!row) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    audit(req.user, { projectId: row.projectId, entity: 'knowledge', entityId: row.id, action });
    res.json(row);
  };
}
knowledgeRoutes.post('/:id/approve', setStatus('approved', 'approve'));
knowledgeRoutes.post('/:id/archive', setStatus('archived', 'archive'));
knowledgeRoutes.post('/:id/restore', setStatus('draft', 'restore'));

knowledgeRoutes.delete('/:id', (req, res) => {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, req.params.id)).get();
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!isAdmin(req.user) && !(doc.status === 'draft' && doc.createdBy === req.user?.id)) {
    res.status(403).json({ error: 'Only owners and admins can delete knowledge (you can delete your own drafts).' });
    return;
  }
  db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, doc.id)).run();
  audit(req.user, { projectId: doc.projectId, entity: 'knowledge', entityId: doc.id, action: 'delete', before: { slug: doc.slug, title: doc.title } });
  res.json({ ok: true });
});
