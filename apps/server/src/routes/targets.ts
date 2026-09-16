import { Router } from 'express';
import type { Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  becomeSecrets,
  credentials,
  encryptSecret,
  fingerprintSecret,
  packEnvelope,
  targets,
  toolCalls,
} from '@supops/db';
import { diagnoseSecret, loadTarget, resolveSecret, sshExec } from '@supops/core';
import type { ResolvedTarget } from '@supops/core';
import { db } from '../context.ts';

export const targetRoutes = Router();

/**
 * Refuse a credential we can already tell will not work.
 *
 * The alternative is storing it, classifying it wrongly, and surfacing
 * "All configured authentication methods failed" twenty seconds into a run -- an
 * error that points at the server's permissions rather than at the paste.
 */
function rejectBadSecret(secret: string | undefined, res: Response): boolean {
  if (secret === undefined || secret === '') return false;
  const { problem } = diagnoseSecret(secret);
  if (!problem) return false;
  res.status(400).json({ error: problem });
  return true;
}


/**
 * Elevation passwords, keyed by the sudo/su account each is for. `user: ''` (or
 * omitted) is the wildcard/default. Sending the array replaces the whole set;
 * omitting it keeps what is stored.
 */
const becomePasswordsSchema = z
  .array(z.object({ user: z.string().max(64).default(''), password: z.string().min(1).max(4000) }))
  .max(20)
  .optional();

const becomeSchema = z
  .object({
    method: z.enum(['none', 'sudo', 'su', 'sudo-su']).default('none'),
    user: z.string().max(64).optional(),
    pty: z.boolean().optional(),
    template: z
      .string()
      .max(500)
      .refine((t) => t.includes('{{CMD}}'), 'Template must contain {{CMD}}')
      .optional(),
  })
  .optional();

const viaSchema = z
  .object({
    alias: z.string().min(1).max(200),
    pty: z.boolean().optional(),
    sshFlags: z.string().max(300).optional(),
  })
  .optional();

const sshConfig = z.object({
  kind: z.literal('ssh'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  sudo: z.boolean().default(false),
  become: becomeSchema,
  via: viaSchema,
  loginShell: z.boolean().optional(),
  prelude: z.string().max(500).optional(),
});

const createBody = z.object({
  projectId: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens'),
  name: z.string().min(1).max(100),
  env: z.enum(['dev', 'staging', 'prod']),
  sensitivity: z.number().int().min(0).max(3).default(1),
  description: z.string().max(300).optional(),
  tags: z.array(z.string()).default([]),
  config: sshConfig,
  /** Password or a PEM private key. Encrypted immediately; never stored in the clear. */
  secret: z.string().min(1).optional(),
  /** Elevation passwords keyed by sudo account. Stored as separate credentials. */
  becomePasswords: becomePasswordsSchema,
  protectedPaths: z.array(z.string()).optional(),
  writablePaths: z.array(z.string()).optional(),
  unitAllowlist: z.array(z.string()).optional(),
});

targetRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const includeArchived = req.query.includeArchived === '1';

  const filters = [
    ...(projectId ? [eq(targets.projectId, projectId)] : []),
    ...(includeArchived ? [] : [eq(targets.enabled, true)]),
  ];
  const rows = filters.length
    ? db.select().from(targets).where(and(...filters)).all()
    : db.select().from(targets).all();
  // Never leak which credential backs a target beyond "there is one".
  res.json(rows.map(publicTarget));
});

targetRoutes.post('/', (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid target' });
    return;
  }
  const { secret, becomePasswords, ...target } = parsed.data;
  if (rejectBadSecret(secret, res)) return;

  let credentialId: string | null = null;
  if (secret) {
    credentialId = insertCredential(target.projectId, `${target.slug} credential`,
      diagnoseSecret(secret).kind === 'private_key' ? 'ssh_key' : 'ssh_password', secret);
  }

  const row = db
    .insert(targets)
    .values({
      ...target,
      // The discriminant lives in `config`; the column mirrors it so tool binding can
      // filter targets without deserialising every config blob.
      kind: target.config.kind,
      credentialId,
      createdAt: new Date(),
    })
    .returning()
    .get();
  if (becomePasswords) setBecomeSecrets(row.id, row.projectId, row.slug, becomePasswords);
  res.status(201).json(publicTarget(row));
});

/**
 * Replace a target's elevation passwords wholesale. Old entries (and their
 * credential rows) are removed, so this both adds and clears -- an empty array
 * means "no stored elevation passwords".
 */
