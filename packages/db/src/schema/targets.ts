import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { Env, TargetKind } from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import { projects } from './identity.ts';
import type { CredentialType, TargetConfig } from './types.ts';

/**
 * Secrets live here and ONLY here, as an AES-256-GCM envelope. Plaintext exists
 * solely inside an executor's call frame -- it is never logged, never returned by
 * an API route, and never reaches the model (see the redaction pass in core).
 */
export const credentials = sqliteTable('credentials', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').$type<CredentialType>().notNull(),
  /** JSON envelope: { v, alg, iv, tag, ct }. Opaque outside packages/db/crypto. */
  secretEnc: text('secret_enc').notNull(),
  /** sha256 of the plaintext. Used to detect rotation and to drive output redaction. */
  fingerprint: text('fingerprint').notNull(),
  lastUsedAt: ts('last_used_at'),
  createdAt: createdAt(),
});

export const targets = sqliteTable(
  'targets',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * The model-visible identifier. Tool schemas expose an enum of these, so a
     * target outside this project is literally unrepresentable in a tool call.
     */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<TargetKind>().notNull(),
    env: text('env').$type<Env>().notNull(),
    /** 0-3. Feeds the stage-3 risk bump; prod + high sensitivity raises tiers. */
    sensitivity: integer('sensitivity').notNull().default(1),
    /** Shown to the model in the tool schema. Worth writing well -- it drives target choice. */
    description: text('description'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    config: text('config', { mode: 'json' }).$type<TargetConfig>().notNull(),
    credentialId: text('credential_id').references(() => credentials.id),
    /**
     * Deprecated. Elevation passwords now live in `becomeSecrets`, keyed by account.
     * Kept only so dropping it doesn't force a destructive table rebuild (SQLite
     * cannot DROP a column referenced by FKs inside a migration transaction). Unused.
     */
    becomeCredentialId: text('become_credential_id').references(() => credentials.id),
    /** Writes or deletes touching these are forced to at least `high`. */
    protectedPaths: text('protected_paths', { mode: 'json' }).$type<string[]>(),
    /** chmod/chown/cp inside these may stay at `low`. */
    writablePaths: text('writable_paths', { mode: 'json' }).$type<string[]>(),
    /** systemctl reload/restart is only low/medium for units named here. */
    unitAllowlist: text('unit_allowlist', { mode: 'json' }).$type<string[]>(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    healthState: text('health_state', {
      enum: ['unknown', 'ok', 'degraded', 'unreachable'],
    })
      .notNull()
      .default('unknown'),
    lastCheckedAt: ts('last_checked_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('targets_project_slug').on(t.projectId, t.slug)],
);

/**
 * Elevation passwords, keyed by the sudo/su account each is for.
 *
 * A target sometimes needs a different password depending on which account sudo
 * ends up prompting for (`[sudo] password for X`) -- and which one is impossible to
 * predict ahead of time. So we store one row per account here and let the executor
 * read the prompt (`sudo -p '%p'`) and pick the matching password at runtime.
 *
 * `sudoUser = ''` is the wildcard/default: used when the prompt names an account we
 * have no exact entry for, and the whole answer for the common single-password case.
 */
export const becomeSecrets = sqliteTable(
  'become_secrets',
  {
    id: id(),
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    sudoUser: text('sudo_user').notNull().default(''),
    credentialId: text('credential_id')
      .notNull()
      .references(() => credentials.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('become_secrets_target_user').on(t.targetId, t.sudoUser)],
);
