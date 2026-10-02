import { Router } from 'express';
import { desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { alerts, healthChecks, runs, toolCalls, users } from '@supops/db';
import { db } from '../context.ts';
import { config } from '../config.ts';
import { ADMIN_ROLES, emailDomainAllowed, hashPassword, requireRole } from '../auth.ts';

/**
 * Account management, admin only.
 *
 * The whole router is gated by `requireRole('owner','admin')`; `requireAuth` already
 * ran globally in routes/index.ts. Users are disabled rather than deleted so their
 * approval/attribution history (`decidedBy`, `startedBy`) never dangles.
 */
export const userRoutes = Router();
userRoutes.use(requireRole('owner', 'admin'));

const GLOBAL_ROLES = ['owner', 'admin', 'member'] as const;

const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  globalRole: u.globalRole,
  disabledAt: u.disabledAt ? u.disabledAt.getTime() : null,
  createdAt: u.createdAt.getTime(),
});

userRoutes.get('/', (_req, res) => {
  const rows = db.select().from(users).orderBy(desc(users.createdAt)).all();
  res.json(rows.map(publicUser));
});

const createBody = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(100),
  globalRole: z.enum(GLOBAL_ROLES).default('member'),
  password: z.string().min(6).max(200),
});

userRoutes.post('/', (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid user' });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  if (!emailDomainAllowed(email)) {
    res.status(400).json({
      error: `Accounts must use an email @${config.authAllowedDomains.join(' or @')}.`,
    });
    return;
  }
  if (db.select().from(users).where(eq(users.email, email)).get()) {
    res.status(409).json({ error: 'A user with that email already exists.' });
    return;
  }
  const row = db
    .insert(users)
    .values({
      email,
      name: parsed.data.name,
      globalRole: parsed.data.globalRole,
      passwordHash: hashPassword(parsed.data.password),
      createdAt: new Date(),
    })
    .returning()
    .get();
  res.status(201).json(publicUser(row));
});

const patchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  globalRole: z.enum(GLOBAL_ROLES).optional(),
  /** true disables (blocks login), false re-enables. */
  disabled: z.boolean().optional(),
  /** New password; omit to leave unchanged. */
  password: z.string().min(6).max(200).optional(),
});

userRoutes.patch('/:id', (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid change' });
    return;
  }
  const target = db.select().from(users).where(eq(users.id, req.params.id)).get();
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Never let the last active owner/admin be demoted or disabled -- that would lock
  // everyone out of account management.
  const demoting = parsed.data.globalRole && !ADMIN_ROLES.includes(parsed.data.globalRole);
  const disabling = parsed.data.disabled === true;
  if (ADMIN_ROLES.includes(target.globalRole) && (demoting || disabling)) {
    const otherActiveAdmins = db
      .select()
      .from(users)
      .where(ne(users.id, target.id))
      .all()
      .filter((u) => ADMIN_ROLES.includes(u.globalRole) && !u.disabledAt);
    if (otherActiveAdmins.length === 0) {
      res.status(409).json({ error: 'This is the last active admin; promote another user first.' });
      return;
    }
  }

  const set: Partial<typeof users.$inferInsert> = {};
  if (parsed.data.name !== undefined) set.name = parsed.data.name;
  if (parsed.data.globalRole !== undefined) set.globalRole = parsed.data.globalRole;
  if (parsed.data.disabled !== undefined) set.disabledAt = parsed.data.disabled ? new Date() : null;
  if (parsed.data.password !== undefined) set.passwordHash = hashPassword(parsed.data.password);

  const row = db.update(users).set(set).where(eq(users.id, target.id)).returning().get();
  res.json(publicUser(row));
});

/**
 * Permanently delete a user. Prefer disabling (keeps attribution), but a hard delete
 * is offered for admins/owners. Their past runs/approvals stay in the record with the
 * attribution nulled out (shown as unknown) rather than dangling on a missing FK.
 */
userRoutes.delete('/:id', (req, res) => {
  const target = db.select().from(users).where(eq(users.id, req.params.id)).get();
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (req.user?.id === target.id) {
    res.status(400).json({ error: 'You cannot delete your own account.' });
    return;
  }
  if (ADMIN_ROLES.includes(target.globalRole)) {
    const otherActiveAdmins = db
      .select()
      .from(users)
      .where(ne(users.id, target.id))
      .all()
      .filter((u) => ADMIN_ROLES.includes(u.globalRole) && !u.disabledAt);
    if (otherActiveAdmins.length === 0) {
      res.status(409).json({ error: 'This is the last active admin; promote another user first.' });
      return;
    }
  }

  // Null the attribution FKs first (all are `no action`), then remove the user.
  db.transaction((tx) => {
    tx.update(runs).set({ startedBy: null }).where(eq(runs.startedBy, target.id)).run();
    tx.update(toolCalls).set({ decidedBy: null }).where(eq(toolCalls.decidedBy, target.id)).run();
    tx.update(alerts).set({ decidedBy: null }).where(eq(alerts.decidedBy, target.id)).run();
    tx.update(healthChecks).set({ startedBy: null }).where(eq(healthChecks.startedBy, target.id)).run();
    tx.delete(users).where(eq(users.id, target.id)).run();
  });
  res.json({ ok: true });
});