function setBecomeSecrets(
  targetId: string,
  projectId: string,
  slug: string,
  entries: Array<{ user: string; password: string }>,
): void {
  const old = db.select().from(becomeSecrets).where(eq(becomeSecrets.targetId, targetId)).all();
  db.delete(becomeSecrets).where(eq(becomeSecrets.targetId, targetId)).run();
  for (const o of old) db.delete(credentials).where(eq(credentials.id, o.credentialId)).run();
  // De-dupe by user so the unique (target, user) index cannot be violated; last wins.
  const byUser = new Map<string, string>();
  for (const e of entries) byUser.set(e.user ?? '', e.password);
  for (const [user, password] of byUser) {
    const credId = insertCredential(projectId, `${slug} elevation${user ? ` (${user})` : ''}`, 'sudo_password', password);
    db.insert(becomeSecrets).values({ targetId, sudoUser: user, credentialId: credId }).run();
  }
}

/** The sudo accounts a target has elevation passwords for ('' shown as 'default'). */
function becomeUsersFor(targetId: string): string[] {
  return db
    .select({ user: becomeSecrets.sudoUser })
    .from(becomeSecrets)
    .where(eq(becomeSecrets.targetId, targetId))
    .all()
    .map((r) => r.user);
}

/** Insert an encrypted credential and return its id. */
function insertCredential(projectId: string, name: string, type: 'ssh_key' | 'ssh_password' | 'sudo_password', secret: string): string {
  const cred = db
    .insert(credentials)
    .values({
      projectId,
      name,
      type,
      secretEnc: packEnvelope(encryptSecret(secret)),
      fingerprint: fingerprintSecret(secret),
      createdAt: new Date(),
    })
    .returning()
    .get();
  return cred.id;
}

/** Strip credential ids from a target row; expose only whether each exists. */
function publicTarget(row: typeof targets.$inferSelect) {
  const { credentialId, ...rest } = row;
  return { ...rest, hasCredential: !!credentialId, becomeUsers: becomeUsersFor(row.id) };
}

/** Host aliases from an ssh_config body, minus wildcard patterns like `Host *`. */
function parseSshConfigAliases(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split('\n')) {
    const m = raw.match(/^\s*Host\s+(.+?)\s*$/i);
    if (!m) continue;
    for (const alias of m[1]!.split(/\s+/)) {
      if (alias && !alias.includes('*') && !alias.includes('?') && !alias.startsWith('!')) out.add(alias);
    }
  }
  return [...out];
}

/** Turn a jump alias into a valid target slug. */
function slugify(alias: string): string {
  return alias.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'vm';
}

/** Build a throwaway ResolvedTarget just to run a read-only command over SSH. */
function transientJump(host: string, port: number, user: string, secret: string | null): ResolvedTarget {
  return {
    id: 'discover', slug: 'discover', kind: 'ssh', env: 'dev', sensitivity: 0, description: null,
    config: { kind: 'ssh', host, port, user, sudo: false },
    credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null,
    ...(secret ? { secret } : {}),
  } as ResolvedTarget;
}

const discoverBody = z.object({
  /** Reuse an existing target's jump connection + stored credential... */
  fromTargetId: z.string().optional(),
  /** ...or give the jump connection inline. */
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().optional(),
  secret: z.string().optional(),
  /** Where the ssh config lives; defaults to ~/.ssh/config (expands to the login user). */
  configPath: z.string().max(500).optional(),
});

/**
 * Only these characters are allowed in an ssh-config path before it goes into a
 * `cat` on the jump: word chars, `/._-~`, `*` (globs like config.d/*) and spaces
 * (multiple paths). Everything a shell could use to inject another command is
 * excluded, so the read stays a read.
 */
const SAFE_CONFIG_PATH = /^[\w./~*\- ]+$/;

/** Read the jump's ssh config (following one level of `Include`) for Host aliases. */
targetRoutes.post('/discover', async (req, res) => {
  const parsed = discoverBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid discovery request' });
    return;
  }
  const d = parsed.data;

  let jump: ResolvedTarget;
  if (d.fromTargetId) {
    const t = loadTarget(db, d.fromTargetId);
    if (!t || t.config.kind !== 'ssh') {
      res.status(404).json({ error: 'Jump target not found' });
      return;
    }
    const secret = resolveSecret(db, t);
    jump = secret ? { ...t, secret: secret.value } : t;
  } else {
    if (!d.host || !d.user) {
      res.status(400).json({ error: 'Provide fromTargetId, or host + user (+ credential).' });
      return;
    }
    jump = transientJump(d.host, d.port ?? 22, d.user, d.secret ?? null);
  }

  const configPath =
    d.configPath && SAFE_CONFIG_PATH.test(d.configPath) ? d.configPath : '~/.ssh/config';
  const cat = (paths: string) =>
    sshExec(`cat ${paths} 2>/dev/null`, {
      runId: 'discover', toolCallId: 'discover', target: jump,
      timeoutMs: 15_000, maxOutputBytes: 131_072, signal: AbortSignal.timeout(20_000),
    });

  const out = await cat(configPath);
  if (!out.ok) {
    res.status(400).json({
      error: `Could not read the ssh config at ${configPath} on the jump: ${out.text}`,
    });
    return;
  }
  let text = out.text;

  // Follow `Include` directives recursively -- many setups split hosts across
  // config.d/* files, sometimes nested. Relative includes resolve against ~/.ssh,
  // matching ssh's own behaviour. Bounded depth so a cyclic include can't loop.
  const includesIn = (s: string): string[] =>
    [...s.matchAll(/^\s*Include\s+(.+?)\s*$/gim)]
      .flatMap((m) => m[1]!.trim().split(/\s+/))
      .filter((p) => SAFE_CONFIG_PATH.test(p))
      .map((p) => (p.startsWith('/') || p.startsWith('~') ? p : `~/.ssh/${p}`));

  const seen = new Set<string>();
  let frontier = includesIn(text);
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const fresh = frontier.filter((p) => !seen.has(p));
    fresh.forEach((p) => seen.add(p));
    if (!fresh.length) break;
    const inc = await cat(fresh.join(' '));
    if (!inc.ok) break;
    text += `\n${inc.text}`;
    frontier = includesIn(inc.text);
  }

  const aliases = parseSshConfigAliases(text);
  // `raw` lets the UI show what was actually read, so a mismatch (e.g. hosts only in
  // an unreadable include) is diagnosable instead of a silent undercount.
  res.json({ aliases, configPath, hostCount: aliases.length, raw: text.slice(0, 20_000) });
});

const bulkBody = z.object({
  projectId: z.string().min(1),
  /** The jump connection: an existing target to clone, or inline host/user/secret. */
  fromTargetId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().optional(),
  secret: z.string().optional(),
  env: z.enum(['dev', 'staging', 'prod']),
  sensitivity: z.number().int().min(0).max(3).default(1),
  aliases: z.array(z.string().min(1)).min(1).max(100),
  slugPrefix: z.string().max(40).optional(),
  become: becomeSchema,
  becomePasswords: becomePasswordsSchema,
});

/** Create one target per alias, all sharing the jump connection + elevation. */
targetRoutes.post('/bulk', (req, res) => {
  const parsed = bulkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk request' });
    return;
  }
  const b = parsed.data;

  // Resolve the jump host/user and the secret to store on each created target.
  let host = b.host, user = b.user, port = b.port;
  let secret = b.secret ?? null;
  if (b.fromTargetId) {
    const t = loadTarget(db, b.fromTargetId);
    if (!t || t.config.kind !== 'ssh') {
      res.status(404).json({ error: 'Jump target not found' });
      return;
    }
    host = t.config.host; user = t.config.user; port = t.config.port;
    if (secret === null) secret = resolveSecret(db, t)?.value ?? null;
  }
  if (!host || !user) {
    res.status(400).json({ error: 'Provide fromTargetId, or host + user for the jump.' });
    return;
  }

  const bySlug = new Map(
    db.select().from(targets).where(eq(targets.projectId, b.projectId)).all().map((r) => [r.slug, r]),
  );
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const skipped: string[] = [];

  for (const alias of b.aliases) {
    const slug = slugify(b.slugPrefix ? `${b.slugPrefix}-${alias}` : alias);
    const config = {
      kind: 'ssh' as const, host, port, user, sudo: false,
      ...(b.become ? { become: b.become } : {}),
      via: { alias },
    };
    const cred = () =>
      secret
        ? insertCredential(b.projectId, `${slug} credential`,
            diagnoseSecret(secret).kind === 'private_key' ? 'ssh_key' : 'ssh_password', secret)
        : null;

    const prior = bySlug.get(slug);
    if (prior) {
      // Only refresh a machine we ourselves put behind a jump. A hand-made target
      // (or one reached directly) that happens to share the slug is left untouched.
      const pc = prior.config as { via?: { alias?: string } };
      if (!pc.via?.alias) { skipped.push(alias); continue; }
      const row = db.update(targets).set({
        name: alias, env: b.env, sensitivity: b.sensitivity,
        description: `Behind ${host} (ssh ${alias})`,
        config,
        // Revive it if a prior delete archived it (enabled=false) -- otherwise the
        // stale row keeps the slug and the machine never reappears.
        enabled: true,
        ...(secret ? { credentialId: cred() } : {}),
      }).where(eq(targets.id, prior.id)).returning().get();
      if (b.becomePasswords) setBecomeSecrets(row.id, b.projectId, slug, b.becomePasswords);
      updated.push(publicTarget(row));
      continue;
    }

    const row = db.insert(targets).values({
      projectId: b.projectId, slug, name: alias, kind: 'ssh',
      env: b.env, sensitivity: b.sensitivity,
      description: `Behind ${host} (ssh ${alias})`,
      config, credentialId: cred(), createdAt: new Date(),
    }).returning().get();
    if (b.becomePasswords) setBecomeSecrets(row.id, b.projectId, slug, b.becomePasswords);
    created.push(publicTarget(row));
  }

  res.status(201).json({ created, updated, skipped });
});

/**
 * Connectivity check. Runs `echo` -- read-only by construction, so this endpoint
 * can never become a way to run an arbitrary command outside the risk engine.
 */
targetRoutes.post('/:id/test', async (req, res) => {
  const target = loadTarget(db, req.params.id);
  if (!target) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  const secret = resolveSecret(db, target);
  const out = await sshExec('echo supops-ok', {
    runId: 'connectivity-test',
    toolCallId: 'connectivity-test',
    target: secret ? { ...target, secret: secret.value } : target,
    timeoutMs: 15_000,
    maxOutputBytes: 2048,
    signal: AbortSignal.timeout(20_000),
  });

  const reachable = out.ok && out.text.includes('supops-ok');
  db.update(targets)
    .set({ healthState: reachable ? 'ok' : 'unreachable', lastCheckedAt: new Date() })
    .where(eq(targets.id, target.id))
    .run();

  res.json({ ok: reachable, detail: out.text });
});

const patchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  env: z.enum(['dev', 'staging', 'prod']).optional(),
  sensitivity: z.number().int().min(0).max(3).optional(),
  description: z.string().max(300).optional(),
  config: sshConfig.optional(),
  /** Omit to keep the existing credential; send "" to remove it. */
  secret: z.string().max(8000).optional(),
  /** Elevation passwords keyed by sudo account; omit to keep, [] to clear all. */
  becomePasswords: becomePasswordsSchema,
  enabled: z.boolean().optional(),
});

targetRoutes.patch('/:id', (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid target' });
    return;
  }

  const existing = db.select().from(targets).where(eq(targets.id, req.params.id)).get();
  if (!existing) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  const { secret, becomePasswords, ...fields } = parsed.data;
  if (rejectBadSecret(secret, res)) return;

  // Omit = keep, "" = remove, value = replace.
  let credentialId = existing.credentialId;
  if (secret !== undefined) {
    credentialId = secret === ''
      ? null
      : insertCredential(existing.projectId, `${existing.slug} credential`,
          diagnoseSecret(secret).kind === 'private_key' ? 'ssh_key' : 'ssh_password', secret);
  }

  const row = db
    .update(targets)
    .set({
      ...fields,
      ...(fields.config ? { kind: fields.config.kind } : {}),
      credentialId,
      // Any change to where or how we connect invalidates the last health result.
      ...(fields.config || secret !== undefined
        ? { healthState: 'unknown' as const, lastCheckedAt: null }
        : {}),
    })
    .where(eq(targets.id, existing.id))
    .returning()
    .get();

  // Omitting becomePasswords keeps the stored set; sending it (even []) replaces it.
  if (becomePasswords !== undefined) setBecomeSecrets(row.id, row.projectId, row.slug, becomePasswords);

  res.json(publicTarget(row));
});

/**
 * Remove a target.
 *
 * If an agent has ever acted on it, the row is archived rather than deleted: the
 * audit trail has to keep resolving which machine a command ran against, and a
 * dangling reference would quietly turn a historical record into a mystery. A target
 * that was never used -- a typo, or a test fixture -- is deleted outright.
 */
targetRoutes.delete('/:id', (req, res) => {
  const existing = db.select().from(targets).where(eq(targets.id, req.params.id)).get();
  if (!existing) {
    res.status(404).json({ error: 'Target not found' });
    return;
  }

  const used = db
    .select({ n: sql<number>`count(*)` })
    .from(toolCalls)
    .where(eq(toolCalls.targetId, existing.id))
    .get();

  if ((used?.n ?? 0) > 0) {
    db.update(targets).set({ enabled: false }).where(eq(targets.id, existing.id)).run();
    res.json({ ok: true, archived: true, reason: `kept for the audit trail of ${used?.n} past action(s)` });
    return;
  }

  db.delete(targets).where(eq(targets.id, existing.id)).run();
  if (existing.credentialId) {
    db.delete(credentials).where(eq(credentials.id, existing.credentialId)).run();
  }
  res.json({ ok: true, archived: false });
});
